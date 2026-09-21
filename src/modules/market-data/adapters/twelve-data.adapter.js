'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');
const {
  TWELVE_DATA_HISTORY_INTERVALS,
  CANONICAL_UTC_HISTORY_SOURCE,
} = require('../market.constants');
const {
  aggregateCanonicalUtcBars,
  canonicalSourceBarsPerTarget,
} = require('../canonical-history');

function optionalNonNegativeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatUtcApiDateTime(timeMs) {
  const date = new Date(Number(timeMs));
  if (!Number.isFinite(date.getTime())) return '';
  return date.toISOString().slice(0, 19);
}

class TwelveDataAdapter extends EventEmitter {
  constructor({ apiKey, wsUrl, apiBase, heartbeatMs, reconnectMinMs, reconnectMaxMs, httpTimeoutMs, subscribeBatchSize = 100, logger }) {
    super();
    this.apiKey = apiKey;
    this.wsUrl = wsUrl;
    this.apiBase = apiBase;
    this.heartbeatMs = heartbeatMs;
    this.reconnectMinMs = reconnectMinMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.httpTimeoutMs = httpTimeoutMs;
    this.subscribeBatchSize = Math.max(1, Number(subscribeBatchSize) || 100);
    this.logger = logger;

    this.socket = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.retry = 0;
    this.stopping = false;
    this.subscriptions = [];
    this.providerToCanonical = new Map();
  }

