'use strict';

const { normalizeSymbol } = require('./market.utils');
const { isInstrumentSessionOpen, zonedParts } = require('../instruments/session-calendar');

function tradingDateKey(nowMs, timezone = 'UTC') {
  const local = zonedParts(nowMs, timezone);
  return `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
}

function canonicalBarDateKey(openTimeMs) {
  const timeMs = Number(openTimeMs);
  if (!Number.isFinite(timeMs)) return null;
  return new Date(timeMs).toISOString().slice(0, 10);
}

function validBars(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => (
      Number.isFinite(Number(row?.openTimeMs))
      && Number.isFinite(Number(row?.close))
      && Number(row.close) > 0
    ))
    .sort((a, b) => Number(a.openTimeMs) - Number(b.openTimeMs));
}

function selectPreviousClose({ bars, instrument, nowMs = Date.now() }) {
  const ordered = validBars(bars);
  if (!ordered.length) return null;

  const last = ordered[ordered.length - 1];
  const previous = ordered.length > 1 ? ordered[ordered.length - 2] : null;
  const timezone = String(instrument?.timezone || 'UTC');
  const todayKey = tradingDateKey(nowMs, timezone);
  const lastDateKey = canonicalBarDateKey(last.openTimeMs);
  const sessionOpen = isInstrumentSessionOpen(instrument, nowMs);

  // During an open session, providers differ on whether D1 already contains a
  // forming current-day bar. If it does, the reference is the preceding bar;
  // if it does not, the latest completed D1 bar is itself the previous close.
  if (sessionOpen) {
    if (lastDateKey === todayKey && previous) return Number(previous.close);
    return Number(last.close);
  }

  // While the market is closed, the live quote represents the most recently
  // completed session. Day change therefore compares that session with the
  // one before it, including weekends and holidays.
  return Number(previous?.close ?? last.close);
}

class DayChangeService {
  constructor({
    adapter,
    instrumentRegistry,
    quoteStore,
    eventBus,
    logger = null,
    maxConcurrentLoads = 6,
  }) {
    this.adapter = adapter;
    this.instrumentRegistry = instrumentRegistry;
    this.quoteStore = quoteStore;
    this.eventBus = eventBus;
    this.logger = logger;
    this.cache = new Map();
    this.inFlight = new Map();
    this.maxConcurrentLoads = Math.max(1, Number(maxConcurrentLoads) || 6);
    this.activeLoads = 0;
    this.loadWaiters = [];
  }

  decorate(quote) {
    const symbol = normalizeSymbol(quote?.symbol);
    if (!symbol) return quote;

    const instrument = this.instrumentRegistry.get(symbol);
    const reference = this.cache.get(symbol);
    const dayKey = tradingDateKey(Date.now(), instrument?.timezone || 'UTC');
    const previousClose = reference?.dayKey === dayKey
      ? Number(reference.previousClose)
      : null;
    if (reference && reference.dayKey !== dayKey) {
      void this.ensure(symbol).catch(() => undefined);
    }
    const last = Number(quote?.last ?? quote?.price);

    if (!Number.isFinite(previousClose) || previousClose <= 0 || !Number.isFinite(last) || last <= 0) {
      return {
        ...quote,
        previousClose: null,
        change: null,
        changePercent: null,
      };
    }

    const change = last - previousClose;
    return {
      ...quote,
      previousClose,
      change,
      changePercent: (change / previousClose) * 100,
    };
  }

  ensure(symbol, { force = false } = {}) {
    const canonical = normalizeSymbol(symbol);
    const instrument = this.instrumentRegistry.get(canonical);
    if (!instrument) return Promise.resolve(null);

    const dayKey = tradingDateKey(Date.now(), instrument.timezone || 'UTC');
    const cached = this.cache.get(canonical);
    if (!force && cached?.dayKey === dayKey) return Promise.resolve(cached);

    const existing = this.inFlight.get(canonical);
    if (existing) return existing;

    const task = this.#withLoadSlot(async () => {
        const provider = instrument.provider || 'twelve-data';
        if (!this.adapter.supportsHistory?.('1d', provider)) return null;

        const bars = await this.adapter.fetchHistorical({
          provider,
          providerSymbol: instrument.providerSymbol,
          timeframe: '1d',
          limit: 4,
          beforeMs: null,
        });
        const previousClose = selectPreviousClose({ bars, instrument, nowMs: Date.now() });
        if (!Number.isFinite(previousClose) || previousClose <= 0) return null;

        const reference = Object.freeze({
          symbol: canonical,
          previousClose,
          dayKey,
          loadedAtMs: Date.now(),
        });
        this.cache.set(canonical, reference);

        const current = this.quoteStore.get(canonical);
        if (current) {
          const enriched = this.quoteStore.set(this.decorate(current));
          this.eventBus.emit('market.quote', { ...enriched, referenceUpdate: true });
        }
        return reference;
      })
      .catch(error => {
        this.logger?.debug?.({ err: error, symbol: canonical }, 'Unable to load day-change reference');
        return null;
      })
      .finally(() => {
        if (this.inFlight.get(canonical) === task) this.inFlight.delete(canonical);
      });

    this.inFlight.set(canonical, task);
    return task;
  }

  async #withLoadSlot(work) {
    if (this.activeLoads >= this.maxConcurrentLoads) {
      await new Promise(resolve => this.loadWaiters.push(resolve));
    }
    this.activeLoads += 1;
    try {
      return await work();
    } finally {
      this.activeLoads = Math.max(0, this.activeLoads - 1);
      this.loadWaiters.shift()?.();
    }
  }

  invalidate(symbol = null) {
    if (symbol) {
      this.cache.delete(normalizeSymbol(symbol));
      return;
    }
    this.cache.clear();
  }
}

module.exports = {
  DayChangeService,
  selectPreviousClose,
  tradingDateKey,
  canonicalBarDateKey,
};
