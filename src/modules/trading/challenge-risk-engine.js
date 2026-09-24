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
    this.accounts = new Map();
    this.onValuation = valuation => this.#schedule(valuation);
    this.onAccountUpdated = account => this.#cacheAccount(account);
    this.onAccountControlled = account => this.#cacheAccount(account);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.eventBus?.on('valuation.account.updated', this.onValuation);
    this.eventBus?.on('trading.account.updated', this.onAccountUpdated);
    for (const event of ['trading.account.paused', 'trading.account.resumed', 'trading.account.disabled', 'trading.account.breached', 'trading.account.closed']) {
      this.eventBus?.on(event, this.onAccountControlled);
    }
  }

  async stop() {
    if (!this.started) return;
    this.eventBus?.off('valuation.account.updated', this.onValuation);
    this.eventBus?.off('trading.account.updated', this.onAccountUpdated);
    for (const event of ['trading.account.paused', 'trading.account.resumed', 'trading.account.disabled', 'trading.account.breached', 'trading.account.closed']) {
      this.eventBus?.off(event, this.onAccountControlled);
    }
    this.started = false;
    await Promise.allSettled([...this.inFlight.values()]);
    this.inFlight.clear();
    this.accounts.clear();
  }

  health() {
    return { started: this.started, inFlight: this.inFlight.size, cachedAccounts: this.accounts.size };
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
    let account = this.accounts.get(accountId);
    if (!account) {
      const loaded = await this.accountModel.findById(accountId).lean();
      if (!loaded) return;
      account = normalizeAccount(loaded);
      this.accounts.set(accountId, account);
    }

    if (account.status !== 'ACTIVE' || account.tradingEnabled !== true) return;

    const today = dayKeyInTimezone(this.now(), account.riskTimezone);
    if (account.riskDayKey !== today) return;

    const equity = normalizeDecimal(valuation.equity);
    const dailyStart = normalizeDecimal(account.dailyStartEquity);
    const initial = normalizeDecimal(account.initialBalance);
    const dailyLimit = normalizeDecimal(account.dailyLossLimit);
    const maxLimit = normalizeDecimal(account.maxLossLimit);

    const maxBreached = compareDecimal(maxLimit, '0') > 0
      && compareDecimal(equity, subtractDecimal(initial, maxLimit)) <= 0;
    const dailyBreached = compareDecimal(dailyLimit, '0') > 0
      && compareDecimal(equity, subtractDecimal(dailyStart, dailyLimit)) <= 0;

    if (!maxBreached && !dailyBreached) return;

    const reason = maxBreached ? 'MAX_LOSS_LIMIT_REACHED' : 'DAILY_LOSS_LIMIT_REACHED';
    const breachEvidence = buildBreachEvidence({
      reason,
      maxBreached,
      dailyBreached,
      valuation,
      account,
      equity,
      dailyStart,
      initial,
      dailyLimit,
      maxLimit,
    });

    // Prevent repeated breach calls while the durable lifecycle transaction is
    // running; the subsequent control event will refresh this cache as well.
    account.status = 'BREACHED';
    account.tradingEnabled = false;
    try {
      await this.accountControlService.breach(accountId, { reason, evidence: breachEvidence });
    } catch (error) {
      // Allow a later valuation to retry if the durable breach transaction
      // itself failed.
      account.status = 'ACTIVE';
      account.tradingEnabled = true;
      throw error;
    }
  }

  #cacheAccount(account) {
    const normalized = normalizeAccount(account);
    if (!normalized.id) return;
    this.accounts.set(normalized.id, normalized);
  }
}

function normalizeAccount(account) {
  const state = account?.state || {};
  const policy = account?.riskPolicy || {};
  return {
    id: String(account?.id || account?._id || account?.accountId || ''),
    status: String(account?.status || '').toUpperCase(),
    tradingEnabled: account?.tradingEnabled === true,
    riskDayKey: account?.riskDayKey || null,
    riskTimezone: String(account?.riskTimezone || 'UTC'),
    initialBalance: value(state.initialBalance, '0'),
    dailyStartEquity: value(state.dailyStartEquity, state.initialBalance ?? '0'),
    dailyLossLimit: value(policy.dailyLoss?.limit, '0'),
    maxLossLimit: value(policy.maxLoss?.limit, '0'),
  };
}

function buildBreachEvidence({ reason, maxBreached, dailyBreached, valuation, account, equity, dailyStart, initial, dailyLimit, maxLimit }) {
  const maxBreach = reason === 'MAX_LOSS_LIMIT_REACHED';
  const reference = maxBreach ? initial : dailyStart;
  const limit = maxBreach ? maxLimit : dailyLimit;
  const triggeredRules = [];
  if (dailyBreached) triggeredRules.push('DAILY_DRAWDOWN');
  if (maxBreached) triggeredRules.push('MAX_DRAWDOWN');
  const threshold = subtractDecimal(reference, limit);
  const rawLoss = subtractDecimal(reference, equity);
  const actualLoss = compareDecimal(rawLoss, '0') > 0 ? rawLoss : '0';
  const rawBreachAmount = subtractDecimal(actualLoss, limit);
  const breachAmount = compareDecimal(rawBreachAmount, '0') > 0 ? rawBreachAmount : '0';

  return Object.freeze({
    reason,
    rule: maxBreach ? 'MAX_DRAWDOWN' : 'DAILY_DRAWDOWN',
    triggeredRules,
    balance: value(valuation?.balance, account?.balance ?? '0'),
    equity,
    floatingPnl: value(valuation?.floatingPnl, '0'),
    usedMargin: value(valuation?.usedMargin, '0'),
    freeMargin: value(valuation?.freeMargin, '0'),
    dailyStartEquity: dailyStart,
    initialBalance: initial,
    limitAmount: limit,
    thresholdEquity: threshold,
    actualLoss,
    breachAmount,
    riskDayKey: account?.riskDayKey || null,
    valuationSequence: Number.isFinite(Number(valuation?.sequence)) ? Number(valuation.sequence) : null,
    valuedAtMs: Number.isFinite(Number(valuation?.valuedAtMs)) ? Number(valuation.valuedAtMs) : Date.now(),
  });
}

function value(input, fallback) {
  if (input === null || input === undefined) return String(fallback ?? '0');
  return input?.toString ? input.toString() : String(input);
}

module.exports = { ChallengeRiskEngine, normalizeAccount };
