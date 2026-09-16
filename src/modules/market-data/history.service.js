'use strict';

const { Candle } = require('./candle.model');
const { TIMEFRAME_MS } = require('./market.constants');
const { normalizeSymbol, serializeCandle, clampInteger } = require('./market.utils');
const { AppError } = require('../../shared/errors/app-error');

class MarketHistoryService {
  constructor({ adapter, instrumentRegistry, logger }) {
    this.adapter = adapter;
    this.instrumentRegistry = instrumentRegistry;
    this.logger = logger;
  }

  async getCandles({ symbol, timeframe, limit = 160 }) {
    const canonical = normalizeSymbol(symbol);
    const safeLimit = clampInteger(limit, 1, 1000, 160);
    let rows = await this.#loadLocal(canonical, timeframe, safeLimit);

    if (rows.length < safeLimit && this.adapter.supportsHistory(timeframe)) {
      try {
        const providerSymbol = this.instrumentRegistry.providerSymbol(canonical);
        const providerBars = await this.adapter.fetchHistorical({ providerSymbol, timeframe, limit: safeLimit });
        if (providerBars.length) {
          await this.#persistBackfill(canonical, timeframe, providerBars);
          rows = await this.#loadLocal(canonical, timeframe, safeLimit);
        }
      } catch (error) {
        this.logger.warn({ err: error, symbol: canonical, timeframe }, 'Historical provider backfill failed');
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

  async #loadLocal(symbol, timeframe, limit) {
    return Candle.find({ symbol, timeframe })
      .sort({ openTime: -1 })
      .limit(limit)
      .lean();
  }

  async #persistBackfill(symbol, timeframe, bars) {
    const stepMs = TIMEFRAME_MS[timeframe];
    if (!stepMs || !bars.length) return;

    const operations = bars.map(bar => {
      const openTime = new Date(bar.openTimeMs);
      return {
        updateOne: {
          filter: { symbol, timeframe, openTime },
          update: {
            $setOnInsert: {
              symbol,
              timeframe,
              openTime,
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
            },
          },
          upsert: true,
        },
      };
    });

    await Candle.bulkWrite(operations, { ordered: false });
  }
}

module.exports = { MarketHistoryService };
