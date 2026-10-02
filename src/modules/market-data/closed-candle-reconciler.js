'use strict';

const { TIMEFRAME_MS } = require('./market.constants');

// Check after publication, then once more for delayed provider finalization.
// Missing bars / provider failures get two further attempts. All requests are
// serialized and paced, independent of the number of browser subscriptions.
const DEFAULT_DELAYS_MS = Object.freeze([15_000, 75_000, 180_000, 600_000]);

class ClosedCandleReconciler {
  constructor({ eventBus, adapter, instrumentRegistry, candleEngine, invalidateHistory = () => {}, logger,
    requestIntervalMs = 1000, delaysMs = DEFAULT_DELAYS_MS, maxPending = 2000,
    now = Date.now, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
    Object.assign(this, { eventBus, adapter, instrumentRegistry, candleEngine, invalidateHistory, logger,
      now, setIntervalImpl, clearIntervalImpl, maxPending });
    this.requestIntervalMs = Math.max(1000, Number(requestIntervalMs) || 1000);
    this.delaysMs = [...delaysMs];
    this.pending = new Map();
    this.finished = new Set();
    this.running = false;
    this.inFlight = null;
    this.nextRequestAt = 0;
    this.counters = { requests: 0, reconciled: 0, failed: 0, exhausted: 0, dropped: 0 };
    this.onClosed = candle => this.enqueue(candle);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.eventBus.on('market.candle.closed', this.onClosed);
    this.timer = this.setIntervalImpl(() => { void this.runDue(); }, 1000);
    this.timer?.unref?.();
  }

  async stop() {
    this.running = false;
    this.eventBus.off('market.candle.closed', this.onClosed);
    this.clearIntervalImpl(this.timer);
    this.pending.clear();
    this.finished.clear();
    await this.inFlight;
  }

  enqueue(candle) {
    if (!this.running || candle?.timeframe !== '5m' || candle.complete !== true) return;
    const instrument = this.instrumentRegistry.get(candle.symbol);
    if (instrument?.provider !== 'twelve-data' || instrument.assetClass !== 'FOREX') return;
    const openTimeMs = Number(candle.openTimeMs);
    const closeTimeMs = openTimeMs + TIMEFRAME_MS['5m'];
    if (!Number.isFinite(openTimeMs) || openTimeMs % TIMEFRAME_MS['5m'] !== 0 || closeTimeMs > this.now()) return;
    const key = `${candle.symbol}:5m:${openTimeMs}`;
    if (this.pending.has(key) || this.finished.has(key)) return;
    if (this.pending.size >= this.maxPending) {
      this.counters.dropped += 1;
      this.logger?.warn?.({ symbol: candle.symbol, openTimeMs }, 'Closed candle reconciliation queue is full');
      return;
    }
    this.pending.set(key, { key, candle: { ...candle, openTimeMs, closeTimeMs },
      attempt: 0, dueAt: closeTimeMs + this.delaysMs[0] });
  }

  runDue() {
    if (!this.running || this.inFlight || this.now() < this.nextRequestAt) return this.inFlight || Promise.resolve();
    const job = [...this.pending.values()].filter(item => item.dueAt <= this.now())
      .sort((a, b) => a.dueAt - b.dueAt)[0];
    if (!job) return Promise.resolve();
    this.nextRequestAt = this.now() + this.requestIntervalMs;
    this.inFlight = this.process(job).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async process(job) {
    const { candle } = job;
    let success = false;
    try {
      this.counters.requests += 1;
      // Bypass partial history caches. The exclusive cursor prevents selecting
      // the new active candle even if publication is delayed beyond a rollover.
      const bars = await this.adapter.fetchHistorical({
        provider: 'twelve-data', providerSymbol: this.instrumentRegistry.providerSymbol(candle.symbol),
        timeframe: candle.timeframe, limit: 2, beforeMs: candle.closeTimeMs,
      });
      if (!this.running) return;
      const bar = bars.find(item => Number(item.openTimeMs) === candle.openTimeMs);
      const ohlc = bar && [bar.open, bar.high, bar.low, bar.close];
      if (!bar || bar.complete === false || !ohlc.every(value => value != null && String(value).trim() !== '' && Number.isFinite(Number(value)) && Number(value) > 0)
        || Number(bar.low) > Math.min(Number(bar.open), Number(bar.close))
        || Number(bar.high) < Math.max(Number(bar.open), Number(bar.close))) {
        throw new Error('Final provider candle is missing or invalid');
      }
      this.invalidateHistory(candle.symbol, candle.timeframe);
      const previous = job.appliedBar || candle;
      const unchanged = !previous.synthetic && ['open', 'high', 'low', 'close', 'providerVolume']
        .every(field => (previous[field] ?? null) === (bar[field] ?? null));
      const result = unchanged ? previous : await this.candleEngine.reconcileCompletedCandle(candle.symbol, candle.timeframe, {
        ...candle, ...bar, tickCount: candle.tickCount,
        closeTimeMs: candle.closeTimeMs, provider: 'twelve-data', complete: true,
      }, { reason: 'provider-close-reconciliation' });
      if (!result) throw new Error('Closed candle correction was not applied');
      job.appliedBar = result;
      success = true;
      this.counters.reconciled += 1;
    } catch (error) {
      this.counters.failed += 1;
      this.logger?.warn?.({ err: error, symbol: candle.symbol, timeframe: candle.timeframe,
        openTimeMs: candle.openTimeMs, attempt: job.attempt + 1 }, 'Closed candle provider reconciliation failed');
    }
    if (!this.running) return;
    job.attempt += 1;
    if ((success && job.attempt >= 2) || job.attempt >= this.delaysMs.length) {
      if (!success) this.counters.exhausted += 1;
      this.pending.delete(job.key);
      this.finished.add(job.key);
      if (this.finished.size > this.maxPending * 2) this.finished.delete(this.finished.values().next().value);
    } else {
      job.dueAt = Math.max(this.now() + this.requestIntervalMs, candle.closeTimeMs + this.delaysMs[job.attempt]);
    }
  }

  status() { return { running: this.running, pending: this.pending.size, ...this.counters }; }
}

module.exports = { ClosedCandleReconciler, DEFAULT_DELAYS_MS };
