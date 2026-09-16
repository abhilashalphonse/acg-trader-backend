'use strict';

const { Candle } = require('./candle.model');
const { TIMEFRAME_MS } = require('./market.constants');
const { normalizeSymbol, serializeCandle } = require('./market.utils');

async function persistCandleToMongo(candle) {
  const openTime = new Date(candle.openTimeMs);
  await Candle.updateOne(
    { symbol: candle.symbol, timeframe: candle.timeframe, openTime },
    {
      $set: {
        closeTime: new Date(candle.closeTimeMs),
        open: String(candle.open),
        high: String(candle.high),
        low: String(candle.low),
        close: String(candle.close),
        tickCount: candle.tickCount,
        providerVolume: candle.providerVolume == null ? null : String(candle.providerVolume),
        complete: true,
        synthetic: candle.synthetic,
        source: candle.source,
        provider: candle.provider || null,
      },
      $setOnInsert: { symbol: candle.symbol, timeframe: candle.timeframe, openTime },
    },
    { upsert: true },
  );
}

class CandleEngine {
  constructor({
    eventBus,
    timeframes,
    persistTimeframes,
    flushIntervalMs,
    maxSyntheticGapBars,
    logger,
    persistCandle = persistCandleToMongo,
  }) {
    this.eventBus = eventBus;
    this.timeframes = timeframes;
    this.persistTimeframes = new Set(persistTimeframes);
    this.flushIntervalMs = flushIntervalMs;
    this.maxSyntheticGapBars = maxSyntheticGapBars;
    this.logger = logger;
    this.persistCandle = persistCandle;
    this.states = new Map();
    this.pendingWrites = new Set();
    this.flushTimer = null;
  }

  start() {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flushExpired(Date.now()), this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  async stop() {
    clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.flushExpired(Date.now());
    await Promise.allSettled([...this.pendingWrites]);
  }

  processTick(tick) {
    if (!tick || !Number.isFinite(tick.price) || !Number.isFinite(tick.timeMs)) return;
    const symbol = normalizeSymbol(tick.symbol);

    for (const timeframe of this.timeframes) {
      const stepMs = TIMEFRAME_MS[timeframe];
      if (!stepMs) continue;
      const bucket = Math.floor(tick.timeMs / stepMs) * stepMs;
      const state = this.#state(symbol, timeframe);

      if (state.current && bucket < state.current.openTimeMs) continue;

      if (state.current && bucket === state.current.openTimeMs) {
        const candle = state.current;
        candle.high = Math.max(candle.high, tick.price);
        candle.low = Math.min(candle.low, tick.price);
        candle.close = tick.price;
        candle.tickCount += 1;
        candle.provider = tick.source || candle.provider;
        this.#emitUpdate(candle);
        continue;
      }

      if (state.current && bucket > state.current.openTimeMs) {
        this.#closeCurrent(state);
      }

      this.#fillShortGap(state, symbol, timeframe, stepMs, bucket);
      state.current = this.#fromTick(symbol, timeframe, stepMs, bucket, tick);
      this.#emitUpdate(state.current);
    }
  }

  flushExpired(nowMs) {
    for (const state of this.states.values()) {
      if (state.current && nowMs >= state.current.closeTimeMs) this.#closeCurrent(state);
    }
  }

  getCurrent(symbol, timeframe) {
    const state = this.states.get(this.#key(normalizeSymbol(symbol), timeframe));
    return state?.current ? serializeCandle(state.current) : null;
  }

  #state(symbol, timeframe) {
    const key = this.#key(symbol, timeframe);
    if (!this.states.has(key)) {
      this.states.set(key, {
        symbol,
        timeframe,
        current: null,
        lastClose: null,
        lastClosedOpenTimeMs: null,
      });
    }
    return this.states.get(key);
  }

  #key(symbol, timeframe) {
    return `${symbol}:${timeframe}`;
  }

  #fromTick(symbol, timeframe, stepMs, bucket, tick) {
    return {
      symbol,
      timeframe,
      openTimeMs: bucket,
      closeTimeMs: bucket + stepMs,
      open: tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      tickCount: 1,
      providerVolume: null,
      complete: false,
      synthetic: false,
      source: 'LIVE',
      provider: tick.source || null,
    };
  }

  #fillShortGap(state, symbol, timeframe, stepMs, targetBucket) {
    if (state.lastClosedOpenTimeMs == null || state.lastClose == null) return;
    const firstMissing = state.lastClosedOpenTimeMs + stepMs;
    if (targetBucket <= firstMissing) return;
    const missingBars = Math.floor((targetBucket - firstMissing) / stepMs);
    if (missingBars <= 0 || missingBars > this.maxSyntheticGapBars) return;

    for (let index = 0; index < missingBars; index += 1) {
      const openTimeMs = firstMissing + index * stepMs;
      const synthetic = {
        symbol,
        timeframe,
        openTimeMs,
        closeTimeMs: openTimeMs + stepMs,
        open: state.lastClose,
        high: state.lastClose,
        low: state.lastClose,
        close: state.lastClose,
        tickCount: 0,
        providerVolume: null,
        complete: true,
        synthetic: true,
        source: 'SYNTHETIC',
        provider: null,
      };
      this.#finalizeClosed(state, synthetic);
    }
  }

  #closeCurrent(state) {
    if (!state.current) return;
    const candle = { ...state.current, complete: true };
    state.current = null;
    this.#finalizeClosed(state, candle);
  }

  #finalizeClosed(state, candle) {
    state.lastClose = candle.close;
    state.lastClosedOpenTimeMs = candle.openTimeMs;
    const publicCandle = serializeCandle(candle);
    this.eventBus.emit('market.candle.closed', publicCandle);

    if (this.persistTimeframes.has(candle.timeframe)) {
      const write = Promise.resolve(this.persistCandle(candle))
        .catch(error => this.logger.error({ err: error, symbol: candle.symbol, timeframe: candle.timeframe }, 'Failed to persist closed market candle'))
        .finally(() => this.pendingWrites.delete(write));
      this.pendingWrites.add(write);
    }
  }

  #emitUpdate(candle) {
    this.eventBus.emit('market.candle.update', serializeCandle(candle));
  }
}

module.exports = { CandleEngine, persistCandleToMongo };
