'use strict';

const { TradingAccount } = require('../accounts/trading-account.model');
const { Instrument } = require('../instruments/instrument.model');
const { Position } = require('./position.model');
const { Order } = require('./order.model');

class WeekendHoldingEngine {
  constructor({
    policyService,
    marketOrderService,
    pendingOrderService,
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
      const accounts = await this.accountModel.find({
        status: 'ACTIVE',
        tradingEnabled: true,
        'tradingPermissions.weekendHolding': false,
      }).select('_id tenantId tradingPermissions').lean().limit(500);

      for (const account of accounts) await this.#scanAccount(account);
    } finally {
      this.running = false;
    }
  }

  async #scanAccount(account) {
    const nowMs = this.now().getTime();
    const [positions, pending] = await Promise.all([
      this.positionModel.find({ accountId: account._id, status: 'OPEN' }).select('_id symbol openVolume').lean(),
      this.orderModel.find({ accountId: account._id, status: { $in: ['PENDING', 'TRIGGERED'] } }).select('_id symbol').lean(),
    ]);

    const symbols = [...new Set([...positions, ...pending].map(item => String(item.symbol || '').toUpperCase()).filter(Boolean))];
    if (!symbols.length) return;
    const instruments = await this.instrumentModel.find({ symbol: { $in: symbols } }).lean();
    const bySymbol = new Map(instruments.map(item => [String(item.symbol).toUpperCase(), item]));

    for (const position of positions) {
      const symbol = String(position.symbol || '').toUpperCase();
      const policy = await this.policyService.policyStatus(account._id, symbol, { nowMs });
      if (!policy.weekend?.active) continue;

      await this.policyService.recordWeekendCandidate({
        account,
        symbol,
        action: 'AUTO_CLOSE_POSITION',
        referenceId: String(position._id),
        weekend: policy.weekend,
        nowMs,
        type: 'WEEKEND_WOULD_CLOSE',
      });

      if (!this.enforcementEnabled || !bySymbol.get(symbol)) continue;
      await this.marketOrderService.closeMarketPosition({
        accountId: String(account._id),
        positionId: String(position._id),
        clientOrderId: weekendCommandId('close', position._id, policy.weekend.autoCloseAt),
        volume: null,
        requestedPrice: null,
        source: 'SYSTEM',
        reason: 'WEEKEND_HOLDING_POLICY',
      }).catch(error => this.logger?.error?.({ err: error?.message, accountId: String(account._id), positionId: String(position._id) }, 'Weekend auto-close failed'));
    }

    for (const order of pending) {
      const symbol = String(order.symbol || '').toUpperCase();
      const policy = await this.policyService.policyStatus(account._id, symbol, { nowMs });
      if (!policy.weekend?.active) continue;

      await this.policyService.recordWeekendCandidate({
        account,
        symbol,
        action: 'CANCEL_PENDING_ENTRY',
        referenceId: String(order._id),
        weekend: policy.weekend,
        nowMs,
        type: 'WEEKEND_WOULD_CANCEL_PENDING',
      });

      if (!this.enforcementEnabled) continue;
      await this.pendingOrderService.cancelPendingOrder({
        accountId: String(account._id),
        orderId: String(order._id),
        clientRequestId: weekendCommandId('cancel', order._id, policy.weekend.autoCloseAt),
      }).catch(error => this.logger?.error?.({ err: error?.message, accountId: String(account._id), orderId: String(order._id) }, 'Weekend pending-order cancellation failed'));
    }
  }
}

function weekendCommandId(kind, id, cutoff) {
  return `weekend-${kind}:${String(id)}:${String(cutoff || '').replace(/[^0-9]/g, '')}`.slice(0, 128);
}

module.exports = { WeekendHoldingEngine, weekendCommandId };
