'use strict';

const { normalizeDecimal, subtractDecimal, compareDecimal } = require('../../shared/decimal/decimal');
const { TradingAccount } = require('../accounts/trading-account.model');
const { dayKeyInTimezone } = require('./risk-day-engine');

class ChallengeRiskEngine {
  constructor({
    eventBus,
    accountControlService,
    logger = null,
    accountModel = TradingAccount,
    now = () => new Date(),
  } = {}) {
    this.eventBus = eventBus;
    this.accountControlService = accountControlService;
    this.logger = logger;
    this.accountModel = accountModel;
    this.now = now;
    this.started = false;
    this.inFlight = new Map();
    this.onValuation = valuation => this.#schedule(valuation);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.eventBus?.on('valuation.account.updated', this.onValuation);
  }

  async stop() {
    if (!this.started) return;
    this.eventBus?.off('valuation.account.updated', this.onValuation);
    this.started = false;
    await Promise.allSettled([...this.inFlight.values()]);
    this.inFlight.clear();
  }

  health() {
    return { started: this.started, inFlight: this.inFlight.size };
  }

  #schedule(valuation) {
    if (!valuation || valuation.complete !== true || String(valuation.valuationStatus || '').toUpperCase() !== 'LIVE') return;
    const accountId = String(valuation.accountId || valuation.id || '').trim();
    if (!accountId || this.inFlight.has(accountId)) return;

    const work = this.#evaluate(accountId, valuation)
      .catch(error => this.logger?.error({ err: error, accountId }, 'Challenge risk evaluation failed'))
      .finally(() => {
        if (this.inFlight.get(accountId) === work) this.inFlight.delete(accountId);
      });
    this.inFlight.set(accountId, work);
  }

  async #evaluate(accountId, valuation) {
    const account = await this.accountModel.findById(accountId).lean();
    if (!account || account.status !== 'ACTIVE' || account.tradingEnabled !== true) return;

    const timezone = String(account.riskTimezone || 'UTC');
    const today = dayKeyInTimezone(this.now(), timezone);
    if (account.riskDayKey !== today) return;

    const equity = normalizeDecimal(valuation.equity);
    const dailyStart = normalizeDecimal(account.state?.dailyStartEquity ?? account.state?.initialBalance ?? '0');
    const initial = normalizeDecimal(account.state?.initialBalance ?? '0');
    const dailyLimit = normalizeDecimal(account.riskPolicy?.dailyLoss?.limit ?? '0');
    const maxLimit = normalizeDecimal(account.riskPolicy?.maxLoss?.limit ?? '0');

    let reason = null;
    if (compareDecimal(maxLimit, '0') > 0 && compareDecimal(equity, subtractDecimal(initial, maxLimit)) <= 0) {
      reason = 'MAX_LOSS_LIMIT_REACHED';
    } else if (compareDecimal(dailyLimit, '0') > 0 && compareDecimal(equity, subtractDecimal(dailyStart, dailyLimit)) <= 0) {
      reason = 'DAILY_LOSS_LIMIT_REACHED';
    }

    if (!reason) return;
    await this.accountControlService.breach(accountId, { reason });
  }
}

module.exports = { ChallengeRiskEngine };
