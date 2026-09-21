'use strict';

const mongoose = require('mongoose');
const { Candle } = require('./candle.model');
const {
  TIMEFRAME_MS,
  CANONICAL_UTC_HISTORY_SOURCE,
  TICK_VOLUME_FALLBACK_TIMEFRAMES,
} = require('./market.constants');
const { normalizeSymbol, serializeCandle, clampInteger } = require('./market.utils');
const { AppError } = require('../../shared/errors/app-error');
const { ProviderHistoryCache } = require('./history-cache');

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function trailingPositiveRun(bars, selector) {
  let count = 0;
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    if (positiveNumber(selector(bars[index])) == null) break;
    count += 1;
  }
  return count;
}

function trailingMissingRun(bars, selector) {
  let count = 0;
  for (let index = bars.length - 1; index >= 0; index -= 1) {
    if (positiveNumber(selector(bars[index])) != null) break;
    count += 1;
  }
  return count;
}

function chooseVolumeMode(bars, timeframe = null) {
  const usable = (Array.isArray(bars) ? bars : [])
    .filter(bar => !bar.synthetic && bar?.complete !== false);
  if (!usable.length) return 'unavailable';

  const providerPositive = usable.filter(bar => positiveNumber(bar.providerVolume) != null).length;
  const tickPositive = usable.filter(bar => positiveNumber(bar.tickCount) != null).length;
  const providerCoverage = providerPositive / usable.length;

  // Overall coverage alone is not enough: some provider feeds can return
  // healthy historical volume followed by a long zero/null tail while prices
  // continue normally. Prefer recent continuity so the chart never compares
  // stale historical provider bars with a live volume spike.
  const recent = usable.slice(-24);
  const recentProviderPositive = recent.filter(bar => positiveNumber(bar.providerVolume) != null).length;
  const recentProviderCoverage = recentProviderPositive / recent.length;
  const recentProviderGap = trailingMissingRun(recent, bar => bar.providerVolume);
  const providerHealthy = providerPositive >= 2
    && providerCoverage >= 0.5
    && recentProviderPositive >= Math.min(2, recent.length)
    && recentProviderCoverage >= 0.65
    && recentProviderGap <= 2;

  if (providerHealthy) return 'provider';

  if (timeframe && !TICK_VOLUME_FALLBACK_TIMEFRAMES.includes(timeframe)) return 'unavailable';

  // Tick volume is only trustworthy when it is recent too. Persisted tick
  // history can contain an old healthy block followed by a long server/feed
  // gap; selecting tick mode from any historical positive value produces the
  // same misleading "old bars + one live spike" pattern as broken provider
  // volume. Allow tick mode after a small, contiguous recent run so it can
  // recover quickly after a restart without waiting for the entire window.
  const recentTickWindow = usable.slice(-8);
  const recentTickPositive = recentTickWindow.filter(bar => positiveNumber(bar.tickCount) != null).length;
  const trailingTickRun = trailingPositiveRun(recentTickWindow, bar => bar.tickCount);
  const minimumRecoveryRun = Math.min(3, recentTickWindow.length);
  const tickHealthy = tickPositive >= minimumRecoveryRun
    && recentTickPositive >= minimumRecoveryRun
    && trailingTickRun >= minimumRecoveryRun;

  if (tickHealthy) return 'tick';
  return 'unavailable';
}

function applyVolumeMode(bars, mode) {
  return bars.map(bar => serializeCandle({ ...bar, volumeMode: mode }));
}

class MarketHistoryService {
  constructor({
    adapter,
    instrumentRegistry,
    persistTimeframes: _persistTimeframes = [],
    historyCache = new ProviderHistoryCache(),
    logger,
  }) {
    this.adapter = adapter;
    this.instrumentRegistry = instrumentRegistry;
    this.historyCache = historyCache;
    this.logger = logger;
  }

  async getCandles({ symbol, timeframe, limit = 160 }) {
    const canonical = normalizeSymbol(symbol);
    const safeLimit = clampInteger(limit, 1, 1000, 160);
    const rows = await this.#loadLocal(canonical, timeframe, safeLimit);
    const localByOpenTime = new Map(rows.map(row => [new Date(row.openTime).getTime(), row]));

    if (this.adapter.supportsHistory(timeframe)) {
      try {
        const providerSymbol = this.instrumentRegistry.providerSymbol(canonical);
        const providerBars = await this.historyCache.getOrLoad({
          key: `${providerSymbol}:${timeframe}`,
          timeframe,
          limit: safeLimit,
          load: () => this.adapter.fetchHistorical({ providerSymbol, timeframe, limit: safeLimit }),
        });
        if (providerBars.length) {
          // Provider history is authoritative chart data, not durable ACG state.
          // Return it directly and keep MongoDB reserved for locally observed
          // live candles/tick metadata. This prevents chart reads from growing
          // the candle collection while preserving identical chart output.
          return this.#serializeProviderBars(canonical, timeframe, providerBars, safeLimit, localByOpenTime);
        }
      } catch (error) {
        this.logger.warn({ err: error, symbol: canonical, timeframe }, 'Historical provider reconciliation failed');
        if (!rows.length) {
          throw new AppError('Market history is temporarily unavailable', {
            statusCode: 502,
            code: 'MARKET_HISTORY_UNAVAILABLE',
          });
        }
      }
    }

    const localBars = rows.reverse();
    return applyVolumeMode(localBars, chooseVolumeMode(localBars, timeframe));
  }

  #serializeProviderBars(symbol, timeframe, bars, limit, localByOpenTime) {
    const stepMs = TIMEFRAME_MS[timeframe];
    const now = Date.now();
    const merged = bars.slice(-limit).map(bar => {
      const local = localByOpenTime.get(Number(bar.openTimeMs));
      return {
        symbol,
        timeframe,
        openTimeMs: bar.openTimeMs,
        closeTimeMs: bar.openTimeMs + stepMs,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        tickCount: Number(local?.tickCount || 0),
        providerVolume: bar.providerVolume,
        complete: bar.openTimeMs + stepMs <= now,
        synthetic: false,
        source: bar.canonicalUtc ? 'CANONICAL_BACKFILL' : 'BACKFILL',
        provider: 'twelve-data',
      };
    });
    return applyVolumeMode(merged, chooseVolumeMode(merged, timeframe));
  }

  cacheStats() {
    return this.historyCache.stats();
  }

  async #loadLocal(symbol, timeframe, limit) {
    const filter = { symbol, timeframe, synthetic: mongoose.trusted({ $ne: true }) };
    if (CANONICAL_UTC_HISTORY_SOURCE[timeframe]) {
      filter.source = mongoose.trusted({ $in: ['LIVE', 'CANONICAL_BACKFILL'] });
    }
    return Candle.find(filter).sort({ openTime: -1 }).limit(limit).lean();
  }

}

module.exports = { MarketHistoryService, chooseVolumeMode };
