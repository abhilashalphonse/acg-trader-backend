'use strict';

const { AppError } = require('../../shared/errors/app-error');
const {
  normalizeDecimal,
  compareDecimal,
  isStepAligned,
  assertPositiveDecimal,
} = require('../../shared/decimal/decimal');
const { normalizeSymbol } = require('../market-data/market.utils');
const {
  validateAccountForOpen,
  validateInstrumentForOpen,
  validateVolume,
} = require('./execution-planner');

const PENDING_TYPES = Object.freeze(['LIMIT', 'STOP', 'STOP_LIMIT']);
const PENDING_STATUSES = Object.freeze(['PENDING', 'TRIGGERED']);
const TIME_IN_FORCE = Object.freeze(['GTC', 'TODAY', 'SPECIFIED']);

function planPendingOrder({
  account,
  instrument,
  quote,
  type,
  side,
  volume,
  limitPrice = null,
  stopPrice = null,
  stopLoss = null,
  takeProfit = null,
  timeInForce = 'GTC',
  expiresAt = null,
  nowMs = Date.now(),
}) {
  validateAccountForOpen(account, instrument?.symbol);
  validateInstrumentForOpen(instrument);
  validateLiveQuote(quote, instrument, nowMs);

  const normalizedType = normalizeType(type);
  const normalizedSide = normalizeSide(side);
  const normalizedVolume = validateVolume(volume, instrument);
  const normalizedLimit = optionalAlignedPrice(limitPrice, instrument, 'limitPrice');
  const normalizedStop = optionalAlignedPrice(stopPrice, instrument, 'stopPrice');
  const normalizedStopLoss = optionalAlignedPrice(stopLoss, instrument, 'stopLoss');
  const normalizedTakeProfit = optionalAlignedPrice(takeProfit, instrument, 'takeProfit');

  requirePendingPrices(normalizedType, normalizedLimit, normalizedStop);
  validatePlacementRelation({
    type: normalizedType,
    side: normalizedSide,
    limitPrice: normalizedLimit,
    stopPrice: normalizedStop,
    quote,
  });

  const protectionReference = normalizedType === 'STOP' ? normalizedStop : normalizedLimit;
  validateProtectionAroundReference({
    side: normalizedSide,
    referencePrice: protectionReference,
    stopLoss: normalizedStopLoss,
    takeProfit: normalizedTakeProfit,
  });

  const expiry = resolveExpiry({
    timeInForce,
    expiresAt,
    riskTimezone: account.riskTimezone || 'UTC',
    nowMs,
  });

  return Object.freeze({
    symbol: normalizeSymbol(instrument.symbol),
    type: normalizedType,
    side: normalizedSide,
    volume: normalizedVolume,
    limitPrice: normalizedLimit,
    stopPrice: normalizedStop,
    stopLoss: normalizedStopLoss,
    takeProfit: normalizedTakeProfit,
    timeInForce: expiry.timeInForce,
    expiresAt: expiry.expiresAt,
  });
}

function detectPendingOrderAction({ order, tick, nowMs = Date.now() }) {
  if (!order || !PENDING_STATUSES.includes(String(order.status || '').toUpperCase())) return null;

  const expiresAt = dateMs(order.expiresAt);
  if (expiresAt != null && nowMs >= expiresAt) return Object.freeze({ action: 'EXPIRE' });
  if (!tick || tick.isStale) return null;

  const symbol = normalizeSymbol(order.symbol);
  if (!symbol || symbol !== normalizeSymbol(tick.symbol)) return null;
  const side = normalizeSide(order.side);
  const rawExecutable = side === 'BUY' ? tick.ask : tick.bid;
  const numericExecutable = Number(rawExecutable);
  if (!Number.isFinite(numericExecutable) || numericExecutable <= 0) return null;
  const executablePrice = normalizeDecimal(String(numericExecutable));

  const type = normalizeType(order.type);
  const status = String(order.status).toUpperCase();
  const limitPrice = decimalOrNull(order.limitPrice);
  const stopPrice = decimalOrNull(order.stopPrice);

  if (type === 'LIMIT' && status === 'PENDING' && limitCondition(side, executablePrice, limitPrice)) {
    return action('FILL', executablePrice, tick);
  }
  if (type === 'STOP' && status === 'PENDING' && stopCondition(side, executablePrice, stopPrice)) {
    return action('FILL', executablePrice, tick);
  }
  if (type === 'STOP_LIMIT' && status === 'PENDING' && stopCondition(side, executablePrice, stopPrice)) {
    return action('ACTIVATE', executablePrice, tick);
  }
  if (type === 'STOP_LIMIT' && status === 'TRIGGERED' && limitCondition(side, executablePrice, limitPrice)) {
    return action('FILL', executablePrice, tick);
  }
  return null;
}

