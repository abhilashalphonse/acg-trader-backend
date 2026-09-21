'use strict';

const { Candle } = require('./candle.model');
const { TIMEFRAME_MS } = require('./market.constants');
const { normalizeSymbol, serializeCandle } = require('./market.utils');
const { candleExpiresAt } = require('./candle-retention');

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
        expiresAt: candleExpiresAt(candle.timeframe, candle.openTimeMs),
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
    this.symbolFeedLive = new Map();
    this.continuityBroken = new Set();
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

  setSymbolLive(symbol, live) {
    const canonical = normalizeSymbol(symbol);
    const previous = this.symbolFeedLive.get(canonical) === true;
    this.symbolFeedLive.set(canonical, live === true);
    if (previous && live !== true) this.continuityBroken.add(canonical);
  }

  processTick(tick) {
    if (!tick || !Number.isFinite(tick.timeMs)) return;
    const chartPrice = Number.isFinite(tick.bid) ? tick.bid : tick.price;
    if (!Number.isFinite(chartPrice)) return;
    const symbol = normalizeSymbol(tick.symbol);
    const continuityBroken = this.continuityBroken.has(symbol);
    this.symbolFeedLive.set(symbol, true);

    for (const timeframe of this.timeframes) {
      const stepMs = TIMEFRAME_MS[timeframe];
      if (!stepMs) continue;
      const bucket = Math.floor(tick.timeMs / stepMs) * stepMs;
      const state = this.#state(symbol, timeframe);
      const providerVolumeDelta = this.#providerVolumeDelta(state, tick.dayVolume);

      if (state.current && bucket < state.current.openTimeMs) continue;

      if (state.current && bucket === state.current.openTimeMs) {
        const candle = state.current;
        if (candle.synthetic && candle.tickCount === 0) {
          candle.open = chartPrice;
          candle.high = chartPrice;
          candle.low = chartPrice;
          candle.close = chartPrice;
          candle.tickCount = 1;
          candle.providerVolume = providerVolumeDelta;
          candle.synthetic = false;
          candle.source = 'LIVE';
          candle.provider = tick.source || null;
        } else {
          candle.high = Math.max(candle.high, chartPrice);
          candle.low = Math.min(candle.low, chartPrice);
          candle.close = chartPrice;
          candle.tickCount += 1;
          if (providerVolumeDelta != null) {
            candle.providerVolume = Number(candle.providerVolume || 0) + providerVolumeDelta;
          }
          candle.provider = tick.source || candle.provider;
        }
        this.#emitUpdate(candle);
        continue;
      }

      if (state.current && bucket > state.current.openTimeMs) {
        this.#closeCurrent(state);
      }

      if (!continuityBroken) this.#fillShortGap(state, symbol, timeframe, stepMs, bucket);
      state.current = this.#fromTick(symbol, timeframe, stepMs, bucket, tick, chartPrice, providerVolumeDelta);
      this.#emitUpdate(state.current);
    }

    this.continuityBroken.delete(symbol);
  }

  flushExpired(nowMs) {
    for (const state of this.states.values()) {
      const stepMs = TIMEFRAME_MS[state.timeframe];
      if (!stepMs) continue;

      let safety = 0;
      while (state.current && nowMs >= state.current.closeTimeMs && safety <= this.maxSyntheticGapBars + 1) {
        this.#closeCurrent(state);
        safety += 1;

        if (!this.#canCreateLiveSynthetic(state.symbol, state)) break;
        const nextOpenTimeMs = state.lastClosedOpenTimeMs + stepMs;
        if (nextOpenTimeMs > nowMs) break;

        state.current = this.#syntheticCurrent(state.symbol, state.timeframe, stepMs, nextOpenTimeMs, state.lastClose);
        this.#emitUpdate(state.current);
      }
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
        consecutiveSyntheticClosed: 0,
        lastProviderDayVolume: null,
      });
    }
    return this.states.get(key);
  }

  #key(symbol, timeframe) {
    return `${symbol}:${timeframe}`;
  }

  #fromTick(symbol, timeframe, stepMs, bucket, tick, chartPrice, providerVolume = null) {
    return {
      symbol,
      timeframe,
      openTimeMs: bucket,
      closeTimeMs: bucket + stepMs,
      open: chartPrice,
      high: chartPrice,
      low: chartPrice,
      close: chartPrice,
      tickCount: 1,
      providerVolume,
      complete: false,
      synthetic: false,
      source: 'LIVE',
      provider: tick.source || null,
    };
  }

  #providerVolumeDelta(state, rawDayVolume) {
    if (rawDayVolume === null || rawDayVolume === undefined || rawDayVolume === '') {
      state.lastProviderDayVolume = null;
      return null;
    }
    const dayVolume = Number(rawDayVolume);
    if (!Number.isFinite(dayVolume) || dayVolume < 0) {
      state.lastProviderDayVolume = null;
      return null;
    }

    const previous = state.lastProviderDayVolume;
    state.lastProviderDayVolume = dayVolume;
    if (!Number.isFinite(previous) || dayVolume < previous) return null;
    return dayVolume - previous;
  }

  #syntheticCurrent(symbol, timeframe, stepMs, openTimeMs, price) {
    return {
      symbol,
      timeframe,
      openTimeMs,
      closeTimeMs: openTimeMs + stepMs,
      open: price,
      high: price,
      low: price,
      close: price,
      tickCount: 0,
      providerVolume: null,
      complete: false,
      synthetic: true,
      source: 'SYNTHETIC',
      provider: null,
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
        ...this.#syntheticCurrent(symbol, timeframe, stepMs, openTimeMs, state.lastClose),
        complete: true,
      };
      this.#finalizeClosed(state, synthetic);
    }
  }

  #canCreateLiveSynthetic(symbol, state) {
    return this.symbolFeedLive.get(symbol) === true
      && !this.continuityBroken.has(symbol)
      && state.lastClose != null
      && state.lastClosedOpenTimeMs != null
      && state.consecutiveSyntheticClosed < this.maxSyntheticGapBars;
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
    state.consecutiveSyntheticClosed = candle.synthetic ? state.consecutiveSyntheticClosed + 1 : 0;
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
