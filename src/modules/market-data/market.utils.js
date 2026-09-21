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

function nonNegativeNumber(value) {
  const numeric = decimalToNumber(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
}

function mapValue(mapLike, key) {
  if (!mapLike) return null;
  if (mapLike instanceof Map) return mapLike.get(key) ?? null;
  return mapLike[key] ?? null;
}

function resolveCandleVolume(candle, preferredSource = candle?.volumeMode || null) {
  const providerVolume = nonNegativeNumber(candle?.providerVolume);
  const tickCount = nonNegativeNumber(candle?.tickCount);
  const baseline = nonNegativeNumber(candle?.providerVolumeBaseline);
  const liveAnchor = nonNegativeNumber(candle?.providerVolumeLiveAnchor);
  const providerDisplay = baseline != null && liveAnchor != null
    ? baseline + Math.max(0, (providerVolume ?? liveAnchor) - liveAnchor)
    : providerVolume;

  if (preferredSource === 'provider') {
    return { displayVolume: providerDisplay, volumeSource: providerDisplay == null ? 'unavailable' : 'provider' };
  }
  if (preferredSource === 'tick') {
    return { displayVolume: tickCount, volumeSource: tickCount == null ? 'unavailable' : 'tick' };
  }
  if (preferredSource === 'unavailable') {
    return { displayVolume: null, volumeSource: 'unavailable' };
  }
  if (providerDisplay != null && providerDisplay > 0) {
    return { displayVolume: providerDisplay, volumeSource: 'provider' };
  }
  if (tickCount != null && tickCount > 0) {
    return { displayVolume: tickCount, volumeSource: 'tick' };
  }
  if (providerDisplay != null) {
    return { displayVolume: providerDisplay, volumeSource: 'provider' };
  }
  if (tickCount != null) {
    return { displayVolume: tickCount, volumeSource: 'tick' };
  }
  return { displayVolume: null, volumeSource: 'unavailable' };
}

function serializeCandle(candle) {
  const openTimeMs = candle.openTimeMs ?? new Date(candle.openTime).getTime();
  const closeTimeMs = candle.closeTimeMs ?? new Date(candle.closeTime).getTime();
  const volumeMode = ['provider', 'tick', 'unavailable'].includes(candle.volumeMode) ? candle.volumeMode : null;
  const resolvedVolume = resolveCandleVolume(candle, volumeMode);
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
    displayVolume: resolvedVolume.displayVolume,
    volumeSource: resolvedVolume.volumeSource,
    volumeMode,
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
  resolveCandleVolume,
  serializeCandle,
  clampInteger,
};