function validatePlacementRelation({ type, side, limitPrice, stopPrice, quote }) {
  const ask = normalizeDecimal(String(quote.ask));
  const bid = normalizeDecimal(String(quote.bid));

  if (type === 'LIMIT') {
    const valid = side === 'BUY'
      ? compareDecimal(limitPrice, ask) < 0
      : compareDecimal(limitPrice, bid) > 0;
    if (!valid) throw invalidPendingPrice(`${side} LIMIT must be placed away from the current executable market price`);
  }

  if (type === 'STOP' || type === 'STOP_LIMIT') {
    const validStop = side === 'BUY'
      ? compareDecimal(stopPrice, ask) > 0
      : compareDecimal(stopPrice, bid) < 0;
    if (!validStop) throw invalidPendingPrice(`${side} STOP trigger must be beyond the current executable market price`);
  }

  if (type === 'STOP_LIMIT') {
    const validLimit = side === 'BUY'
      ? compareDecimal(limitPrice, stopPrice) >= 0
      : compareDecimal(limitPrice, stopPrice) <= 0;
    if (!validLimit) {
      throw invalidPendingPrice(side === 'BUY'
        ? 'BUY STOP_LIMIT limitPrice must be at or above stopPrice'
        : 'SELL STOP_LIMIT limitPrice must be at or below stopPrice');
    }
  }
}

function validateProtectionAroundReference({ side, referencePrice, stopLoss, takeProfit }) {
  if (referencePrice == null) return;
  if (side === 'BUY') {
    if (stopLoss != null && compareDecimal(stopLoss, referencePrice) >= 0) throw invalidProtection('BUY stop loss must be below the pending entry reference');
    if (takeProfit != null && compareDecimal(takeProfit, referencePrice) <= 0) throw invalidProtection('BUY take profit must be above the pending entry reference');
  } else {
    if (stopLoss != null && compareDecimal(stopLoss, referencePrice) <= 0) throw invalidProtection('SELL stop loss must be above the pending entry reference');
    if (takeProfit != null && compareDecimal(takeProfit, referencePrice) >= 0) throw invalidProtection('SELL take profit must be below the pending entry reference');
  }
}

function resolveExpiry({ timeInForce, expiresAt, riskTimezone = 'UTC', nowMs = Date.now() }) {
  const tif = String(timeInForce || 'GTC').toUpperCase();
  if (!TIME_IN_FORCE.includes(tif)) {
    throw new AppError('Unsupported time in force', { statusCode: 400, code: 'INVALID_TIME_IN_FORCE' });
  }
  if (tif === 'GTC') return { timeInForce: tif, expiresAt: null };
  if (tif === 'TODAY') return { timeInForce: tif, expiresAt: new Date(nextLocalMidnightMs(nowMs, riskTimezone)) };

  const timestamp = dateMs(expiresAt);
  if (timestamp == null || timestamp <= nowMs) {
    throw new AppError('SPECIFIED expiry must be a future timestamp', { statusCode: 400, code: 'INVALID_ORDER_EXPIRY' });
  }
  return { timeInForce: tif, expiresAt: new Date(timestamp) };
}

function nextLocalMidnightMs(nowMs, timeZone) {
  const current = zonedDateParts(nowMs, timeZone);
  const nextDate = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  const desiredUtcPartsMs = Date.UTC(
    nextDate.getUTCFullYear(),
    nextDate.getUTCMonth(),
    nextDate.getUTCDate(),
    0, 0, 0, 0,
  );

  let candidate = desiredUtcPartsMs;
  for (let i = 0; i < 3; i += 1) {
    candidate = desiredUtcPartsMs - timeZoneOffsetMs(candidate, timeZone);
  }
  return candidate;
}

function timeZoneOffsetMs(timestamp, timeZone) {
  const parts = zonedDateTimeParts(timestamp, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(timestamp / 1000) * 1000;
}

function zonedDateParts(timestamp, timeZone) {
  const parts = zonedDateTimeParts(timestamp, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

function zonedDateTimeParts(timestamp, timeZone) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hourCycle: 'h23',
    });
  } catch (_error) {
    throw new AppError('Invalid account risk timezone', { statusCode: 409, code: 'INVALID_RISK_TIMEZONE', details: { timeZone } });
  }
  const values = {};
  for (const part of formatter.formatToParts(new Date(timestamp))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  return values;
}

