'use strict';

class RiskDayEngine {
  constructor({
    eventBus,
    logger = null,
    riskStreamService = null,
    valuationEngine = null,
  } = {}) {
    this.eventBus = eventBus;
    this.logger = logger;
    this.riskStreamService = riskStreamService;
    this.valuationEngine = valuationEngine;
    this.started = false;
    this.inFlight = new Map();
    this.onValuation = valuation => this.#accept(valuation);
  }

  start() {
    if (this.started) return;
    if (!this.riskStreamService) throw new TypeError('riskStreamService is required');
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
    return {
      started: this.started,
      inFlight: this.inFlight.size,
    };
  }

  #accept(valuation) {
    if (!valuation || valuation.complete !== true || String(valuation.valuationStatus || '').toUpperCase() !== 'LIVE') return;

    const accountId = String(valuation.accountId || valuation.id || '').trim();
    if (!accountId) return;

    const key = String(valuation.eventId || `${accountId}:${valuation.financialRevision ?? 'na'}:${valuation.sequence ?? 'na'}:${valuation.valuedAtMs ?? Date.now()}`);
    if (this.inFlight.has(key)) return;

    const work = this.riskStreamService.ingestValuation(valuation)
      .catch(error => {
        if (error?.code === 'STALE_VALUATION_REVISION') {
          this.valuationEngine?.scheduleAccountRevalue?.(accountId, 'stale-risk-valuation');
          this.logger?.warn?.({
            accountId,
            expectedFinancialRevision: error?.details?.expectedFinancialRevision,
            currentFinancialRevision: error?.details?.currentFinancialRevision,
          }, 'Rejected stale risk valuation and requested recalculation');
          return;
        }
        if (error?.code === 'STALE_RISK_DAY_VALUATION') {
          this.logger?.warn?.({ accountId, details: error?.details }, 'Ignored valuation from an already closed risk day');
          return;
        }
        this.logger?.error?.({ err: error, accountId }, 'Durable risk valuation ingestion failed');
      })
      .finally(() => {
        if (this.inFlight.get(key) === work) this.inFlight.delete(key);
      });

    this.inFlight.set(key, work);
  }
}

function dayKeyInTimezone(date, timeZone = 'UTC') {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

module.exports = { RiskDayEngine, dayKeyInTimezone };
