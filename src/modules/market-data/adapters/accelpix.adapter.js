'use strict';

const EventEmitter = require('events');
const { createAccelpixSignalRClient } = require('./accelpix-signalr.client');

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const LIVE_TIMESTAMP_TOLERANCE_MS = 10 * 60 * 1000;
const NSE_SESSION_OPEN_MINUTE = 9 * 60 + 15;
const INTRADAY_TIMEFRAME_MS = Object.freeze({
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
});

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number != null && number > 0 ? number : null;
}

function marketPrice(value) {
  const number = positiveNumber(value);
  return number == null ? null : Math.round(number * 10000) / 10000;
}

function nonNegativeNumber(value) {
  const number = finiteNumber(value);
  return number != null && number >= 0 ? number : null;
}

function parseDateLike(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  const timeMs = date.getTime();
  return Number.isFinite(timeMs) ? timeMs : null;
}

function normalizeAccelpixLiveTimestampMs(value, receivedAtMs = Date.now()) {
  const rawMs = parseDateLike(value);
  if (!Number.isFinite(rawMs)) return null;

  const year = new Date(rawMs).getUTCFullYear();
  if (year < 2000) return null;

  const directDrift = Math.abs(rawMs - receivedAtMs);
  if (directDrift <= LIVE_TIMESTAMP_TOLERANCE_MS) return rawMs;

  // Current Pix Node packets have been observed returning Indian exchange
  // wall-clock time encoded as a UTC Date (exactly +05:30 versus receipt).
  // Correct that representation only when it lands near the actual arrival
  // time; otherwise leave the provider timestamp unusable and let the gateway
  // use server receipt time.
  const istCorrectedMs = rawMs - IST_OFFSET_MS;
  if (Math.abs(istCorrectedMs - receivedAtMs) <= LIVE_TIMESTAMP_TOLERANCE_MS) {
    return istCorrectedMs;
  }

  return null;
}

function parseAccelpixIntradayTimeMs(value) {
  const match = String(value || '').trim().match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z)?$/,
  );
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const wallClockAsUtc = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );

  return wallClockAsUtc - IST_OFFSET_MS;
}

function parseAccelpixEodTimeMs(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  return Date.UTC(Number(year), Number(month) - 1, Number(day));
}