function validateLiveQuote(quote, instrument, nowMs) {
  if (!quote) throw new AppError('No live quote is available for this symbol', { statusCode: 503, code: 'QUOTE_UNAVAILABLE' });
  const receivedAtMs = Number(quote.receivedAtMs);
  const maxAgeMs = Number(instrument.maxQuoteAgeMs || 5000);
  const ageMs = Number.isFinite(receivedAtMs) ? Math.max(0, nowMs - receivedAtMs) : Number.POSITIVE_INFINITY;
  if (quote.isStale || ageMs > maxAgeMs) {
    throw new AppError('Market quote is stale', { statusCode: 503, code: 'QUOTE_STALE', details: { ageMs: Number.isFinite(ageMs) ? ageMs : null, maxAgeMs } });
  }
  if (!Number.isFinite(Number(quote.bid)) || !Number.isFinite(Number(quote.ask))) {
    throw new AppError('Executable bid/ask is unavailable', { statusCode: 503, code: 'EXECUTABLE_QUOTE_UNAVAILABLE' });
  }
}

function optionalAlignedPrice(value, instrument, field) {
  if (value === null || value === undefined || value === '') return null;
  let normalized;
  try {
    normalized = assertPositiveDecimal(value, field);
  } catch (error) {
    throw new AppError(error.message, { statusCode: 400, code: 'INVALID_PRICE' });
  }
  if (!isStepAligned(normalized, instrument.tickSize)) {
    throw new AppError(`${field} is not aligned to the instrument tick size`, {
      statusCode: 400,
      code: 'INVALID_PRICE_STEP',
      details: { field, price: normalized, tickSize: normalizeDecimal(instrument.tickSize) },
    });
  }
  return normalized;
}

function requirePendingPrices(type, limitPrice, stopPrice) {
  if (type === 'LIMIT' && limitPrice == null) throw missingPrice('LIMIT orders require limitPrice');
  if (type === 'STOP' && stopPrice == null) throw missingPrice('STOP orders require stopPrice');
  if (type === 'STOP_LIMIT' && (stopPrice == null || limitPrice == null)) throw missingPrice('STOP_LIMIT orders require stopPrice and limitPrice');
}

function limitCondition(side, executablePrice, limitPrice) {
  if (limitPrice == null) return false;
  return side === 'BUY'
    ? compareDecimal(executablePrice, limitPrice) <= 0
    : compareDecimal(executablePrice, limitPrice) >= 0;
}

function stopCondition(side, executablePrice, stopPrice) {
  if (stopPrice == null) return false;
  return side === 'BUY'
    ? compareDecimal(executablePrice, stopPrice) >= 0
    : compareDecimal(executablePrice, stopPrice) <= 0;
}

function action(actionName, executablePrice, tick) {
  return Object.freeze({
    action: actionName,
    executablePrice,
    quoteSequence: tick.sequence ?? null,
    quoteReceivedAtMs: tick.receivedAtMs ?? null,
  });
}

function normalizeType(type) {
  const value = String(type || '').toUpperCase();
  if (!PENDING_TYPES.includes(value)) throw new AppError('Pending order type must be LIMIT, STOP or STOP_LIMIT', { statusCode: 400, code: 'INVALID_PENDING_ORDER_TYPE' });
  return value;
}

function normalizeSide(side) {
  const value = String(side || '').toUpperCase();
  if (!['BUY', 'SELL'].includes(value)) throw new AppError('Order side must be BUY or SELL', { statusCode: 400, code: 'INVALID_ORDER_SIDE' });
  return value;
}

function decimalOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return normalizeDecimal(value?.toString ? value.toString() : String(value));
}

function dateMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function invalidPendingPrice(message) {
  return new AppError(message, { statusCode: 400, code: 'INVALID_PENDING_PRICE' });
}
function invalidProtection(message) {
  return new AppError(message, { statusCode: 400, code: 'INVALID_PROTECTION_PRICE' });
}
function missingPrice(message) {
  return new AppError(message, { statusCode: 400, code: 'MISSING_PENDING_PRICE' });
}

module.exports = {
  planPendingOrder,
  detectPendingOrderAction,
  resolveExpiry,
  nextLocalMidnightMs,
  PENDING_TYPES,
};
