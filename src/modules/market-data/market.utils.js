'use strict';

function normalizeSymbol(value) {
  return String(value || '').trim().replace('/', '').toUpperCase();
}

function defaultTwelveDataSymbol(symbol) {
  const canonical = normalizeSymbol(symbol);
  if (canonical === 'US30') return 'DJI';
  if (/^[A-Z]{6}$/.test(canonical)) return `${canonical.slice(0, 3)}/${canonical.slice(3)}`;
  return canonical;
}

function decimalToNumber(value, fallback = null) {
  if (value == null) return fallback;
  const numeric = Number(typeof value === 'object' && typeof value.toString === 'function' ? value.toString() : value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function mapValue(mapLike, key) {
  if (!mapLike) return null;
  if (mapLike instanceof Map) return mapLike.get(key) ?? null;
  return mapLike[key] ?? null;
}

function serializeCandle(candle) {
  const openTimeMs = candle.openTimeMs ?? new Date(candle.openTime).getTime();
  const closeTimeMs = candle.closeTimeMs ?? new Date(candle.closeTime).getTime();
  return {
    symbol: normalizeSymbol(candle.symbol),
    timeframe: candle.timeframe,
    time: Math.floor(openTimeMs / 1000),
    openTimeMs,
    closeTimeMs,
    open: decimalToNumber(candle.open),
    high: decimalToNumber(candle.high),
    low: decimalToNumber(candle.low),
    close: decimalToNumber(candle.close),
    tickCount: Number(candle.tickCount || 0),
    providerVolume: decimalToNumber(candle.providerVolume),
    complete: Boolean(candle.complete),
    synthetic: Boolean(candle.synthetic),
    source: candle.source || 'LIVE',
    provider: candle.provider || null,
  };
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
}

module.exports = {
  normalizeSymbol,
  defaultTwelveDataSymbol,
  decimalToNumber,
  mapValue,
  serializeCandle,
  clampInteger,
};
