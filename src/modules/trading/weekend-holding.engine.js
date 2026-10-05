'use strict';

const mongoose = require('mongoose');
const { TradingAccount } = require('../accounts/trading-account.model');
const { Instrument } = require('../instruments/instrument.model');
const { Position } = require('./position.model');
const { Order } = require('./order.model');

class WeekendHoldingEngine {
  constructor({
    policyService,
    marketOrderService,
    pendingOrderService,
    actionService,
    accountModel = TradingAccount,
    instrumentModel = Instrument,
    positionModel = Position,
    orderModel = Order,
    intervalMs = 60_000,
    enforcementEnabled = false,
    logger = null,
    now = () => new Date(),
  } = {}) {
    this.policyService = policyService;
    this.marketOrderService = marketOrderService;
    this.pendingOrderService = pendingOrderService;
    this.actionService = actionService;
    this.accountModel = accountModel;
    this.instrumentModel = instrumentModel;
    this.positionModel = positionModel;
    this.orderModel = orderModel;
    this.intervalMs = intervalMs;
    this.enforcementEnabled = enforcementEnabled;
    this.logger = logger;
    this.now = now;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.scanOnce().catch(error => this.logger?.error?.({ err: error?.message }, 'Weekend holding scan failed'));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async scanOnce() {
    if (this.running) return;
    this.running = true;
    try {
      let cursor = null;
      while (true) {
      const accounts = await this.accountModel.find({
        status: 'ACTIVE',
        tradingEnabled: true,
        'tradingPermissions.weekendHolding': false,
        ...(cursor ? { _id: mongoose.trusted({ $gt: cursor }) } : {}),
      }).select('_id tenantId tradingPermissions tradingPermissionsVersion executionRestrictions').sort({ _id: 1 }).limit(500).lean();

      for (const account of accounts) {
        try { await this.#scanAccount(account); }
        catch (error) { this.logger?.error?.({ err: error?.message, accountId: String(account._id) }, 'Weekend account scan failed'); }
      }
      if (accounts.length < 500) break;
      cursor = accounts[accounts.length - 1]._id;
      }
    } finally {
      this.running = false;
    }
  }

  async #scanAccount(account) {
    const nowMs = this.now().getTime();
    const [positions, pending] = await Promise.all([
      this.positionModel.find({ accountId: account._id, status: 'OPEN' }).select('_id symbol openVolume').lean(),
      this.orderModel.find({ accountId: account._id, status: mongoose.trusted({ $in: ['PENDING', 'TRIGGERED'] }) }).select('_id symbol').lean(),
    ]);

    const symbols = [...new Set([...positions, ...pending].map(item => String(item.symbol || '').toUpperCase()).filter(Boolean))];
    if (!symbols.length) return;
    const instruments = await this.instrumentModel.find({ symbol: mongoose.trusted({ $in: symbols }) }).lean();
    const bySymbol = new Map(instruments.map(item => [String(item.symbol).toUpperCase(), item]));
    const policies = new Map();
    for (const symbol of symbols) {
      const instrument = bySymbol.get(symbol);
      if (!instrument) continue;
      const policy = await this.policyService.policyStatus(account._id, symbol, { nowMs, account, instrument });
      policies.set(symbol, policy);
      if (policy.weekend?.warning || policy.weekend?.active) {
        await this.actionService?.plan({ account, instrument, weekend: policy.weekend,
          enforced: this.enforcementEnabled && policy.enforcement?.weekendEnabled === true });
      }
    }

    for (const position of positions) {
      const symbol = String(position.symbol || '').toUpperCase();
      const policy = policies.get(symbol);
      if (!policy?.weekend?.active) continue;

      await this.policyService.recordWeekendCandidate({
        account,
        symbol,
        action: 'AUTO_CLOSE_POSITION',
        referenceId: String(position._id),
        weekend: policy.weekend,
        nowMs,
        type: 'WEEKEND_WOULD_CLOSE',
        enforcementEnabled: policy.enforcement?.weekendEnabled === true,
      });
    }

    for (const order of pending) {
      const symbol = String(order.symbol || '').toUpperCase();
      const policy = policies.get(symbol);
      if (!policy?.weekend?.active) continue;

      await this.policyService.recordWeekendCandidate({
        account,
        symbol,
        action: 'CANCEL_PENDING_ENTRY',
        referenceId: String(order._id),
        weekend: policy.weekend,
        nowMs,
        type: 'WEEKEND_WOULD_CANCEL_PENDING',
        enforcementEnabled: policy.enforcement?.weekendEnabled === true,
      });
    }
  }
}

function weekendCommandId(kind, id, cutoff) {
  return `weekend-${kind}:${String(id)}:${String(cutoff || '').replace(/[^0-9]/g, '')}`.slice(0, 128);
}

module.exports = { WeekendHoldingEngine, weekendCommandId };
