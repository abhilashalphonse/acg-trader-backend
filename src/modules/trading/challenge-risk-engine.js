'use strict';

const { normalizeDecimal, subtractDecimal, compareDecimal } = require('../../shared/decimal/decimal');
const { APPENDED_EVENT } = require('./account-risk-stream.service');

class ChallengeRiskEngine {
  constructor({
    eventBus,
    accountControlService,
    riskStreamService,
    logger = null,
  } = {}) {
    this.eventBus = eventBus;
    this.accountControlService = accountControlService;
    this.riskStreamService = riskStreamService;
    this.logger = logger;
    this.started = false;
    this.inFlight = new Map();
    this.wake = new Set();
    this.onRiskEvent = event => this.#schedule(event?.accountId);
  }

  async start() {
    if (this.started) return;
    if (!this.riskStreamService) throw new TypeError('riskStreamService is required');
    this.started = true;
    this.eventBus?.on(APPENDED_EVENT, this.onRiskEvent);

    const pending = await this.riskStreamService.pendingAccountIds();
    await Promise.all(pending.map(accountId => this.#schedule(accountId)));
  }

  async stop() {
    if (!this.started) return;
    this.eventBus?.off(APPENDED_EVENT, this.onRiskEvent);
    this.started = false;
    await Promise.allSettled([...this.inFlight.values()]);
    this.inFlight.clear();
    this.wake.clear();
  }

  health() {
    return {
      started: this.started,
      inFlight: this.inFlight.size,
      wakeAccounts: this.wake.size,
    };
  }

  #schedule(rawAccountId) {
    const accountId = String(rawAccountId || '').trim();
    if (!accountId) return Promise.resolve();

    const current = this.inFlight.get(accountId);
    if (current) {
      this.wake.add(accountId);
      return current;
    }

    const work = this.#runAccount(accountId)
      .catch(error => {
        this.logger?.error?.({ err: error, accountId }, 'Ordered challenge risk processing failed');
      })
      .finally(() => {
        if (this.inFlight.get(accountId) === work) this.inFlight.delete(accountId);
        if (this.started && this.wake.delete(accountId)) {
          queueMicrotask(() => this.#schedule(accountId));
        }
      });

    this.inFlight.set(accountId, work);
    return work;
  }

  async #runAccount(accountId) {
    do {
      this.wake.delete(accountId);
      await this.#drain(accountId);
    } while (this.wake.has(accountId));
  }

  async #drain(accountId) {
    while (this.started) {
      const next = await this.riskStreamService.nextForProcessing(accountId);

      if (next.state === 'EMPTY' || next.state === 'MISSING_ACCOUNT') return;

      if (next.state === 'GAP') {
        await this.riskStreamService.markUnresolved(accountId, {
          expectedSequence: next.expected,
          nextAvailableSequence: next.nextAvailable,
          reason: 'RISK_SEQUENCE_GAP',
        });
        this.logger?.error?.({
          accountId,
          expectedRiskSequence: next.expected,
          nextAvailableRiskSequence: next.nextAvailable,
          highestRiskSequence: next.highest,
        }, 'Risk sequence gap detected; new exposure is blocked');
        return;
      }

      const event = next.event;
      const outcome = await this.#processEvent(event);
      const marked = await this.riskStreamService.markProcessed(accountId, event.sequence, {
        processingState: outcome.breached ? 'BREACH' : 'PROCESSED',
        processingResult: outcome,
      });
      if (marked?.state === 'GAP') return;
    }
  }

  async #processEvent(event) {
    if (event.eventType !== 'VALUATION') {
      return {
        breached: false,
        eventType: event.eventType,
        riskSequence: Number(event.sequence),
      };
    }

    const evaluation = evaluateRiskEvent(event);
    if (!evaluation.breached) return evaluation;

    await this.accountControlService.breach(String(event.accountId), {
      reason: evaluation.reason,
      evidence: evaluation.evidence,
    });

    return evaluation;
  }
}

function evaluateRiskEvent(event) {
  const context = event?.context || {};
  if (
    String(context.accountStatus || '').toUpperCase() !== 'ACTIVE'
    || context.tradingEnabled !== true
  ) {
    return {
      breached: false,
      eventType: event?.eventType || 'VALUATION',
      riskSequence: Number(event?.sequence || 0),
      reason: 'ACCOUNT_NOT_ACTIVE_AT_VALUATION',
    };
  }

  const valuation = context.valuation || {};
  const equity = normalizeDecimal(valuation.equity ?? '0');
  const dailyStart = normalizeDecimal(context.dailyStartEquity ?? context.initialBalance ?? '0');
  const initial = normalizeDecimal(context.initialBalance ?? '0');
  const dailyLimit = normalizeDecimal(context.dailyLossLimit ?? '0');
  const maxLimit = normalizeDecimal(context.maxLossLimit ?? '0');

  const maxBreached = compareDecimal(maxLimit, '0') > 0
    && compareDecimal(equity, subtractDecimal(initial, maxLimit)) <= 0;
  const dailyBreached = compareDecimal(dailyLimit, '0') > 0
    && compareDecimal(equity, subtractDecimal(dailyStart, dailyLimit)) <= 0;

  if (!maxBreached && !dailyBreached) {
    return {
      breached: false,
      eventType: 'VALUATION',
      riskSequence: Number(event?.sequence || 0),
      equity,
    };
  }

  const reason = maxBreached ? 'MAX_LOSS_LIMIT_REACHED' : 'DAILY_LOSS_LIMIT_REACHED';
  return {
    breached: true,
    reason,
    eventType: 'VALUATION',
    riskSequence: Number(event?.sequence || 0),
    evidence: buildBreachEvidence({
      event,
      reason,
      maxBreached,
      dailyBreached,
      valuation,
      context,
      equity,
      dailyStart,
      initial,
      dailyLimit,
      maxLimit,
    }),
  };
}

function buildBreachEvidence({
  event,
  reason,
  maxBreached,
  dailyBreached,
  valuation,
  context,
  equity,
  dailyStart,
  initial,
  dailyLimit,
  maxLimit,
}) {
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
    balance: value(valuation.balance, '0'),
    equity,
    floatingPnl: value(valuation.floatingPnl, '0'),
    usedMargin: value(valuation.usedMargin, '0'),
    freeMargin: value(valuation.freeMargin, '0'),
    dailyStartEquity: dailyStart,
    initialBalance: initial,
    limitAmount: limit,
    thresholdEquity: threshold,
    actualLoss,
    breachAmount,
    riskDayKey: event?.riskDayKey || context?.riskDayKey || null,
    riskTimezone: event?.riskTimezone || context?.riskTimezone || 'UTC',
    riskPolicyVersion: event?.policyVersion || context?.policyVersion || null,
    financialRevision: Number(event?.financialRevision ?? context?.financialRevision ?? 0),
    riskSequence: Number(event?.sequence || 0),
    valuationSequence: finiteNumber(valuation.sourceSequence),
    valuedAtMs: finiteNumber(valuation.valuedAtMs),
  });
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function value(input, fallback) {
  if (input === null || input === undefined) return String(fallback ?? '0');
  return input?.toString ? input.toString() : String(input);
}

module.exports = {
  ChallengeRiskEngine,
  evaluateRiskEvent,
  buildBreachEvidence,
};
