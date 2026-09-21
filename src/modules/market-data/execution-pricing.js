'use strict';

class ExecutionPricingService {
  constructor({ movementAlpha = 0.15 } = {}) {
    this.movementAlpha = Math.min(1, Math.max(0.01, Number(movementAlpha) || 0.15));
    this.state = new Map();
  }

  priceQuote({ raw, instrument, nowMs = Date.now() } = {}) {
    const tickSize = positiveNumber(instrument?.tickSize);
    const last = positiveNumber(raw?.price);
    if (!tickSize || !last) return emptyPricing(last);

    const providerBid = positiveNumber(raw?.bid);
    const providerAsk = positiveNumber(raw?.ask);
    const providerBookValid = Boolean(providerBid && providerAsk && providerAsk >= providerBid);
    const providerSpreadPoints = providerBookValid ? Math.max(0, (providerAsk - providerBid) / tickSize) : null;
    const referencePrice = providerBookValid ? (providerBid + providerAsk) / 2 : last;
    const policy = normalizeSpreadPolicy(instrument?.spread);
    const mode = policy.mode;

    this.#observe(instrument?.symbol, referencePrice, tickSize);
    const volatilityMultiplier = this.#volatilityMultiplier(instrument?.symbol, policy.normalPoints);
    const sessionMultiplier = rolloverMultiplier(policy, nowMs);

    if (mode === 'MARKET') {
      if (!providerBookValid) return emptyPricing(referencePrice, { providerSpreadPoints, pricingModel: 'PROVIDER_MARKET' });
      const markupWidth = policy.markupPoints * tickSize;
      return finalizePricing({
        referencePrice,
        bid: providerBid - markupWidth / 2,
        ask: providerAsk + markupWidth / 2,
        tickSize,
        providerSpreadPoints,
        pricingModel: 'PROVIDER_MARKET',
        spreadSource: policy.markupPoints > 0 ? 'PROVIDER_BOOK_PLUS_MARKUP' : 'PROVIDER_BOOK',
        isSyntheticSpread: false,
        volatilityMultiplier: 1,
        sessionMultiplier: 1,
      });
    }

    if (mode === 'FIXED' || mode === 'SYNTHETIC') {
      if (providerBookValid) {
        const markupWidth = policy.markupPoints * tickSize;
        return finalizePricing({
          referencePrice,
          bid: providerBid - markupWidth / 2,
          ask: providerAsk + markupWidth / 2,
          tickSize,
          providerSpreadPoints,
          pricingModel: 'LEGACY_PROVIDER_BOOK',
          spreadSource: policy.markupPoints > 0 ? 'PROVIDER_BOOK_PLUS_MARKUP' : 'PROVIDER_BOOK',
          isSyntheticSpread: false,
          volatilityMultiplier: 1,
          sessionMultiplier: 1,
        });
      }
      return syntheticPricing({
        referencePrice,
        tickSize,
        points: Math.max(0, policy.fixedPoints + policy.markupPoints),
        providerSpreadPoints,
        pricingModel: 'LEGACY_SYNTHETIC',
        spreadSource: 'FIXED_FALLBACK',
        volatilityMultiplier: 1,
        sessionMultiplier: 1,
      });
    }

    const profilePoints = policy.normalPoints * volatilityMultiplier * sessionMultiplier;
    const marketObservedPoints = Number.isFinite(providerSpreadPoints) ? providerSpreadPoints : 0;
    const targetPoints = clamp(
      Math.max(policy.minimumPoints, profilePoints, marketObservedPoints) + policy.markupPoints,
      policy.minimumPoints,
      policy.maximumPoints,
    );

    return syntheticPricing({
      referencePrice,
      tickSize,
      points: targetPoints,
      providerSpreadPoints,
      pricingModel: 'ACG_DYNAMIC',
      spreadSource: Number.isFinite(providerSpreadPoints) && providerSpreadPoints >= profilePoints
        ? 'PROVIDER_SPREAD_FLOOR'
        : 'ACG_SPREAD_PROFILE',
      volatilityMultiplier,
      sessionMultiplier,
    });
  }

  #observe(symbol, referencePrice, tickSize) {
    const key = String(symbol || '').toUpperCase();
    if (!key) return;
    const previous = this.state.get(key);
    if (!previous) {
      this.state.set(key, { referencePrice, ewmaMovePoints: 0 });
      return;
    }
    const movementPoints = Math.abs(referencePrice - previous.referencePrice) / tickSize;
    const ewmaMovePoints = previous.ewmaMovePoints * (1 - this.movementAlpha) + movementPoints * this.movementAlpha;
    this.state.set(key, { referencePrice, ewmaMovePoints });
  }

  #volatilityMultiplier(symbol, normalPoints) {
    const state = this.state.get(String(symbol || '').toUpperCase());
    const movement = Number(state?.ewmaMovePoints || 0);
    const baseline = Math.max(1, Number(normalPoints) || 1);
    if (movement >= baseline * 12) return 2;
    if (movement >= baseline * 6) return 1.5;
    if (movement >= baseline * 3) return 1.2;
    return 1;
  }
}

