'use strict';

const { Instrument } = require('./instrument.model');

const READY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const UNAVAILABLE_TTL_MS = 6 * 60 * 60 * 1000;
const REMOTE_ASSET_CLASSES = new Set(['FOREX', 'CRYPTO', 'EQUITY']);

function createInstrumentIdentityService({ apiKey, apiBase, timeoutMs = 10000, logger } = {}) {
  const inFlight = new Map();

  async function resolve(document) {
    if (!document?.symbol) return emptyIdentity('UNAVAILABLE');

    const assetClass = String(document.assetClass || '').toUpperCase();
    if (!REMOTE_ASSET_CLASSES.has(assetClass)) return emptyIdentity('UNSUPPORTED');

    const cached = normalizeStoredIdentity(document.identity);
    if (isFreshIdentity(cached)) return cached;

    const symbol = String(document.symbol).toUpperCase();
    if (inFlight.has(symbol)) return inFlight.get(symbol);

    const task = fetchAndCache(document)
      .catch(error => {
        logger?.warn?.({ err: error, symbol }, 'Instrument identity lookup failed');
        return cacheUnavailable(document);
      })
      .finally(() => inFlight.delete(symbol));

    inFlight.set(symbol, task);
    return task;
  }

  async function fetchAndCache(document) {
    if (!apiKey || !apiBase) return cacheUnavailable(document);

    const providerSymbol = providerSymbolFor(document);
    const params = new URLSearchParams({
      symbol: providerSymbol,
      apikey: apiKey,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 10000));
    try {
      const response = await fetch(`${String(apiBase).replace(/\/$/, '')}/logo?${params}`, { signal: controller.signal });
      let body = null;
      try { body = await response.json(); } catch { body = null; }

      if (!response.ok || body?.status === 'error') {
        logger?.warn?.({ symbol: document.symbol, providerSymbol, status: response.status, message: body?.message }, 'Twelve Data logo unavailable');
        return cacheUnavailable(document);
      }

      const identity = normalizeLogoResponse(body);
      const status = identity.logoUrl || identity.baseLogoUrl || identity.quoteLogoUrl ? 'READY' : 'UNAVAILABLE';
      const value = {
        provider: 'twelve-data',
        status,
        logoUrl: identity.logoUrl,
        baseLogoUrl: identity.baseLogoUrl,
        quoteLogoUrl: identity.quoteLogoUrl,
        checkedAt: new Date(),
      };
      await Instrument.updateOne({ _id: document._id }, { $set: { identity: value } });
      return normalizeStoredIdentity(value);
    } finally {
      clearTimeout(timer);
    }
  }

  async function cacheUnavailable(document) {
    const value = {
      provider: 'twelve-data',
      status: 'UNAVAILABLE',
      logoUrl: null,
      baseLogoUrl: null,
      quoteLogoUrl: null,
      checkedAt: new Date(),
    };
    if (document?._id) {
      try {
        await Instrument.updateOne({ _id: document._id }, { $set: { identity: value } });
      } catch (error) {
        logger?.warn?.({ err: error, symbol: document.symbol }, 'Unable to cache unavailable instrument identity');
      }
    }
    return normalizeStoredIdentity(value);
  }

  return { resolve };
}

function providerSymbolFor(document) {
  const mappings = document?.providerMappings;
  const mapped = mappings instanceof Map ? mappings.get('twelveData') : mappings?.twelveData;
  return String(mapped || document?.displaySymbol || document?.symbol || '').trim();
}

function normalizeLogoResponse(body) {
  const clean = value => typeof value === 'string' && /^https?:\/\//i.test(value.trim()) ? value.trim() : null;
  return {
    logoUrl: clean(body?.url),
    baseLogoUrl: clean(body?.logo_base),
    quoteLogoUrl: clean(body?.logo_quote),
  };
}

function normalizeStoredIdentity(identity) {
  if (!identity) return emptyIdentity('UNKNOWN');
  const raw = typeof identity.toObject === 'function' ? identity.toObject() : identity;
  return {
    provider: raw.provider || null,
    status: raw.status || 'UNKNOWN',
    logoUrl: raw.logoUrl || null,
    baseLogoUrl: raw.baseLogoUrl || null,
    quoteLogoUrl: raw.quoteLogoUrl || null,
    checkedAt: raw.checkedAt ? new Date(raw.checkedAt).toISOString() : null,
  };
}

function emptyIdentity(status) {
  return {
    provider: null,
    status,
    logoUrl: null,
    baseLogoUrl: null,
    quoteLogoUrl: null,
    checkedAt: null,
  };
}

function isFreshIdentity(identity, nowMs = Date.now()) {
  if (!identity?.checkedAt) return false;
  const checkedAtMs = Date.parse(identity.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return false;
  const ttl = identity.status === 'READY' ? READY_TTL_MS : UNAVAILABLE_TTL_MS;
  return nowMs - checkedAtMs >= 0 && nowMs - checkedAtMs < ttl;
}

module.exports = {
  createInstrumentIdentityService,
  normalizeLogoResponse,
  normalizeStoredIdentity,
  isFreshIdentity,
  providerSymbolFor,
};
