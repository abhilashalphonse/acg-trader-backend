'use strict';

const { Candle } = require('./candle.model');
const { TIMEFRAME_MS } = require('./market.constants');
const { normalizeSymbol, serializeCandle, clampInteger } = require('./market.utils');
const { AppError } = require('../../shared/errors/app-error');
const { candleExpiresAt } = require('./candle-retention');

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

function chooseVolumeMode(bars) {
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

  // Tick volume is only trustworthy when it is recent too. Persisted tick
  // history can contain an old healthy block followed by a long server/feed
  // gap; selecting tick mode from any historical positive value produces the
  // same misleading "old bars + one live spike" pattern as broken provider
  // volume. Allow tick mode after a small, contiguous recent run so it can
  // recover quickly after a restart without waiting for the entire window.
  const recentTickWindow = usable.slice(-8);
  const recentTickPositive = recentTickWindow.filter(bar => positiveNumber(bar.tickCount) != null).length;
  const recentTickCoverage = recentTickPositive / recentTickWindow.length;
  const trailingTickRun = trailingPositiveRun(recentTickWindow, bar => bar.tickCount);
  const tickHealthy = tickPositive >= 3
    && recentTickPositive >= Math.min(3, recentTickWindow.length)
    && recentTickCoverage >= 0.5
    && trailingTickRun >= Math.min(3, recentTickWindow.length);

  if (tickHealthy) return 'tick';
  return 'unavailable';
}

function applyVolumeMode(bars, mode) {
  return bars.map(bar => serializeCandle({ ...bar, volumeMode: mode }));
}

class MarketHistoryService {
  constructor({ adapter, instrumentRegistry, persistTimeframes = [], logger }) {
    this.adapter = adapter;
    this.instrumentRegistry = instrumentRegistry;
    this.persistTimeframes = new Set(persistTimeframes);
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
        const providerBars = await this.adapter.fetchHistorical({ providerSymbol, timeframe, limit: safeLimit });
        if (providerBars.length) {
          if (this.persistTimeframes.has(timeframe)) {
            await this.#persistBackfill(canonical, timeframe, providerBars);
          }
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
    return applyVolumeMode(localBars, chooseVolumeMode(localBars));
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
        source: 'BACKFILL',
        provider: 'twelve-data',
      };
    });
    return applyVolumeMode(merged, chooseVolumeMode(merged));
  }

  async #loadLocal(symbol, timeframe, limit) {
    return Candle.find({ symbol, timeframe })
      .sort({ openTime: -1 })
      .limit(limit)
      .lean();
  }

  async #persistBackfill(symbol, timeframe, bars) {
    const stepMs = TIMEFRAME_MS[timeframe];
    if (!stepMs || !bars.length) return;

    const now = Date.now();
    const completedBars = bars.filter(bar => Number(bar.openTimeMs) + stepMs <= now);
    if (!completedBars.length) return;

    const operations = completedBars.map(bar => {
      const openTime = new Date(bar.openTimeMs);
      return {
        updateOne: {
          filter: { symbol, timeframe, openTime },
          update: {
            $set: {
              closeTime: new Date(bar.openTimeMs + stepMs),
              open: String(bar.open),
              high: String(bar.high),
              low: String(bar.low),
              close: String(bar.close),
              providerVolume: bar.providerVolume == null ? null : String(bar.providerVolume),
              complete: true,
              synthetic: false,
              source: 'BACKFILL',
              provider: 'twelve-data',
              expiresAt: candleExpiresAt(timeframe, bar.openTimeMs),
            },
            $setOnInsert: { symbol, timeframe, openTime, tickCount: 0 },
          },
          upsert: true,
        },
      };
    });

    await Candle.bulkWrite(operations, { ordered: false });
  }
}

module.exports = { MarketHistoryService, chooseVolumeMode };