function ymdInIst(timeMs) {
  const date = new Date(Number(timeMs) + IST_OFFSET_MS);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function ymdUtc(timeMs) {
  const date = new Date(Number(timeMs));
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function nseSessionOpenUtcMs(timeMs) {
  const local = new Date(Number(timeMs) + IST_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  const openLocalAsUtc = Date.UTC(
    year,
    month,
    day,
    Math.floor(NSE_SESSION_OPEN_MINUTE / 60),
    NSE_SESSION_OPEN_MINUTE % 60,
    0,
    0,
  );
  return openLocalAsUtc - IST_OFFSET_MS;
}

function nseIntradayBucketOpenTimeMs(timeMs, timeframe) {
  const stepMs = INTRADAY_TIMEFRAME_MS[timeframe];
  if (!stepMs) return null;
  const sessionOpenMs = nseSessionOpenUtcMs(timeMs);
  if (!Number.isFinite(sessionOpenMs) || timeMs < sessionOpenMs) return null;
  return sessionOpenMs + Math.floor((timeMs - sessionOpenMs) / stepMs) * stepMs;
}

function aggregateNseIntradayBars(sourceBars, timeframe) {
  if (timeframe === '1m') return sourceBars;
  const stepMs = INTRADAY_TIMEFRAME_MS[timeframe];
  if (!stepMs) return [];

  const buckets = new Map();
  for (const bar of sourceBars) {
    const bucket = nseIntradayBucketOpenTimeMs(Number(bar.openTimeMs), timeframe);
    if (!Number.isFinite(bucket)) continue;

    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        openTimeMs: bucket,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        providerVolume: nonNegativeNumber(bar.providerVolume),
      });
      continue;
    }

    existing.high = Math.max(existing.high, bar.high);
    existing.low = Math.min(existing.low, bar.low);
    existing.close = bar.close;
    const volume = nonNegativeNumber(bar.providerVolume);
    if (volume != null) existing.providerVolume = Number(existing.providerVolume || 0) + volume;
  }

  return [...buckets.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
}

function mergeBarsByOpenTime(baseBars, overlayBars) {
  const byTime = new Map();
  for (const bar of Array.isArray(baseBars) ? baseBars : []) {
    if (Number.isFinite(Number(bar?.openTimeMs))) byTime.set(Number(bar.openTimeMs), { ...bar });
  }
  for (const bar of Array.isArray(overlayBars) ? overlayBars : []) {
    if (Number.isFinite(Number(bar?.openTimeMs))) byTime.set(Number(bar.openTimeMs), { ...bar });
  }
  return [...byTime.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
}

function nseTradingDateUtcMidnight(timeMs) {
  const local = new Date(Number(timeMs) + IST_OFFSET_MS);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
}

function aggregateCurrentNseDailyBar(minuteBars) {
  const bars = (Array.isArray(minuteBars) ? minuteBars : [])
    .filter(bar => Number.isFinite(Number(bar?.openTimeMs)))
    .sort((a, b) => a.openTimeMs - b.openTimeMs);
  if (!bars.length) return null;

  return {
    openTimeMs: nseTradingDateUtcMidnight(bars[0].openTimeMs),
    open: bars[0].open,
    high: Math.max(...bars.map(bar => bar.high)),
    low: Math.min(...bars.map(bar => bar.low)),
    close: bars[bars.length - 1].close,
    providerVolume: bars.reduce((sum, bar) => {
      const volume = nonNegativeNumber(bar.providerVolume);
      return volume == null ? sum : sum + volume;
    }, 0),
  };
}

function aggregateWeeklyEodBars(sourceBars) {
  const buckets = new Map();
  for (const bar of sourceBars) {
    const date = new Date(Number(bar.openTimeMs));
    const day = date.getUTCDay();
    const daysSinceMonday = (day + 6) % 7;
    const bucket = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() - daysSinceMonday,
    );

    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        openTimeMs: bucket,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        providerVolume: nonNegativeNumber(bar.providerVolume),
      });
      continue;
    }

    existing.high = Math.max(existing.high, bar.high);
    existing.low = Math.min(existing.low, bar.low);
    existing.close = bar.close;
    const volume = nonNegativeNumber(bar.providerVolume);
    if (volume != null) existing.providerVolume = Number(existing.providerVolume || 0) + volume;
  }

  return [...buckets.values()].sort((a, b) => a.openTimeMs - b.openTimeMs);
}

function mapHistoryRow(row, timeframe) {
  const openTimeMs = timeframe === '1d'
    ? parseAccelpixEodTimeMs(row?.td)
    : parseAccelpixIntradayTimeMs(row?.td);
  const open = marketPrice(row?.op);
  const high = marketPrice(row?.hp);
  const low = marketPrice(row?.lp);
  const close = marketPrice(row?.cp);
  if (![openTimeMs, open, high, low, close].every(Number.isFinite)) return null;
  return {
    openTimeMs,
    open,
    high,
    low,
    close,
    providerVolume: nonNegativeNumber(row?.vol),
  };
}

