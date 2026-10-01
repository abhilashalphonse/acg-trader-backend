'use strict';

const { Candle } = require('./candle.model');
const {
  TIMEFRAME_MS,
  candleBucketOpenTimeMs,
  TICK_VOLUME_FALLBACK_TIMEFRAMES,
} = require('./market.constants');
const { normalizeSymbol, resolveCandleVolume, serializeCandle } = require('./market.utils');
const { candleExpiresAt } = require('./candle-retention');
const { isInstrumentSessionOpen, sessionAlignedBucketOpenTimeMs } = require('../instruments/session-calendar');

// Synthetic continuity is intentionally limited to short intraday charts.
// H1/H4/D1/W1 must represent real provider/tick OHLC only.
const DEFAULT_SYNTHETIC_TIMEFRAMES = Object.freeze(['1s', '5s', '15s', '30s', '1m', '5m', '15m', '30m']);

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
    instrumentRegistry = null,
    syntheticTimeframes = DEFAULT_SYNTHETIC_TIMEFRAMES,
    persistCandle = persistCandleToMongo,
  }) {
    this.eventBus = eventBus;
    this.timeframes = timeframes;
    this.persistTimeframes = new Set(persistTimeframes);
    this.flushIntervalMs = flushIntervalMs;
    this.maxSyntheticGapBars = maxSyntheticGapBars;
    this.logger = logger;
    this.instrumentRegistry = instrumentRegistry;
    this.syntheticTimeframes = new Set(syntheticTimeframes || []);
    this.persistCandle = persistCandle;
    this.states = new Map();
    this.pendingWrites = new Set();
    this.flushTimer = null;
    this.symbolFeedLive = new Map();
    this.continuityBroken = new Set();
    this.hydrationEpoch = 0;
    this.hydrationOrdinal = 0;
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
    const chartPrice = [tick.price, tick.referencePrice, tick.mid, tick.bid]
      .filter(value => value !== null && value !== undefined && value !== '')
      .map(Number)
      .find(value => Number.isFinite(value) && value > 0);
    if (!Number.isFinite(chartPrice)) return;

    const symbol = normalizeSymbol(tick.symbol);
    const continuityBroken = this.continuityBroken.has(symbol);
    this.symbolFeedLive.set(symbol, true);

    for (const timeframe of this.timeframes) {
      this.#processTickForTimeframe(tick, chartPrice, symbol, timeframe, { continuityBroken });
    }

    this.continuityBroken.delete(symbol);
  }

  #processTickForTimeframe(tick, chartPrice, symbol, timeframe, {
    bypassHydration = false,
    continuityBroken = false,
    suppressProviderVolumeForBucket = null,
    emit = true,
  } = {}) {
    const stepMs = TIMEFRAME_MS[timeframe];
    if (!stepMs) return;

    const instrument = this.instrumentRegistry?.get?.(symbol) || null;
    const useSessionAnchor = instrument?.provider === 'accelpix'
      && !['1d', '1w'].includes(timeframe);
    const bucket = useSessionAnchor
      ? sessionAlignedBucketOpenTimeMs(instrument, tick.timeMs, stepMs)
      : candleBucketOpenTimeMs(tick.timeMs, timeframe);
    if (!Number.isFinite(bucket)) return;

    const state = this.#state(symbol, timeframe);
    if (state.hydration && !bypassHydration) {
      state.hydration.buffered.push({
        tick: { ...tick },
        chartPrice,
        symbol,
        timeframe,
        continuityBroken,
      });
      return;
    }

    // Completed bars are immutable on the live path. A late tick for an
    // already-finalized bucket must never create a new one-tick fragment.
    if (state.lastClosedOpenTimeMs != null && bucket <= state.lastClosedOpenTimeMs) return;
    if (state.current && bucket < state.current.openTimeMs) return;

    const eventSequence = this.#eventSequence(state, tick);
    const suppressProviderVolume = Number(suppressProviderVolumeForBucket) === bucket;
    const providerVolumeDelta = this.#providerVolumeDelta(
      state,
      tick.dayVolume,
      tick.timeMs,
      eventSequence,
      suppressProviderVolume,
    );

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
        candle.firstEventTimeMs = tick.timeMs;
        candle.firstEventSequence = eventSequence;
        candle.lastEventTimeMs = tick.timeMs;
        candle.lastEventSequence = eventSequence;
      } else {
        candle.high = Math.max(candle.high, chartPrice);
        candle.low = Math.min(candle.low, chartPrice);

        if (this.#isEarlierEvent(
          tick.timeMs,
          eventSequence,
          candle.firstEventTimeMs,
          candle.firstEventSequence,
        )) {
          candle.open = chartPrice;
          candle.firstEventTimeMs = tick.timeMs;
          candle.firstEventSequence = eventSequence;
        }
        if (this.#isLaterEvent(
          tick.timeMs,
          eventSequence,
          candle.lastEventTimeMs,
          candle.lastEventSequence,
        )) {
          candle.close = chartPrice;
          candle.lastEventTimeMs = tick.timeMs;
          candle.lastEventSequence = eventSequence;
        }

        candle.tickCount += 1;
        if (providerVolumeDelta != null) {
          candle.providerVolume = Number(candle.providerVolume || 0) + providerVolumeDelta;
        }
        candle.provider = tick.source || candle.provider;
      }
      if (emit) this.#emitUpdate(candle);
      return;
    }

    if (state.current && bucket > state.current.openTimeMs) {
      this.#closeCurrent(state);
    }

    if (!continuityBroken) this.#fillShortGap(state, symbol, timeframe, stepMs, bucket);
    state.current = this.#fromTick(
      symbol,
      timeframe,
      stepMs,
      bucket,
      tick,
      chartPrice,
      providerVolumeDelta,
      eventSequence,
    );
    state.current.volumeMode = state.volumeMode;
    state.historyHydratedOpenTimeMs = null;
    if (emit) this.#emitUpdate(state.current);
  }

  flushExpired(nowMs) {
    for (const state of this.states.values()) {
      const stepMs = TIMEFRAME_MS[state.timeframe];
      if (!stepMs) continue;

      let safety = 0;
      while (state.current && nowMs >= state.current.closeTimeMs && safety <= this.maxSyntheticGapBars + 1) {
        this.#closeCurrent(state);
        safety += 1;

        const nextOpenTimeMs = state.lastClosedOpenTimeMs + stepMs;
        if (nextOpenTimeMs > nowMs) break;
        if (!this.#canCreateLiveSynthetic(state.symbol, state, nextOpenTimeMs)) break;

        state.current = this.#syntheticCurrent(state.symbol, state.timeframe, stepMs, nextOpenTimeMs, state.lastClose);
        this.#emitUpdate(state.current);
      }
    }
  }

  getCurrent(symbol, timeframe) {
    const state = this.states.get(this.#key(normalizeSymbol(symbol), timeframe));
    return state?.current ? serializeCandle(state.current) : null;
  }

  getLastClosed(symbol, timeframe) {
    const state = this.states.get(this.#key(normalizeSymbol(symbol), timeframe));
    return state?.lastClosedCandle ? serializeCandle(state.lastClosedCandle) : null;
  }

  beginHydration(symbol, timeframe) {
    const canonical = normalizeSymbol(symbol);
    const state = this.#state(canonical, timeframe);

    if (
      state.current
      && state.historyHydratedOpenTimeMs === state.current.openTimeMs
      && !state.hydration
    ) {
      return Object.freeze({
        symbol: canonical,
        timeframe,
        id: null,
        epoch: this.hydrationEpoch,
        owner: false,
        skipped: true,
      });
    }

    if (state.hydration) {
      return Object.freeze({
        symbol: canonical,
        timeframe,
        id: state.hydration.id,
        epoch: state.hydration.epoch,
        owner: false,
        skipped: false,
      });
    }

    let resolveDone;
    const done = new Promise(resolve => { resolveDone = resolve; });
    const hydration = {
      id: ++this.hydrationOrdinal,
      epoch: this.hydrationEpoch,
      buffered: [],
      resolveDone,
      done,
    };
    state.hydration = hydration;

    return Object.freeze({
      symbol: canonical,
      timeframe,
      id: hydration.id,
      epoch: hydration.epoch,
      owner: true,
      skipped: false,
    });
  }

  async waitForHydration(token) {
    if (!token || token.skipped) return;
    const state = this.states.get(this.#key(normalizeSymbol(token.symbol), token.timeframe));
    if (!state?.hydration || state.hydration.id !== token.id) return;
    await state.hydration.done;
  }

  completeHydration(token, historyBar) {
    const state = this.#hydrationState(token);
    if (!state) return this.getCurrent(token?.symbol, token?.timeframe);
    const hydration = state.hydration;

    if (token.epoch !== this.hydrationEpoch || hydration.epoch !== this.hydrationEpoch) {
      this.#abortHydrationState(state, { replay: true });
      return this.getCurrent(token.symbol, token.timeframe);
    }

    const historyOpenTimeMs = Number(historyBar?.openTimeMs);
    const historyCloseTimeMs = Number(historyBar?.closeTimeMs);
    const historyIsActive = Number.isFinite(historyOpenTimeMs)
      && historyBar?.complete !== true
      && (!Number.isFinite(historyCloseTimeMs) || historyCloseTimeMs > Date.now());

    if (
      !historyIsActive
      || (state.lastClosedOpenTimeMs != null && historyOpenTimeMs <= state.lastClosedOpenTimeMs)
      || (state.current && state.current.openTimeMs > historyOpenTimeMs)
    ) {
      this.#abortHydrationState(state, { replay: true });
      return this.getCurrent(token.symbol, token.timeframe);
    }

    const existing = state.current?.openTimeMs === historyOpenTimeMs
      ? { ...state.current }
      : null;
    const numeric = value => {
      const number = Number(value);
      return Number.isFinite(number) ? number : null;
    };
    const historyOpen = numeric(historyBar?.open);
    const historyHigh = numeric(historyBar?.high);
    const historyLow = numeric(historyBar?.low);
    const historyClose = numeric(historyBar?.close);
    if (![historyOpen, historyHigh, historyLow, historyClose].every(Number.isFinite)) {
      this.#abortHydrationState(state, { replay: true });
      return this.getCurrent(token.symbol, token.timeframe);
    }

    const existingDisplay = existing ? resolveCandleVolume(existing, existing.volumeMode || state.volumeMode).displayVolume : null;
    const historyDisplay = numeric(historyBar?.displayVolume ?? historyBar?.providerVolume);
    const providerBaseline = [existingDisplay, historyDisplay]
      .filter(value => Number.isFinite(value) && value >= 0)
      .reduce((max, value) => Math.max(max, value), -Infinity);
    const existingProviderVolume = numeric(existing?.providerVolume) ?? 0;
    const volumeMode = historyBar?.volumeMode || existing?.volumeMode || state.volumeMode || null;

    const highs = [historyHigh, historyOpen, historyClose, numeric(existing?.high), numeric(existing?.open), numeric(existing?.close)].filter(Number.isFinite);
    const lows = [historyLow, historyOpen, historyClose, numeric(existing?.low), numeric(existing?.open), numeric(existing?.close)].filter(Number.isFinite);

    state.current = {
      symbol: normalizeSymbol(token.symbol),
      timeframe: token.timeframe,
      openTimeMs: historyOpenTimeMs,
      closeTimeMs: Number.isFinite(historyCloseTimeMs)
        ? historyCloseTimeMs
        : historyOpenTimeMs + (TIMEFRAME_MS[token.timeframe] || 0),
      open: historyOpen,
      high: Math.max(...highs),
      low: Math.min(...lows),
      // Never let a delayed provider snapshot roll back a live close already
      // observed before hydration started.
      close: numeric(existing?.close) ?? historyClose,
      tickCount: Math.max(Number(historyBar?.tickCount || 0), Number(existing?.tickCount || 0)),
      providerVolume: existingProviderVolume,
      complete: false,
      synthetic: false,
      source: 'HYDRATED',
      provider: existing?.provider || historyBar?.provider || null,
      volumeMode,
      firstEventTimeMs: existing?.firstEventTimeMs ?? historyOpenTimeMs,
      firstEventSequence: existing?.firstEventSequence ?? null,
      lastEventTimeMs: existing?.lastEventTimeMs ?? historyOpenTimeMs,
      lastEventSequence: existing?.lastEventSequence ?? null,
    };
    state.volumeMode = volumeMode;

    if (volumeMode === 'provider' && providerBaseline !== -Infinity) {
      state.current.providerVolumeBaseline = providerBaseline;
      state.current.providerVolumeLiveAnchor = existingProviderVolume;
    }

    const buffered = hydration.buffered
      .slice()
      .sort((a, b) => (a.tick.timeMs - b.tick.timeMs) || ((Number(a.tick.sequence) || 0) - (Number(b.tick.sequence) || 0)));
    state.hydration = null;
    state.historyHydratedOpenTimeMs = historyOpenTimeMs;

    for (const item of buffered) {
      this.#processTickForTimeframe(item.tick, item.chartPrice, item.symbol, item.timeframe, {
        bypassHydration: true,
        continuityBroken: item.continuityBroken,
        suppressProviderVolumeForBucket: historyOpenTimeMs,
        emit: false,
      });
    }

    if (state.current) this.#emitUpdate(state.current);
    hydration.resolveDone?.();
    return this.getCurrent(token.symbol, token.timeframe);
  }

  abortHydration(token) {
    const state = this.#hydrationState(token);
    if (!state) return;
    this.#abortHydrationState(state, { replay: true });
  }

  invalidateHydration() {
    this.hydrationEpoch += 1;
    for (const state of this.states.values()) {
      state.historyHydratedOpenTimeMs = null;
    }
  }

  setVolumeMode(symbol, timeframe, mode) {
    const normalizedMode = ['provider', 'tick', 'unavailable'].includes(mode) ? mode : null;
    const state = this.#state(normalizeSymbol(symbol), timeframe);
    state.volumeMode = normalizedMode;
    if (normalizedMode !== 'unavailable') state.consecutiveTickVolumeBars = 0;

    if (state.current) {
      state.current.volumeMode = normalizedMode;
      if (normalizedMode !== 'provider') {
        delete state.current.providerVolumeBaseline;
        delete state.current.providerVolumeLiveAnchor;
      }
    }
  }

  reconcileCurrentVolume(symbol, timeframe, historyBar) {
    const state = this.states.get(this.#key(normalizeSymbol(symbol), timeframe));
    if (!state?.current || !historyBar || Number(historyBar.openTimeMs) !== Number(state.current.openTimeMs)) return;

    const mode = ['provider', 'tick', 'unavailable'].includes(historyBar.volumeMode)
      ? historyBar.volumeMode
      : null;
    this.setVolumeMode(symbol, timeframe, mode);

    if (mode !== 'provider') return;

    const baseline = Number(historyBar.displayVolume ?? historyBar.providerVolume);
    const liveAnchor = Number(state.current.providerVolume);
    const currentDisplay = Number(resolveCandleVolume(state.current, 'provider').displayVolume);
    const monotonicBaseline = [baseline, currentDisplay]
      .filter(value => Number.isFinite(value) && value >= 0)
      .reduce((max, value) => Math.max(max, value), -Infinity);
    if (monotonicBaseline !== -Infinity && Number.isFinite(liveAnchor) && liveAnchor >= 0) {
      if (state.current.providerVolumeBaseline == null) {
        state.current.providerVolumeBaseline = monotonicBaseline;
        state.current.providerVolumeLiveAnchor = liveAnchor;
      } else if (monotonicBaseline > Number(state.current.providerVolumeBaseline)) {
        state.current.providerVolumeBaseline = monotonicBaseline;
        state.current.providerVolumeLiveAnchor = liveAnchor;
      }
    }
  }

  #hydrationState(token) {
    if (!token?.symbol || !token?.timeframe || token.id == null) return null;
    const state = this.states.get(this.#key(normalizeSymbol(token.symbol), token.timeframe));
    if (!state?.hydration || state.hydration.id !== token.id) return null;
    return state;
  }

  #abortHydrationState(state, { replay = true } = {}) {
    const hydration = state?.hydration;
    if (!hydration) return;

    const buffered = hydration.buffered
      .slice()
      .sort((a, b) => (a.tick.timeMs - b.tick.timeMs) || ((Number(a.tick.sequence) || 0) - (Number(b.tick.sequence) || 0)));
    state.hydration = null;

    if (replay) {
      for (const item of buffered) {
        this.#processTickForTimeframe(item.tick, item.chartPrice, item.symbol, item.timeframe, {
          bypassHydration: true,
          continuityBroken: item.continuityBroken,
        });
      }
    }

    hydration.resolveDone?.();
  }

  #touchState(state, candle = state?.current) {
    if (!state || !candle) return;
    state.revision += 1;
    candle.stateVersion = state.revision;
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
        lastClosedCandle: null,
        revision: 0,
        hydration: null,
        historyHydratedOpenTimeMs: null,
        consecutiveSyntheticClosed: 0,
        lastProviderDayVolume: null,
        lastProviderVolumeEventTimeMs: null,
        lastProviderVolumeEventSequence: null,
        eventOrdinal: 0,
        volumeMode: null,
        consecutiveTickVolumeBars: 0,
      });
    }
    return this.states.get(key);
  }

  #key(symbol, timeframe) {
    return `${symbol}:${timeframe}`;
  }

  #fromTick(
    symbol,
    timeframe,
    stepMs,
    bucket,
    tick,
    chartPrice,
    providerVolume = null,
    eventSequence = null,
  ) {
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
      firstEventTimeMs: tick.timeMs,
      firstEventSequence: eventSequence,
      lastEventTimeMs: tick.timeMs,
      lastEventSequence: eventSequence,
    };
  }

  #eventSequence(state, tick) {
    const provided = Number(tick?.sequence);
    if (Number.isFinite(provided)) {
      state.eventOrdinal = Math.max(state.eventOrdinal, provided);
      return provided;
    }
    state.eventOrdinal += 1;
    return state.eventOrdinal;
  }

  #isEarlierEvent(timeMs, sequence, anchorTimeMs, anchorSequence) {
    if (!Number.isFinite(anchorTimeMs)) return true;
    if (timeMs !== anchorTimeMs) return timeMs < anchorTimeMs;
    if (!Number.isFinite(anchorSequence)) return true;
    return sequence < anchorSequence;
  }

  #isLaterEvent(timeMs, sequence, anchorTimeMs, anchorSequence) {
    if (!Number.isFinite(anchorTimeMs)) return true;
    if (timeMs !== anchorTimeMs) return timeMs > anchorTimeMs;
    if (!Number.isFinite(anchorSequence)) return true;
    return sequence > anchorSequence;
  }

  #providerVolumeDelta(state, rawDayVolume, eventTimeMs, eventSequence, suppressDelta = false) {
    if (rawDayVolume === null || rawDayVolume === undefined || rawDayVolume === '') {
      return null;
    }
    const dayVolume = Number(rawDayVolume);
    if (!Number.isFinite(dayVolume) || dayVolume < 0) {
      return null;
    }

    // Cumulative volume is monotonic in event time. A reordered older tick may
    // still contribute to OHLC range/open, but it must not move the cumulative
    // volume anchor backward and inflate the next accepted delta.
    if (
      Number.isFinite(state.lastProviderVolumeEventTimeMs)
      && this.#isEarlierEvent(
        eventTimeMs,
        eventSequence,
        state.lastProviderVolumeEventTimeMs,
        state.lastProviderVolumeEventSequence,
      )
    ) {
      return null;
    }

    const previous = state.lastProviderDayVolume;
    state.lastProviderDayVolume = dayVolume;
    state.lastProviderVolumeEventTimeMs = eventTimeMs;
    state.lastProviderVolumeEventSequence = eventSequence;
    if (suppressDelta || !Number.isFinite(previous) || dayVolume < previous) return null;
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
    if (!this.syntheticTimeframes.has(timeframe)) return;
    if (state.lastClosedOpenTimeMs == null || state.lastClose == null) return;
    const firstMissing = state.lastClosedOpenTimeMs + stepMs;
    if (targetBucket <= firstMissing) return;
    const missingBars = Math.floor((targetBucket - firstMissing) / stepMs);
    if (missingBars <= 0 || missingBars > this.maxSyntheticGapBars) return;

    for (let index = 0; index < missingBars; index += 1) {
      const openTimeMs = firstMissing + index * stepMs;
      if (!this.#syntheticSessionOpen(symbol, timeframe, openTimeMs)) continue;
      const synthetic = {
        ...this.#syntheticCurrent(symbol, timeframe, stepMs, openTimeMs, state.lastClose),
        complete: true,
      };
      this.#finalizeClosed(state, synthetic);
    }
  }

  #canCreateLiveSynthetic(symbol, state, openTimeMs) {
    return this.symbolFeedLive.get(symbol) === true
      && !this.continuityBroken.has(symbol)
      && state.lastClose != null
      && state.lastClosedOpenTimeMs != null
      && state.consecutiveSyntheticClosed < this.maxSyntheticGapBars
      && this.#syntheticSessionOpen(symbol, state.timeframe, openTimeMs);
  }

  #syntheticSessionOpen(symbol, timeframe, openTimeMs) {
    if (!this.syntheticTimeframes.has(timeframe) || this.maxSyntheticGapBars <= 0) return false;

    // Never fabricate continuity for an unconfigured instrument because there
    // is no authoritative session calendar to distinguish quiet trading from
    // a closed market.
    const instrument = this.instrumentRegistry?.get?.(symbol);
    if (!instrument?.configured) return false;

    try {
      return isInstrumentSessionOpen(instrument, openTimeMs);
    } catch (error) {
      this.logger?.warn?.({ err: error, symbol, timeframe, openTimeMs }, 'Synthetic candle session check failed');
      return false;
    }
  }

  #closeCurrent(state) {
    if (!state.current) return;
    const candle = { ...state.current, complete: true };
    const resolvedVolume = resolveCandleVolume(candle, candle.volumeMode || state.volumeMode);
    if (resolvedVolume.volumeSource === 'provider' && resolvedVolume.displayVolume != null) {
      candle.providerVolume = resolvedVolume.displayVolume;
    }
    delete candle.providerVolumeBaseline;
    delete candle.providerVolumeLiveAnchor;
    state.current = null;
    this.#finalizeClosed(state, candle);
  }

  #finalizeClosed(state, candle) {
    this.#observeClosedVolume(state, candle);
    this.#touchState(state, candle);
    state.lastClose = candle.close;
    state.lastClosedOpenTimeMs = candle.openTimeMs;
    state.lastClosedCandle = { ...candle };
    state.historyHydratedOpenTimeMs = state.historyHydratedOpenTimeMs === candle.openTimeMs
      ? null
      : state.historyHydratedOpenTimeMs;
    state.consecutiveSyntheticClosed = candle.synthetic ? state.consecutiveSyntheticClosed + 1 : 0;
    const publicCandle = serializeCandle(candle);
    this.eventBus.emit('market.candle.closed', publicCandle);

    // Synthetic carry-forward bars are display continuity only. Persisting
    // them turns a temporary no-tick interval into fake durable market history.
    if (!candle.synthetic && this.persistTimeframes.has(candle.timeframe)) {
      const write = Promise.resolve(this.persistCandle(candle))
        .catch(error => this.logger.error({ err: error, symbol: candle.symbol, timeframe: candle.timeframe }, 'Failed to persist closed market candle'))
        .finally(() => this.pendingWrites.delete(write));
      this.pendingWrites.add(write);
    }
  }

  #observeClosedVolume(state, candle) {
    const hasTickActivity = !candle.synthetic && Number(candle.tickCount) > 0;
    state.consecutiveTickVolumeBars = hasTickActivity
      ? state.consecutiveTickVolumeBars + 1
      : 0;

    // When REST history could not establish a trustworthy provider/tick series,
    // recover on the existing websocket path after three contiguous real
    // completed candles. Tick count is the safest live fallback because it is
    // generated from the same canonical ticks that built the candles.
    if (TICK_VOLUME_FALLBACK_TIMEFRAMES.includes(candle.timeframe)
      && (state.volumeMode == null || state.volumeMode === 'unavailable')
      && state.consecutiveTickVolumeBars >= 3) {
      state.volumeMode = 'tick';
    }

    candle.volumeMode = state.volumeMode;
  }

  #emitUpdate(candle) {
    const state = this.states.get(this.#key(normalizeSymbol(candle.symbol), candle.timeframe));
    this.#touchState(state, candle);
    this.eventBus.emit('market.candle.update', serializeCandle(candle));
  }
}

module.exports = { CandleEngine, persistCandleToMongo };
