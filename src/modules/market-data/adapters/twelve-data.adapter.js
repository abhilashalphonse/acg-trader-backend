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

function normalizeSearchText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function indexMatchScore(row, subscription) {
  const expectedCurrency = String(subscription?.quoteCurrency || '').toUpperCase();
  const expectedName = normalizeSearchText(subscription?.name);
  const expectedNameTokens = new Set(expectedName.split(' ').filter(token => token.length > 1));
  const candidateName = normalizeSearchText(row?.instrument_name);
  const candidateTokens = new Set(candidateName.split(' ').filter(token => token.length > 1));

  let value = 0;
  if (expectedCurrency && String(row?.currency || '').toUpperCase() === expectedCurrency) value += 5;
  if (expectedName && candidateName === expectedName) value += 30;
  else if (expectedName && (candidateName.includes(expectedName) || expectedName.includes(candidateName))) value += 18;
  for (const token of expectedNameTokens) if (candidateTokens.has(token)) value += 2;
  if (/united states/i.test(String(row?.country || '')) && /^US/.test(String(subscription?.symbol || ''))) value += 4;
  return value;
}

function chooseIndexSearchMatch(rows, subscription, { requireExactSymbol = true } = {}) {
  const expectedSymbol = String(subscription?.providerSymbol || '').toUpperCase();
  const candidates = (Array.isArray(rows) ? rows : []).filter(row => (
    /index/i.test(String(row?.instrument_type || ''))
    && (!requireExactSymbol || String(row?.symbol || '').toUpperCase() === expectedSymbol)
  ));
  if (!candidates.length) return null;

  const ranked = [...candidates]
    .map(row => ({ row, score: indexMatchScore(row, subscription) }))
    .sort((a, b) => b.score - a.score);

  if (!requireExactSymbol && ranked[0]?.score < 6) return null;
  return ranked[0]?.row || null;
}

function commodityMatchScore(row, subscription) {
  const expectedName = normalizeSearchText(subscription?.name);
  const expectedTokens = new Set(expectedName.split(' ').filter(token => token.length > 1));
  const candidateName = normalizeSearchText(row?.instrument_name);
  const candidateTokens = new Set(candidateName.split(' ').filter(token => token.length > 1));

  let value = 0;
  if (expectedName && candidateName === expectedName) value += 30;
  else if (expectedName && (candidateName.includes(expectedName) || expectedName.includes(candidateName))) value += 18;
  for (const token of expectedTokens) if (candidateTokens.has(token)) value += 2;
  if (String(row?.currency || '').toUpperCase() === String(subscription?.quoteCurrency || '').toUpperCase()) value += 5;
  return value;
}

function chooseCommoditySearchMatch(rows, subscription, { requireExactSymbol = true } = {}) {
  const expectedSymbol = String(subscription?.providerSymbol || '').toUpperCase();
  const candidates = (Array.isArray(rows) ? rows : []).filter(row => (
    /(commodity|metal|energy|agricultural|livestock|soft|grain)/i.test(String(row?.instrument_type || row?.category || ''))
    && (!requireExactSymbol || String(row?.symbol || '').toUpperCase() === expectedSymbol)
  ));
  if (!candidates.length) return null;

  const ranked = [...candidates]
    .map(row => ({ row, score: commodityMatchScore(row, subscription) }))
    .sort((a, b) => b.score - a.score);

  if (!requireExactSymbol && ranked[0]?.score < 6) return null;
  return ranked[0]?.row || null;
}

function needsCommodityIdentityResolution(subscription) {
  const assetClass = String(subscription?.assetClass || '').toUpperCase();
  const providerSymbol = String(subscription?.providerSymbol || '');
  return assetClass === 'OTHER' || String(subscription?.symbol || '').toUpperCase() === 'NGASUSD'
    || (assetClass === 'ENERGY' && !providerSymbol.includes('/'));
}

function qualifyProviderSymbol(match, fallback) {
  const symbol = String(match?.symbol || fallback || '').trim();
  const exchange = String(match?.exchange || '').trim();
  return symbol && exchange ? `${symbol}:${exchange}` : symbol;
}

function formatUtcApiDateTime(timeMs) {
  const date = new Date(Number(timeMs));
  if (!Number.isFinite(date.getTime())) return '';
  return date.toISOString().slice(0, 19);
}