  start(subscriptions) {
    this.subscriptions = subscriptions.map(item => ({ ...item }));
    this.providerToCanonical = new Map(this.subscriptions.map(item => [item.providerSymbol, item.symbol]));
    this.stopping = false;
    this.#connect();
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.heartbeatTimer);
    clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.reconnectTimer = null;

    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) {
      await new Promise(resolve => {
        const timer = setTimeout(resolve, 1000);
        socket.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        try { socket.close(1000, 'ACG market gateway shutdown'); } catch { resolve(); }
      });
    }
  }

  #connect() {
    if (this.stopping || this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;

    this.emit('connection', { state: 'CONNECTING', timestamp: Date.now() });
    const socket = new WebSocket(`${this.wsUrl}?apikey=${encodeURIComponent(this.apiKey)}`);
    this.socket = socket;

    socket.on('open', () => {
      if (socket !== this.socket || this.stopping) return;
      this.retry = 0;
      this.emit('connection', { state: 'LIVE', timestamp: Date.now() });
      this.#subscribeAll();
      this.#sendHeartbeat();
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => this.#sendHeartbeat(), this.heartbeatMs);
      this.heartbeatTimer.unref?.();
    });

    socket.on('message', buffer => {
      if (socket !== this.socket || this.stopping) return;
      this.#handleMessage(buffer.toString());
    });

    socket.on('error', error => {
      if (socket !== this.socket || this.stopping) return;
      this.emit('adapter-error', error);
    });

    socket.on('close', (code, reason) => {
      if (socket !== this.socket) return;
      this.socket = null;
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
      if (this.stopping) return;

      this.emit('connection', {
        state: 'DISCONNECTED',
        timestamp: Date.now(),
        code,
        reason: reason?.toString() || '',
      });
      this.#scheduleReconnect();
    });
  }

  #subscribeAll() {
    if (this.socket?.readyState !== WebSocket.OPEN || !this.subscriptions.length) return;
    const providerSymbols = [...new Set(this.subscriptions.map(item => item.providerSymbol).filter(Boolean))];
    for (let offset = 0; offset < providerSymbols.length; offset += this.subscribeBatchSize) {
      const batch = providerSymbols.slice(offset, offset + this.subscribeBatchSize);
      this.socket.send(JSON.stringify({
        action: 'subscribe',
        params: { symbols: batch.join(',') },
      }));
    }
  }

  #sendHeartbeat() {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ action: 'heartbeat' }));
    }
  }

  #scheduleReconnect() {
    if (this.stopping || this.reconnectTimer) return;
    const base = Math.min(this.reconnectMaxMs, this.reconnectMinMs * (2 ** this.retry));
    const jitter = Math.floor(base * Math.random() * 0.2);
    const delay = Math.min(this.reconnectMaxMs, base + jitter);
    this.retry += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.#connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  #handleMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      this.emit('adapter-error', new Error(`Twelve Data returned non-JSON WebSocket data: ${error.message}`));
      return;
    }

    if (data.event === 'price') {
      const canonical = this.providerToCanonical.get(data.symbol);
      const price = Number(data.price);
      if (!canonical || !Number.isFinite(price)) return;

      const bid = Number(data.bid);
      const ask = Number(data.ask);
      const providerTimestampSec = Number(data.timestamp);
      const dayVolume = optionalNonNegativeNumber(data.day_volume);

      this.emit('price', {
        symbol: canonical,
        providerSymbol: data.symbol,
        price,
        bid: Number.isFinite(bid) ? bid : null,
        ask: Number.isFinite(ask) ? ask : null,
        providerTimestampMs: Number.isFinite(providerTimestampSec) ? Math.trunc(providerTimestampSec * 1000) : null,
        dayVolume,
        raw: data,
      });
      return;
    }

    if (data.event === 'subscribe-status' || data.event === 'unsubscribe-status') {
      this.emit('subscription-status', data);
      if (data.status === 'error') this.emit('adapter-error', new Error(data.message || `Twelve Data ${data.event} failed`));
      return;
    }

    if (data.status === 'error') {
      this.emit('adapter-error', new Error(data.message || 'Twelve Data WebSocket error'));
    }
  }

  async fetchLatestPrice({ providerSymbol }) {
    const params = new URLSearchParams({
      symbol: providerSymbol,
      apikey: this.apiKey,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    try {
      const response = await fetch(`${this.apiBase}/price?${params}`, { signal: controller.signal });
      const body = await response.json();
      if (!response.ok || body?.status === 'error') {
        const error = new Error(body?.message || `Twelve Data latest-price request failed (${response.status})`);
        error.statusCode = response.status || 502;
        throw error;
      }
      const price = Number(body?.price);
      if (!Number.isFinite(price) || price <= 0) {
        const error = new Error('Twelve Data latest-price response did not include a valid price');
        error.statusCode = 502;
        throw error;
      }
      return {
        providerSymbol,
        price,
        bid: null,
        ask: null,
        providerTimestampMs: null,
        dayVolume: null,
        source: 'twelve-data-rest',
        raw: body,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  supportsHistory(timeframe) {
    return Boolean(TWELVE_DATA_HISTORY_INTERVALS[timeframe]);
  }

  async fetchHistorical({ providerSymbol, timeframe, limit = 160, beforeMs = null }) {
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 160));
    const cursor = Number.isFinite(Number(beforeMs)) && Number(beforeMs) > 0
      ? Math.trunc(Number(beforeMs))
      : null;
    const endDateMs = cursor == null ? null : cursor - 1;
    const canonicalSource = CANONICAL_UTC_HISTORY_SOURCE[timeframe];
    if (canonicalSource) {
      return this.#fetchCanonicalUtcHistorical({
        providerSymbol,
        timeframe,
        sourceTimeframe: canonicalSource,
        limit: safeLimit,
        endDateMs,
      });
    }
    return this.#fetchTimeSeries({
      providerSymbol,
      timeframe,
      limit: safeLimit,
      endDateMs,
    });
  }

  async #fetchCanonicalUtcHistorical({ providerSymbol, timeframe, sourceTimeframe, limit, endDateMs: initialEndDateMs = null }) {
    const barsPerTarget = canonicalSourceBarsPerTarget(timeframe);
    if (!barsPerTarget) return [];

    const desiredSourceBars = Math.max(barsPerTarget * 2, (limit + 2) * barsPerTarget);
    const maxPages = 12;
    const sourceByTime = new Map();
    let endDateMs = Number.isFinite(initialEndDateMs) ? initialEndDateMs : null;

    for (let page = 0; page < maxPages; page += 1) {
      const remaining = Math.max(1, desiredSourceBars - sourceByTime.size);
      const pageSize = Math.min(5000, remaining);
      const chunk = await this.#fetchTimeSeries({
        providerSymbol,
        timeframe: sourceTimeframe,
        limit: pageSize,
        endDateMs,
      });
      if (!chunk.length) break;

      for (const bar of chunk) sourceByTime.set(Number(bar.openTimeMs), bar);

      const aggregated = aggregateCanonicalUtcBars([...sourceByTime.values()], timeframe);
      if (aggregated.length >= limit + 1) break;
      if (chunk.length < pageSize) break;

      const earliest = Math.min(...chunk.map(bar => Number(bar.openTimeMs)).filter(Number.isFinite));
      if (!Number.isFinite(earliest)) break;
      endDateMs = earliest - 1000;
    }

    return aggregateCanonicalUtcBars([...sourceByTime.values()], timeframe).slice(-limit);
  }

  async #fetchTimeSeries({ providerSymbol, timeframe, limit, endDateMs = null }) {
    const interval = TWELVE_DATA_HISTORY_INTERVALS[timeframe];
    if (!interval) return [];

    const params = new URLSearchParams({
      symbol: providerSymbol,
      interval,
      outputsize: String(Math.max(1, Math.min(5000, Number(limit) || 160))),
      timezone: 'UTC',
      order: 'asc',
      apikey: this.apiKey,
    });
    if (Number.isFinite(endDateMs)) params.set('end_date', formatUtcApiDateTime(endDateMs));

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    try {
      const response = await fetch(`${this.apiBase}/time_series?${params}`, { signal: controller.signal });
      const body = await response.json();
      if (!response.ok || body?.status === 'error') {
        const error = new Error(body?.message || `Twelve Data history request failed (${response.status})`);
        error.statusCode = 502;
        throw error;
      }

      return (body?.values || []).map(item => {
        const iso = String(item.datetime || '').includes('T') ? String(item.datetime) : String(item.datetime || '').replace(' ', 'T');
        const openTimeMs = Date.parse(`${iso}Z`);
        const open = Number(item.open);
        const high = Number(item.high);
        const low = Number(item.low);
        const close = Number(item.close);
        const providerVolume = optionalNonNegativeNumber(item.volume);
        if (![openTimeMs, open, high, low, close].every(Number.isFinite)) return null;
        return { openTimeMs, open, high, low, close, providerVolume };
      }).filter(Boolean);
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { TwelveDataAdapter };