class AccelpixAdapter extends EventEmitter {
  constructor({
    apiKey,
    host = 'apidata.accelpix.in',
    scheme = 'https',
    httpTimeoutMs = 10000,
    reconnectMinMs = 1000,
    reconnectMaxMs = 30000,
    maxSymbols = 100,
    logger = null,
    clientFactory = null,
    fetchImpl = globalThis.fetch,
  }) {
    super();
    this.apiKey = apiKey;
    this.host = String(host || 'apidata.accelpix.in').replace(/^https?:\/\//i, '').replace(/\/$/, '');
    this.scheme = scheme;
    this.httpTimeoutMs = httpTimeoutMs;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.maxSymbols = maxSymbols;
    this.logger = logger;
    this.clientFactory = clientFactory || (() => createAccelpixSignalRClient({
      reconnectMinMs: this.reconnectMinMs,
      reconnectMaxMs: this.reconnectMaxMs,
      logger: this.logger,
    }));
    this.fetchImpl = fetchImpl;

    this.client = null;
    this.stopping = false;
    this.started = false;
    this.callbacksRegistered = false;
    this.retry = 0;
    this.reconnectTimer = null;
    this.subscriptions = [];
    this.providerToCanonical = new Map();
    this.quoteState = new Map();
  }

  start(subscriptions) {
    this.subscriptions = (Array.isArray(subscriptions) ? subscriptions : []).map(item => ({ ...item }));
    const uniqueProviderSymbols = [...new Set(this.subscriptions.map(item => item.providerSymbol).filter(Boolean))];
    if (uniqueProviderSymbols.length > this.maxSymbols) {
      const error = new Error(`Accelpix subscription limit exceeded: ${uniqueProviderSymbols.length} > ${this.maxSymbols}`);
      error.code = 'ACCELPIX_SYMBOL_LIMIT_EXCEEDED';
      this.emit('adapter-error', error);
      this.emit('connection', { state: 'ERROR', timestamp: Date.now() });
      return Promise.reject(error);
    }

    this.providerToCanonical = new Map(this.subscriptions.map(item => [item.providerSymbol, item.symbol]));
    this.quoteState.clear();
    this.stopping = false;
    this.started = true;
    return this.#connectAndSubscribe();
  }

  async stop() {
    this.stopping = true;
    this.started = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    const providerSymbols = [...new Set(this.subscriptions.map(item => item.providerSymbol).filter(Boolean))];
    if (this.client?.stream?.unsubscribeAll && providerSymbols.length) {
      try {
        const unsubscribe = Promise.resolve(this.client.stream.unsubscribeAll(providerSymbols));
        const timeoutMs = Math.min(2500, Math.max(500, Number(this.httpTimeoutMs) || 1000));
        await Promise.race([
          unsubscribe,
          new Promise(resolve => setTimeout(resolve, timeoutMs)),
        ]);
      } catch (error) {
        this.logger?.warn?.({ err: error }, 'Accelpix unsubscribe failed during shutdown');
      }
    }

    if (this.client?.disconnect) {
      try {
        await this.client.disconnect();
      } catch (error) {
        this.logger?.warn?.({ err: error }, 'Accelpix SignalR disconnect failed during shutdown');
      }
    }

    this.emit('connection', { state: 'STOPPED', timestamp: Date.now() });
  }

  async #connectAndSubscribe() {
    if (this.stopping || !this.started) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    try {
      if (!this.client) this.client = this.clientFactory();
      this.#registerCallbacks();
      this.emit('connection', { state: 'CONNECTING', timestamp: Date.now() });

      await this.client.initialize(this.apiKey, this.host, this.scheme);
      if (this.stopping) return;

      const providerSymbols = [...new Set(this.subscriptions.map(item => item.providerSymbol).filter(Boolean))];
      const status = providerSymbols.length
        ? await this.client.stream.subscribeAll(providerSymbols)
        : null;

      this.retry = 0;
      this.emit('subscription-status', {
        event: 'subscribe-status',
        status: 'ok',
        success: providerSymbols,
        fails: [],
        raw: status,
        provider: 'accelpix',
      });
    } catch (error) {
      if (this.stopping) return;
      this.emit('adapter-error', error);
      this.emit('connection', { state: 'ERROR', timestamp: Date.now() });
      this.#scheduleReconnect();
    }
  }

  #registerCallbacks() {
    if (this.callbacksRegistered || !this.client?.callbacks) return;
    this.callbacksRegistered = true;

    this.client.callbacks.onConnected?.(() => {
      if (this.stopping) return;
      this.retry = 0;
      this.emit('connection', { state: 'LIVE', timestamp: Date.now() });
    });

    this.client.callbacks.onClosed?.((error) => {
      if (this.stopping) return;
      this.emit('connection', {
        state: 'DISCONNECTED',
        timestamp: Date.now(),
        reason: error?.message || String(error || ''),
      });
      this.#scheduleReconnect();
    });

    this.client.callbacks.onReconnecting?.((error) => {
      if (this.stopping) return;
      this.emit('connection', {
        state: 'DISCONNECTED',
        timestamp: Date.now(),
        reason: error?.message || String(error || 'SignalR reconnecting'),
      });
    });

    this.client.callbacks.onReconnected?.(() => {
      if (this.stopping) return;
      this.retry = 0;
      this.emit('connection', { state: 'LIVE', timestamp: Date.now(), recovered: true });
    });

