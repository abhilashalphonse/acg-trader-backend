'use strict';

const DEFAULT_TTL_MS = Object.freeze({
  '1m': 20_000,
  '5m': 30_000,
  '15m': 60_000,
  '30m': 120_000,
  '1h': 300_000,
  '4h': 600_000,
  '1d': 900_000,
  '1w': 1_800_000,
});

class ProviderHistoryCache {
  constructor({
    ttlByTimeframe = DEFAULT_TTL_MS,
    maxEntries = 256,
    maxBars = 50_000,
    now = () => Date.now(),
  } = {}) {
    this.ttlByTimeframe = { ...DEFAULT_TTL_MS, ...ttlByTimeframe };
    this.maxEntries = Math.max(1, Number(maxEntries) || 256);
    this.maxBars = Math.max(1, Number(maxBars) || 50_000);
    this.now = now;

    this.entries = new Map();
    this.inFlight = new Map();
    this.totalBars = 0;
    this.counters = {
      hits: 0,
      misses: 0,
      loads: 0,
      deduped: 0,
      evictions: 0,
      expirations: 0,
    };
  }

  async getOrLoad({ key, timeframe, limit, load }) {
    const cacheKey = String(key || '');
    const requestedLimit = Math.max(1, Number(limit) || 1);
    if (!cacheKey) throw new Error('Provider history cache key is required');
    if (typeof load !== 'function') throw new Error('Provider history cache load function is required');

    const cached = this.#get(cacheKey, timeframe, requestedLimit);
    if (cached) return cached;
    this.counters.misses += 1;

    while (true) {
      const pending = this.inFlight.get(cacheKey);
      if (pending) {
        this.counters.deduped += 1;
        await pending.promise;
        const afterPending = this.#get(cacheKey, timeframe, requestedLimit);
        if (afterPending) return afterPending;
        continue;
      }

      let promise;
      promise = Promise.resolve()
        .then(() => {
          this.counters.loads += 1;
          return load();
        })
        .then(result => {
          const bars = Array.isArray(result) ? result : [];
          if (bars.length) this.#set(cacheKey, timeframe, requestedLimit, bars);
          return bars;
        })
        .finally(() => {
          if (this.inFlight.get(cacheKey)?.promise === promise) {
            this.inFlight.delete(cacheKey);
          }
        });

      this.inFlight.set(cacheKey, { requestedLimit, promise });
      const bars = await promise;
      return bars.slice(-requestedLimit);
    }
  }

  stats() {
    return {
      entries: this.entries.size,
      bars: this.totalBars,
      inFlight: this.inFlight.size,
      maxEntries: this.maxEntries,
      maxBars: this.maxBars,
      ...this.counters,
    };
  }

  clear() {
    this.entries.clear();
    this.inFlight.clear();
    this.totalBars = 0;
  }

  #get(key, timeframe, limit) {
    const entry = this.entries.get(key);
    if (!entry) return null;

    if (entry.expiresAtMs <= this.now()) {
      this.#delete(key);
      this.counters.expirations += 1;
      return null;
    }

    if (!entry.exhausted && entry.requestedLimit < limit) return null;

    // Map insertion order doubles as an LRU list.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.counters.hits += 1;
    return entry.bars.slice(-limit);
  }

  #set(key, timeframe, requestedLimit, bars) {
    const ttlMs = Math.max(1_000, Number(this.ttlByTimeframe[timeframe]) || 30_000);
    const normalized = Object.freeze(bars.map(bar => Object.freeze({ ...bar })));

    this.#delete(key);
    const entry = {
      timeframe,
      requestedLimit,
      exhausted: normalized.length < requestedLimit,
      expiresAtMs: this.now() + ttlMs,
      bars: normalized,
    };
    this.entries.set(key, entry);
    this.totalBars += normalized.length;
    this.#evict();
  }

  #delete(key) {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.totalBars = Math.max(0, this.totalBars - existing.bars.length);
    this.entries.delete(key);
  }

  #evict() {
    while (this.entries.size > this.maxEntries || this.totalBars > this.maxBars) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.#delete(oldestKey);
      this.counters.evictions += 1;
    }
  }
}

module.exports = {
  ProviderHistoryCache,
  DEFAULT_TTL_MS,
};