class TwelveDataAdapter extends EventEmitter {
  constructor({ apiKey, wsUrl, apiBase, heartbeatMs, reconnectMinMs, reconnectMaxMs, httpTimeoutMs, subscribeBatchSize = 100, logger, fetchImpl = globalThis.fetch }) {
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
    this.fetchImpl = fetchImpl;

    this.socket = null;
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.retry = 0;
    this.stopping = false;
    this.subscriptions = [];
    this.providerToCanonical = new Map();
    this.resolvedProviderSymbols = new Map();
    this.subscriptionIdentity = new Map();
    this.rejectedProviderSymbols = new Map();
    this.requestedByResolvedProviderSymbol = new Map();
  }

  async start(subscriptions) {
    const requested = (Array.isArray(subscriptions) ? subscriptions : []).map(item => ({ ...item }));
    this.stopping = false;
    this.resolvedProviderSymbols.clear();
    this.subscriptionIdentity.clear();
    this.rejectedProviderSymbols.clear();
    this.requestedByResolvedProviderSymbol.clear();

    const resolved = await this.#resolveSubscriptionIdentities(requested);
    this.subscriptions = resolved.filter(item => !item.identityError);
    this.providerToCanonical = new Map();

    for (const item of this.subscriptions) {
      const resolvedSymbol = item.resolvedProviderSymbol || item.providerSymbol;
      this.providerToCanonical.set(resolvedSymbol, item.symbol);
      this.providerToCanonical.set(item.providerSymbol, item.symbol);
      this.resolvedProviderSymbols.set(item.providerSymbol, resolvedSymbol);
      this.requestedByResolvedProviderSymbol.set(resolvedSymbol, item.providerSymbol);
      this.subscriptionIdentity.set(item.providerSymbol, item);
    }

    const rejected = resolved.filter(item => item.identityError);
    if (rejected.length) {
      for (const item of rejected) this.rejectedProviderSymbols.set(item.providerSymbol, item.identityError);
      this.emit('subscription-status', {
        event: 'subscribe-status',
        status: 'error',
        success: [],
        fails: rejected.map(item => ({ symbol: item.providerSymbol, message: item.identityError })),
        provider: 'twelve-data',
      });
    }

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

  async #resolveSubscriptionIdentities(subscriptions) {
    const result = [];
    const identitySubscriptions = subscriptions.filter(item => (
      String(item?.assetClass || '').toUpperCase() === 'INDEX'
      || needsCommodityIdentityResolution(item)
    ));
    const passthroughSubscriptions = subscriptions.filter(item => !identitySubscriptions.includes(item));
    result.push(...passthroughSubscriptions);

    const queue = [...identitySubscriptions];
    const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        const isIndex = String(item?.assetClass || '').toUpperCase() === 'INDEX';
        result.push(isIndex
          ? await this.#resolveIndexSubscription(item)
          : await this.#resolveCommoditySubscription(item));
      }
    });
    await Promise.all(workers);
    return result;
  }

  async #resolveIndexSubscription(subscription) {
    const providerSymbol = String(subscription?.providerSymbol || '').trim();
    if (!providerSymbol) return { ...subscription, identityError: 'Missing Twelve Data index symbol' };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    try {
      const search = async term => {
        const query = new URLSearchParams({
          symbol: term,
          outputsize: '120',
          show_plan: 'true',
          apikey: this.apiKey,
        });
        const response = await this.fetchImpl(`${this.apiBase}/symbol_search?${query}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok || body?.status === 'error') {
          throw new Error(body?.message || `Twelve Data symbol search failed (${response.status})`);
        }
        return body?.data || [];
      };

      const symbolRows = await search(providerSymbol);
      let match = chooseIndexSearchMatch(symbolRows, subscription, { requireExactSymbol: true });

      if (!match && subscription?.name) {
        const nameRows = await search(String(subscription.name));
        match = chooseIndexSearchMatch(nameRows, subscription, { requireExactSymbol: false });
      }

      if (!match) {
        return {
          ...subscription,
          identityError: `Twelve Data index identity could not be resolved for ${providerSymbol}`,
        };
      }

      const resolvedProviderSymbol = qualifyProviderSymbol(match, providerSymbol);
      this.logger?.info?.({
        symbol: subscription.symbol,
        providerSymbol,
        resolvedProviderSymbol,
        instrumentName: match.instrument_name,
        exchange: match.exchange,
      }, 'Resolved Twelve Data index identity');

      return {
        ...subscription,
        resolvedProviderSymbol,
        resolvedIdentity: {
          instrumentName: match.instrument_name || null,
          instrumentType: match.instrument_type || null,
          exchange: match.exchange || null,
          micCode: match.mic_code || null,
          country: match.country || null,
          currency: match.currency || null,
        },
      };
    } catch (error) {
      this.logger?.warn?.({ err: error, symbol: subscription.symbol, providerSymbol }, 'Twelve Data index identity resolution failed');
      return {
        ...subscription,
        identityError: `Twelve Data index identity resolution failed for ${providerSymbol}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }


  async #resolveCommoditySubscription(subscription) {
    const providerSymbol = String(subscription?.providerSymbol || '').trim();
    if (!providerSymbol) return { ...subscription, identityError: 'Missing Twelve Data commodity symbol' };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    try {
      const fetchCommodities = async symbol => {
        const query = new URLSearchParams({
          outputsize: '500',
          apikey: this.apiKey,
        });
        if (symbol) query.set('symbol', symbol);
        const response = await this.fetchImpl(`${this.apiBase}/commodities?${query}`, { signal: controller.signal });
        const body = await response.json();
        if (!response.ok || body?.status === 'error') {
          throw new Error(body?.message || `Twelve Data commodities request failed (${response.status})`);
        }
        return (body?.data || []).map(row => ({
          ...row,
          instrument_name: row?.name || null,
          instrument_type: row?.category || null,
          exchange: 'COMMODITY',
        }));
      };

      const symbolRows = await fetchCommodities(providerSymbol);
      let match = chooseCommoditySearchMatch(symbolRows, subscription, { requireExactSymbol: true });

      if (!match && subscription?.name) {
        const allRows = await fetchCommodities(null);
        match = chooseCommoditySearchMatch(allRows, subscription, { requireExactSymbol: false });
      }

      if (!match) {
        return {
          ...subscription,
          identityError: `Twelve Data commodity identity could not be resolved for ${providerSymbol}`,
        };
      }

      const resolvedProviderSymbol = qualifyProviderSymbol(match, providerSymbol);
      this.logger?.info?.({
        symbol: subscription.symbol,
        providerSymbol,
        resolvedProviderSymbol,
        instrumentName: match.instrument_name,
        instrumentType: match.instrument_type,
      }, 'Resolved Twelve Data commodity identity');

      return {
        ...subscription,
        resolvedProviderSymbol,
        resolvedIdentity: {
          instrumentName: match.instrument_name || null,
          instrumentType: match.instrument_type || null,
          exchange: 'COMMODITY',
          micCode: null,
          country: null,
          currency: subscription?.quoteCurrency || null,
        },
      };
    } catch (error) {
      this.logger?.warn?.({ err: error, symbol: subscription.symbol, providerSymbol }, 'Twelve Data commodity identity resolution failed');
      return {
        ...subscription,
        identityError: `Twelve Data commodity identity resolution failed for ${providerSymbol}`,
      };
    } finally {
      clearTimeout(timeout);
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
    const providerSymbols = [...new Set(this.subscriptions.map(item => item.resolvedProviderSymbol || item.providerSymbol).filter(Boolean))];
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
      const canonical = this.providerToCanonical.get(data.symbol) || this.providerToCanonical.get(String(data.symbol || '').split(':')[0]);
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
      const normalizeProviderSymbol = value => {
        const symbol = typeof value === 'string' ? value : value?.symbol;
        const requested = this.requestedByResolvedProviderSymbol.get(String(symbol || '')) || symbol;
        return typeof value === 'string' ? requested : { ...value, symbol: requested };
      };
      const normalized = {
        ...data,
        success: Array.isArray(data.success) ? data.success.map(normalizeProviderSymbol) : data.success,
        fails: Array.isArray(data.fails) ? data.fails.map(normalizeProviderSymbol) : data.fails,
      };
      this.emit('subscription-status', normalized);
      if (data.status === 'error') this.emit('adapter-error', new Error(data.message || `Twelve Data ${data.event} failed`));
      return;
    }

    if (data.status === 'error') {
      this.emit('adapter-error', new Error(data.message || 'Twelve Data WebSocket error'));
    }
  }

  async fetchLatestPrice({ providerSymbol }) {
    const requestedProviderSymbol = String(providerSymbol || '');
    if (this.rejectedProviderSymbols.has(requestedProviderSymbol)) {
      const error = new Error(this.rejectedProviderSymbols.get(requestedProviderSymbol));
      error.code = 'TWELVE_DATA_SYMBOL_IDENTITY_MISMATCH';
      throw error;
    }
    const resolvedProviderSymbol = this.resolvedProviderSymbols.get(requestedProviderSymbol) || requestedProviderSymbol;
    const params = new URLSearchParams({
      symbol: resolvedProviderSymbol,
      apikey: this.apiKey,
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.httpTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiBase}/price?${params}`, { signal: controller.signal });
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
        providerSymbol: requestedProviderSymbol,
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
    const requestedProviderSymbol = String(providerSymbol || '');
    if (this.rejectedProviderSymbols.has(requestedProviderSymbol)) {
      const error = new Error(this.rejectedProviderSymbols.get(requestedProviderSymbol));
      error.code = 'TWELVE_DATA_SYMBOL_IDENTITY_MISMATCH';
      throw error;
    }
    const resolvedProviderSymbol = this.resolvedProviderSymbols.get(requestedProviderSymbol) || requestedProviderSymbol;
    const safeLimit = Math.max(1, Math.min(1000, Number(limit) || 160));
    const cursor = Number.isFinite(Number(beforeMs)) && Number(beforeMs) > 0
      ? Math.trunc(Number(beforeMs))
      : null;
    const endDateMs = cursor == null ? null : cursor - 1;
    const canonicalSource = CANONICAL_UTC_HISTORY_SOURCE[timeframe];
    if (canonicalSource) {
      return this.#fetchCanonicalUtcHistorical({
        providerSymbol: resolvedProviderSymbol,
        requestedProviderSymbol,
        timeframe,
        sourceTimeframe: canonicalSource,
        limit: safeLimit,
        endDateMs,
      });
    }
    return this.#fetchTimeSeries({
      providerSymbol: resolvedProviderSymbol,
      requestedProviderSymbol,
      timeframe,
      limit: safeLimit,
      endDateMs,
    });
  }

  async #fetchCanonicalUtcHistorical({ providerSymbol, requestedProviderSymbol = providerSymbol, timeframe, sourceTimeframe, limit, endDateMs: initialEndDateMs = null }) {
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
        requestedProviderSymbol,
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

  async #fetchTimeSeries({ providerSymbol, requestedProviderSymbol = providerSymbol, timeframe, limit, endDateMs = null }) {
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
      const response = await this.fetchImpl(`${this.apiBase}/time_series?${params}`, { signal: controller.signal });
      const body = await response.json();
      if (!response.ok || body?.status === 'error') {
        const error = new Error(body?.message || `Twelve Data history request failed (${response.status})`);
        error.statusCode = 502;
        throw error;
      }

      const identity = this.subscriptionIdentity.get(requestedProviderSymbol);
      if (String(identity?.assetClass || '').toUpperCase() === 'INDEX' && !/index/i.test(String(body?.meta?.type || ''))) {
        const error = new Error(`Twelve Data resolved ${requestedProviderSymbol} as ${body?.meta?.type || 'unknown instrument type'} instead of Index`);
        error.code = 'TWELVE_DATA_SYMBOL_IDENTITY_MISMATCH';
        error.statusCode = 502;
        throw error;
      }

      return (body?.values || []).map(item => {
        const iso = String(item.datetime || '').includes('T') ? String(item.datetime) : String(item.datetime || '').replace(' ', 'T');
        const openTimeMs = Date.parse(`${iso}Z`);
        if ([item.open, item.high, item.low, item.close].some(value => value == null || String(value).trim() === '')) return null;
        const open = Number(item.open);
        const high = Number(item.high);
        const low = Number(item.low);
        const close = Number(item.close);
        const providerVolume = optionalNonNegativeNumber(item.volume);
        if (![openTimeMs, open, high, low, close].every(Number.isFinite)) return null;
        if (low <= 0 || low > Math.min(open, close) || high < Math.max(open, close)) return null;
        return { openTimeMs, open, high, low, close, providerVolume };
      }).filter(Boolean);
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = {
  TwelveDataAdapter,
  chooseIndexSearchMatch,
  chooseCommoditySearchMatch,
  needsCommodityIdentityResolution,
  qualifyProviderSymbol,
};
