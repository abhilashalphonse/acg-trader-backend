'use strict';

const { normalizeDecimal, subtractDecimal, compareDecimal } = require('../../shared/decimal/decimal');
const { RiskStreamService } = require('./risk-stream.service');

class ChallengeRiskEngine {
  constructor({
    eventBus,
    accountControlService,
    riskStreamService = new RiskStreamService(),
    logger = null,
  } = {}) {
    this.eventBus = eventBus;
    this.accountControlService = accountControlService;
    this.riskStreamService = riskStreamService;
    this.logger = logger;
    this.started = false;
    this.inFlight = new Map();
    this.rerun = new Set();
    this.onValuation = valuation => { void this.#ingest(valuation); };
  }

  async start() {
    if (this.started) return;
    this.started = true;
    this.eventBus?.on('valuation.account.updated', this.onValuation);
    const pending = await this.riskStreamService.pendingAccountIds();
    for (const accountId of pending) this.#scheduleDrain(accountId);
  }

  async stop() {
    if (!this.started) return;
    this.eventBus?.off('valuation.account.updated', this.onValuation);
    this.started = false;
    await Promise.allSettled([...this.inFlight.values()]);
    this.inFlight.clear();
    this.rerun.clear();
  }

  health() {
    return {
      started: this.started,
      inFlight: this.inFlight.size,
      rerunAccounts: this.rerun.size,
      durableOrderedRisk: true,
    };
  }

  async #ingest(valuation) {
    try {
      const accepted = await this.riskStreamService.ingestValuation(valuation);
      if (!accepted?.accepted || !accepted.accountId) return;
      this.#scheduleDrain(accepted.accountId);
    } catch (error) {
      this.logger?.error({ err: error, accountId: valuation?.accountId }, 'Durable challenge risk ingestion failed');
    }
  }

  #scheduleDrain(accountId) {
    const key = String(accountId || '').trim();
    if (!key) return;
    if (this.inFlight.has(key)) {
      this.rerun.add(key);
      return;
    }
    const work = this.#drain(key)
      .catch(error => this.logger?.error({ err: error, accountId: key }, 'Challenge risk replay failed'))
      .finally(() => {
        if (this.inFlight.get(key) === work) this.inFlight.delete(key);
        if (this.rerun.delete(key) && this.started) this.#scheduleDrain(key);
      });
    this.inFlight.set(key, work);
  }

  async #drain(accountId) {
    while (this.started) {
      const next = await this.riskStreamService.getNext(accountId);
      if (!next?.account || next.gap || !next.event) return;

      const event = next.event;
      if (event.state && event.state !== 'RECEIVED') {
        await this.riskStreamService.complete(accountId, event.sequence, {
          state: event.state,
          result: event.result || null,
        });
        continue;
      }

      if (event.type !== 'VALUATION') {
        await this.riskStreamService.complete(accountId, event.sequence, {
          state: 'EVALUATED',
          result: { type: event.type, applied: true },
        });
        continue;
      }

      const outcome = evaluateRiskContext(event.context || {});
      if (!outcome.breached) {
        await this.riskStreamService.complete(accountId, event.sequence, {
          state: 'EVALUATED',
          result: outcome,
        });
        continue;
      }

      const currentStatus = String(next.account.status || '').toUpperCase();
      if (currentStatus === 'ACTIVE' && next.account.tradingEnabled === true) {
        await this.accountControlService.breach(accountId, {
          reason: outcome.reason,
          evidence: outcome.evidence,
        });
      }

      await this.riskStreamService.complete(accountId, event.sequence, {
        state: 'BREACHED',
        result: outcome,
      });
      return;
    }
  }
}

function evaluateRiskContext(context) {
  const equity = normalizeDecimal(context.equity ?? '0');
  const dailyStart = normalizeDecimal(context.dailyStartEquity ?? '0');
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
      equity,
      riskDayKey: context.riskDayKey || null,
      policyVersion: context.policyVersion || null,
    };
  }

  const reason = maxBreached ? 'MAX_LOSS_LIMIT_REACHED' : 'DAILY_LOSS_LIMIT_REACHED';
  return {
    breached: true,
    reason,
    evidence: buildBreachEvidence({
      reason,
      maxBreached,
      dailyBreached,
      context,
      equity,
      dailyStart,
      initial,
      dailyLimit,
      maxLimit,
    }),
  };
}

function buildBreachEvidence({ reason, maxBreached, dailyBreached, context, equity, dailyStart, initial, dailyLimit, maxLimit }) {
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
    balance: value(context.balance, '0'),
    equity,
    floatingPnl: value(context.floatingPnl, '0'),
    usedMargin: value(context.usedMargin, '0'),
    freeMargin: value(context.freeMargin, '0'),
    marginLevel: value(context.marginLevel, null),
    dailyStartEquity: dailyStart,
    initialBalance: initial,
    limitAmount: limit,
    thresholdEquity: threshold,
    actualLoss,
    breachAmount,
    riskDayKey: context.riskDayKey || null,
    riskTimezone: context.riskTimezone || 'UTC',
    policyVersion: context.policyVersion || null,
    financialRevision: Number(context.financialRevision || 0),
    valuationSequence: Number.isFinite(Number(context.valuationSequence)) ? Number(context.valuationSequence) : null,
    valuedAtMs: Number.isFinite(Number(context.valuedAtMs)) ? Number(context.valuedAtMs) : null,
  });
}

function value(input, fallback) {
  if (input === null || input === undefined) return fallback == null ? null : String(fallback);
  return input?.toString ? input.toString() : String(input);
}

module.exports = {
  ChallengeRiskEngine,
  evaluateRiskContext,
  buildBreachEvidence,
};
