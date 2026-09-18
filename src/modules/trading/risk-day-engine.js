'use strict';

const { TradingAccount } = require('../accounts/trading-account.model');
const { serializeAccount } = require('./trading.serializer');

class RiskDayEngine {
  constructor({
    eventBus,
    logger = null,
    accountModel = TradingAccount,
    now = () => new Date(),
  } = {}) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.accountModel = accountModel;
    this.now = now;
    this.started = false;
    this.inFlight = new Set();
    this.onValuation = valuation => {
      void this.#handleValuation(valuation).catch(error => {
        this.logger?.error({ err: error, accountId: valuation?.accountId || valuation?.id }, 'Risk day rollover failed');
      });
    };
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.eventBus?.on('valuation.account.updated', this.onValuation);
  }

  stop() {
    if (!this.started) return;
    this.eventBus?.off('valuation.account.updated', this.onValuation);
    this.started = false;
  }

  health() {
    return { started: this.started, inFlight: this.inFlight.size };
  }

  async #handleValuation(valuation) {
    if (!valuation || valuation.complete !== true || String(valuation.valuationStatus || '').toUpperCase() !== 'LIVE') return;

    const accountId = String(valuation.accountId || valuation.id || '').trim();
    if (!accountId || this.inFlight.has(accountId)) return;

    const equity = Number(valuation.equity);
    if (!Number.isFinite(equity)) return;

    this.inFlight.add(accountId);
    try {
      const dayKey = this.now().toISOString().slice(0, 10);
      const account = await this.accountModel.findById(accountId);
      if (!account || account.riskDayKey === dayKey) return;

      account.riskDayKey = dayKey;
      account.state.dailyStartEquity = String(equity);
      account.state.realizedPnlToday = '0';
      await account.save();

      try {
        this.eventBus?.emit('trading.account.updated', serializeAccount(account));
      } catch (error) {
        this.logger?.error({ err: error, accountId }, 'Risk day account update event failed');
      }
    } finally {
      this.inFlight.delete(accountId);
    }
  }
}

module.exports = { RiskDayEngine };