    this.client.callbacks.onSubscriptionError?.((error) => {
      if (this.stopping) return;
      this.emit('adapter-error', error instanceof Error ? error : new Error(String(error || 'Accelpix subscription error')));
    });

    this.client.callbacks.onTrade?.(message => this.#handleTrade(message));
    this.client.callbacks.onTradeSnapshot?.(message => this.#handleTrade(message));
    this.client.callbacks.onBest?.(message => this.#handleBest(message));
    // Refs are deliberately not treated as LTP. Pix documents them as
    // OHLC/reference updates and their price field is not a trade price.
  }

  #scheduleReconnect() {
    if (this.stopping || !this.started || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * (2 ** this.retry));
    this.retry += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.#connectAndSubscribe();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  #state(providerSymbol) {
    if (!this.quoteState.has(providerSymbol)) {
      this.quoteState.set(providerSymbol, {
        price: null,
        bid: null,
        ask: null,
        dayVolume: null,
      });
    }
    return this.quoteState.get(providerSymbol);
  }

  #handleTrade(message) {
    const providerSymbol = String(message?.ticker || '');
    const symbol = this.providerToCanonical.get(providerSymbol);
    if (!symbol) return;

    const price = marketPrice(message?.price);
    if (price == null) return;

    const receivedAtMs = Date.now();
    const state = this.#state(providerSymbol);
    state.price = price;
    const volume = nonNegativeNumber(message?.volume);
    if (volume != null) state.dayVolume = volume;

    this.emit('price', {
      symbol,
      providerSymbol,
      price,
      bid: state.bid,
      ask: state.ask,
      providerTimestampMs: normalizeAccelpixLiveTimestampMs(message?.time, receivedAtMs),
      dayVolume: state.dayVolume,
      source: 'accelpix',
      raw: message,
    });
  }

  #handleBest(message) {
    const providerSymbol = String(message?.ticker || '');
    const symbol = this.providerToCanonical.get(providerSymbol);
    if (!symbol) return;

    const state = this.#state(providerSymbol);
    const bid = marketPrice(message?.bidPrice);
    const ask = marketPrice(message?.askPrice);
    if (bid != null) state.bid = bid;
    if (ask != null) state.ask = ask;

    // Best packets have no LTP. Publish the updated spread only after a trade
    // or trade snapshot has established an authoritative last price.
    if (state.price == null) return;