function executionPriceForVolume({ quote, instrument, side, volume } = {}) {
  const normalizedSide = String(side || '').toUpperCase();
  const tickSize = positiveNumber(instrument?.tickSize);
  const basePrice = positiveNumber(normalizedSide === 'BUY' ? quote?.ask : quote?.bid);
  const baseResult = {
    price: basePrice,
    liquidityAdjustmentPoints: 0,
    volumeBand: null,
    spreadPoints: finiteOrNull(quote?.spreadPoints),
    providerSpreadPoints: finiteOrNull(quote?.providerSpreadPoints),
    referencePrice: finiteOrNull(quote?.referencePrice ?? quote?.mid ?? quote?.price),
    executionBid: finiteOrNull(quote?.bid),
    executionAsk: finiteOrNull(quote?.ask),
    pricingModel: quote?.pricingModel || null,
  };
  if (!tickSize || !basePrice || !['BUY', 'SELL'].includes(normalizedSide)) return baseResult;

  const band = volumeBandFor(instrument?.spread?.volumeBands, volume);
  const extraPoints = Math.max(0, numberValue(band?.extraPoints, 0));
  return {
    ...baseResult,
    price: normalizedSide === 'BUY' ? basePrice + extraPoints * tickSize : basePrice - extraPoints * tickSize,
    liquidityAdjustmentPoints: extraPoints,
    volumeBand: bandLabel(band),
  };
}

function volumeBandFor(bands, volume) {
  const rows = Array.isArray(bands) ? bands : [];
  const requested = Math.max(0, numberValue(volume, 0));
  for (const row of rows) {
    const upTo = row?.upTo == null ? null : numberValue(row.upTo, null);
    if (upTo == null || requested <= upTo) return row;
  }
  return rows.length ? rows[rows.length - 1] : null;
}

function bandLabel(band) {
  if (!band) return null;
  if (band.upTo == null) return 'ABOVE_MAX_BAND';
  return `UP_TO_${numberValue(band.upTo, 0)}`;
}

function normalizeSpreadPolicy(spread = {}) {
  const mode = String(spread?.mode || 'MARKET').toUpperCase();
  const fixedPoints = Math.max(0, numberValue(spread?.fixedPoints, 0));
  const normalPoints = Math.max(0, numberValue(spread?.normalPoints, fixedPoints));
  const minimumPoints = Math.max(0, numberValue(spread?.minimumPoints, normalPoints));
  const maximumPoints = Math.max(minimumPoints, numberValue(spread?.maximumPoints, Math.max(minimumPoints, normalPoints * 20 || 100)));
  return {
    mode,
    fixedPoints,
    normalPoints,
    minimumPoints,
    maximumPoints,
    markupPoints: Math.max(0, numberValue(spread?.markupPoints, 0)),
    rolloverMultiplier: Math.max(1, numberValue(spread?.rolloverMultiplier, 1)),
    rolloverStartUtcMinute: minuteOfDay(spread?.rolloverStartUtcMinute),
    rolloverEndUtcMinute: minuteOfDay(spread?.rolloverEndUtcMinute),
  };
}

function rolloverMultiplier(policy, nowMs) {
  const start = policy.rolloverStartUtcMinute;
  const end = policy.rolloverEndUtcMinute;
  if (start == null || end == null || policy.rolloverMultiplier <= 1) return 1;
  const date = new Date(nowMs);
  const minute = date.getUTCHours() * 60 + date.getUTCMinutes();
  const active = start <= end ? minute >= start && minute <= end : minute >= start || minute <= end;
  return active ? policy.rolloverMultiplier : 1;
}

function syntheticPricing({ referencePrice, tickSize, points, providerSpreadPoints, pricingModel, spreadSource, volatilityMultiplier, sessionMultiplier }) {
  const width = Math.max(0, points) * tickSize;
  return finalizePricing({
    referencePrice,
    bid: floorToTick(referencePrice - width / 2, tickSize),
    ask: ceilToTick(referencePrice + width / 2, tickSize),
    tickSize,
    providerSpreadPoints,
    pricingModel,
    spreadSource,
    isSyntheticSpread: true,
    volatilityMultiplier,
    sessionMultiplier,
  });
}

function finalizePricing({ referencePrice, bid, ask, tickSize, providerSpreadPoints, pricingModel, spreadSource, isSyntheticSpread, volatilityMultiplier, sessionMultiplier }) {
  const valid = Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && ask >= bid;
  if (!valid) return emptyPricing(referencePrice, { providerSpreadPoints, pricingModel });
  const spread = ask - bid;
  return {
    referencePrice,
    bid,
    ask,
    mid: (bid + ask) / 2,
    spread,
    spreadPoints: tickSize > 0 ? spread / tickSize : null,
    providerSpreadPoints,
    pricingModel,
    spreadSource,
    volatilityMultiplier,
    sessionMultiplier,
    isSyntheticSpread: Boolean(isSyntheticSpread),
  };
}

function emptyPricing(referencePrice = null, extra = {}) {
  return {
    referencePrice: finiteOrNull(referencePrice),
    bid: null,
    ask: null,
    mid: finiteOrNull(referencePrice),
    spread: null,
    spreadPoints: null,
    providerSpreadPoints: extra.providerSpreadPoints ?? null,
    pricingModel: extra.pricingModel || null,
    spreadSource: null,
    volatilityMultiplier: 1,
    sessionMultiplier: 1,
    isSyntheticSpread: false,
  };
}

function floorToTick(value, tickSize) { return tidy(Math.floor((value + tickSize * 1e-9) / tickSize) * tickSize); }
function ceilToTick(value, tickSize) { return tidy(Math.ceil((value - tickSize * 1e-9) / tickSize) * tickSize); }
function tidy(value) { return Number(Number(value).toPrecision(14)); }
function positiveNumber(value) { const n = numberValue(value, null); return n != null && n > 0 ? n : null; }
function finiteOrNull(value) { const n = numberValue(value, null); return n == null ? null : n; }
function numberValue(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value?.toString ? value.toString() : value);
  return Number.isFinite(n) ? n : fallback;
}
function minuteOfDay(value) {
  const n = numberValue(value, null);
  return n != null && Number.isInteger(n) && n >= 0 && n <= 1439 ? n : null;
}
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }

module.exports = { ExecutionPricingService, executionPriceForVolume, volumeBandFor, normalizeSpreadPolicy, rolloverMultiplier };
