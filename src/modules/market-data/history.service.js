'use strict';

const { Candle } = require('./candle.model');
const { TIMEFRAME_MS } = require('./market.constants');
const { normalizeSymbol, serializeCandle, clampInteger } = require('./market.utils');
const { AppError } = require('../../shared/errors/app-error');
const { candleExpiresAt } = require('./candle-retention');

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

    if (this.adapter.supportsHistory(timeframe)) {
      try {
        const providerSymbol = this.instrumentRegistry.providerSymbol(canonical);
        const providerBars = await this.adapter.fetchHistorical({ providerSymbol, timeframe, limit: safeLimit });
        if (providerBars.length) {
          if (this.persistTimeframes.has(timeframe)) {
            await this.#persistBackfill(canonical, timeframe, providerBars);
          }
          return this.#serializeProviderBars(canonical, timeframe, providerBars, safeLimit);
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

    return rows.reverse().map(serializeCandle);
  }

  #serializeProviderBars(symbol, timeframe, bars, limit) {
    const stepMs = TIMEFRAME_MS[timeframe];
    const now = Date.now();
    return bars.slice(-limit).map(bar => serializeCandle({
      symbol,
      timeframe,
      openTimeMs: bar.openTimeMs,
      closeTimeMs: bar.openTimeMs + stepMs,
      open: bar.open,
      high: bar.high,
      low: bar.low,
      close: bar.close,
      tickCount: 0,
      providerVolume: bar.providerVolume,
      complete: bar.openTimeMs + stepMs <= now,
      synthetic: false,
      source: 'BACKFILL',
      provider: 'twelve-data',
    }));
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
              tickCount: 0,
              providerVolume: bar.providerVolume == null ? null : String(bar.providerVolume),
              complete: true,
              synthetic: false,
              source: 'BACKFILL',
              provider: 'twelve-data',
              expiresAt: candleExpiresAt(timeframe, bar.openTimeMs),
            },
            $setOnInsert: { symbol, timeframe, openTime },
          },
          upsert: true,
        },
      };
    });

    await Candle.bulkWrite(operations, { ordered: false });
  }
}

module.exports = { MarketHistoryService };