    const receivedAtMs = Date.now();
    this.emit('price', {
      symbol,
      providerSymbol,
      price: state.price,
      bid: state.bid,
      ask: state.ask,
      providerTimestampMs: normalizeAccelpixLiveTimestampMs(message?.time, receivedAtMs),
      dayVolume: state.dayVolume,
      source: 'accelpix',
      quoteOnly: true,
      raw: message,
    });
  }

  async fetchLatestPrice({ providerSymbol }) {
    const url = new URL(`${this.scheme}://${this.host}/api/fda/rest/quote`);
    url.searchParams.set('api_token', this.apiKey);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify([providerSymbol]),
        signal: controller.signal,
      });
      const body = await response.json();
      const row = Array.isArray(body)
        ? body.find(item => String(item?.tkr || '') === providerSymbol)
        : null;
      if (!response.ok || !row) {
        const error = new Error(`Accelpix quote request failed (${response.status})`);
        error.statusCode = response.status || 502;
        throw error;
      }

      const price = marketPrice(row.pr);
      if (price == null) {
        const error = new Error('Accelpix quote response did not include a valid price');
        error.statusCode = 502;
        throw error;
      }

      return {
        providerSymbol,
        price,
        bid: marketPrice(row.bp),
        ask: marketPrice(row.ap),
        providerTimestampMs: null,
        dayVolume: nonNegativeNumber(row.vol),
        source: 'accelpix-rest',
        raw: row,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  supportsHistory(timeframe) {
    return ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'].includes(timeframe);
  }

  async fetchHistorical({ providerSymbol, timeframe, limit = 160, beforeMs = null }) {
    if (!this.supportsHistory(timeframe)) return [];

    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 160));
    const cursor = Number.isFinite(Number(beforeMs)) && Number(beforeMs) > 0
      ? Math.trunc(Number(beforeMs))
      : null;
    const endMs = cursor == null ? Date.now() : cursor - 1;

    let startMs;
    let start;
    let end;
    let path;

    const intraday = Boolean(INTRADAY_TIMEFRAME_MS[timeframe]);
    if (intraday) {
      // Accelpix entitlement provides 60 calendar days of 1-minute history.
      // Higher ACG intraday timeframes are derived from those authoritative M1
      // bars using the NSE 09:15 Asia/Kolkata session anchor.
      const barsPerSession = Math.max(1, Math.ceil((6.25 * 60 * 60 * 1000) / INTRADAY_TIMEFRAME_MS[timeframe]));
      const requestedDays = Math.max(3, Math.ceil(safeLimit / barsPerSession * 2.2) + 2);
      const lookbackDays = Math.min(60, requestedDays);
      startMs = endMs - lookbackDays * 24 * 60 * 60 * 1000;
      start = ymdInIst(startMs);
      end = ymdInIst(endMs);
      path = `/api/fda/rest/${encodeURIComponent(providerSymbol)}/${start}/${end}/1`;
    } else {
      // Daily requests need calendar slack for weekends/holidays. Weekly
      // requests must use the full two-year entitlement because ~160 requested
      // weekly bars cannot exist inside a two-year plan; returning the full
      // available window lets pagination report the real provider boundary.
      const requestedDays = timeframe === '1w'
        ? 730
        : Math.max(30, Math.ceil(safeLimit * 1.8) + 15);
      const lookbackDays = Math.min(730, requestedDays);
      startMs = endMs - lookbackDays * 24 * 60 * 60 * 1000;
      start = ymdUtc(startMs);
      end = ymdUtc(endMs);
      path = `/api/fda/rest/${encodeURIComponent(providerSymbol)}/${start}/${end}`;
    }

    const body = await this.#fetchHistoryArray(path);

    const sourceTimeframe = intraday ? '1m' : '1d';
    let sourceBars = body
      .map(row => mapHistoryRow(row, sourceTimeframe))
      .filter(Boolean)
      .filter(bar => cursor == null || bar.openTimeMs < cursor)
      .sort((a, b) => a.openTimeMs - b.openTimeMs);

    // Accelpix documents current-day minute history as live tick aggregation,
    // but large historical ranges can be served from a historical cache before
    // the current session has been folded in. Always request the current NSE
    // trading date separately on the latest page and overlay it. This guarantees
    // that today's bars are present from 09:15 IST onward instead of ending at
    // the previous trading day.
    if (cursor == null) {
      try {
        const currentDate = ymdInIst(endMs);
        const liveRows = await this.#fetchHistoryArray(
          `/api/fda/rest/${encodeURIComponent(providerSymbol)}/${currentDate}/${currentDate}/1`,
        );
        const liveMinuteBars = liveRows
          .map(row => mapHistoryRow(row, '1m'))
          .filter(Boolean)
          .sort((a, b) => a.openTimeMs - b.openTimeMs);

        if (liveMinuteBars.length) {
          if (intraday) {
            sourceBars = mergeBarsByOpenTime(sourceBars, liveMinuteBars);
          } else {
            const currentDay = aggregateCurrentNseDailyBar(liveMinuteBars);
            if (currentDay) sourceBars = mergeBarsByOpenTime(sourceBars, [currentDay]);
          }
        }
      } catch (error) {
        // Do not make the whole chart unavailable when only the current-session
        // overlay fails. The websocket candle remains available as a fallback.
        this.logger?.warn?.(
          { err: error, providerSymbol, timeframe },
          'Accelpix current-day candle overlay failed',
        );
      }
    }

    const bars = intraday
      ? aggregateNseIntradayBars(sourceBars, timeframe)
      : timeframe === '1w'
        ? aggregateWeeklyEodBars(sourceBars)
        : sourceBars;

    return bars.slice(-safeLimit);
  }
}

module.exports = {
  AccelpixAdapter,
  normalizeAccelpixLiveTimestampMs,
  parseAccelpixIntradayTimeMs,
  parseAccelpixEodTimeMs,
  nseIntradayBucketOpenTimeMs,
  aggregateNseIntradayBars,
  aggregateWeeklyEodBars,
  aggregateCurrentNseDailyBar,
  mergeBarsByOpenTime,
  marketPrice,
};
