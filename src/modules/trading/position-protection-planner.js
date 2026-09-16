'use strict';

const { AppError } = require('../../shared/errors/app-error');
const {
  normalizeDecimal,
  compareDecimal,
  isStepAligned,
  assertPositiveDecimal,
} = require('../../shared/decimal/decimal');

function planPositionProtection({
  position,
  instrument,
  quote,
  stopLoss = undefined,
  takeProfit = undefined,
  breakEven = false,
  nowMs = Date.now(),
}) {
  validateOpenPosition(position);
  validateInstrument(instrument);
  validateQuote(quote, instrument, nowMs);

  const side = String(position.side || '').toUpperCase();
  if (!['BUY', 'SELL'].includes(side)) {
    throw new AppError('Position side is invalid', { statusCode: 409, code: 'INVALID_POSITION_SIDE' });
  }

  const executablePrice = executableClosePrice(side, quote);
  const currentStopLoss = decimalOrNull(position.stopLoss);
  const currentTakeProfit = decimalOrNull(position.takeProfit);

  let nextStopLoss;
  let nextTakeProfit;

  if (breakEven) {
    nextStopLoss = normalizeDecimal(position.entryPrice);
    nextTakeProfit = currentTakeProfit;
    validateBreakEvenAvailability({ side, entryPrice: nextStopLoss, executablePrice });
  } else {
    if (stopLoss === undefined && takeProfit === undefined) {
      throw new AppError('At least one protection field must be supplied', {
        statusCode: 400,
        code: 'PROTECTION_CHANGE_REQUIRED',
      });
    }
    nextStopLoss = stopLoss === undefined ? currentStopLoss : normalizeProtectionPrice(stopLoss, instrument, 'stopLoss');
    nextTakeProfit = takeProfit === undefined ? currentTakeProfit : normalizeProtectionPrice(takeProfit, instrument, 'takeProfit');
  }

  validateProtectionAgainstMarket({
    side,
    executablePrice,
    stopLoss: nextStopLoss,
    takeProfit: nextTakeProfit,
  });

  const changed = !sameDecimal(currentStopLoss, nextStopLoss) || !sameDecimal(currentTakeProfit, nextTakeProfit);

  return Object.freeze({
    positionId: String(position._id || position.id || ''),
    accountId: String(position.accountId || ''),
    symbol: String(position.symbol || '').toUpperCase(),
    side,
    stopLoss: nextStopLoss,
    takeProfit: nextTakeProfit,
    previousStopLoss: currentStopLoss,
    previousTakeProfit: currentTakeProfit,
    executablePrice,
    breakEven: Boolean(breakEven),
    changed,
    quoteSequence: quote.sequence ?? null,
    quoteReceivedAtMs: quote.receivedAtMs ?? null,
    quoteSource: quote.source ?? null,
  });
}

function validateOpenPosition(position) {
  if (!position) {
    throw new AppError('Position was not found', { statusCode: 404, code: 'POSITION_NOT_FOUND' });
  }
  if (String(position.status || '').toUpperCase() !== 'OPEN') {
    throw new AppError('Position is not open', { statusCode: 409, code: 'POSITION_NOT_OPEN' });
  }
  try {
    if (compareDecimal(position.openVolume, '0') <= 0) {
      throw new AppError('Position is not open', { statusCode: 409, code: 'POSITION_NOT_OPEN' });
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Position volume is invalid', { statusCode: 409, code: 'INVALID_POSITION_VOLUME' });
  }
}

function validateInstrument(instrument) {
  if (!instrument) {
    throw new AppError('Instrument was not found', { statusCode: 404, code: 'INSTRUMENT_NOT_FOUND' });
  }
  if (!instrument.tickSize) {
    throw new AppError('Instrument tick size is unavailable', { statusCode: 409, code: 'INVALID_INSTRUMENT_TICK_SIZE' });
  }
}

function validateQuote(quote, instrument, nowMs) {
  if (!quote) {
    throw new AppError('No live quote is available for this symbol', { statusCode: 503, code: 'QUOTE_UNAVAILABLE' });
  }
  const receivedAtMs = Number(quote.receivedAtMs);
  const maxAgeMs = Number(instrument.maxQuoteAgeMs || 5000);
  const ageMs = Number.isFinite(receivedAtMs) ? Math.max(0, nowMs - receivedAtMs) : Number.POSITIVE_INFINITY;
  if (quote.isStale || ageMs > maxAgeMs) {
    throw new AppError('Market quote is stale', {
      statusCode: 503,
      code: 'QUOTE_STALE',
      details: { ageMs: Number.isFinite(ageMs) ? ageMs : null, maxAgeMs },
    });
  }
}

function executableClosePrice(side, quote) {
  const raw = side === 'BUY' ? quote.bid : quote.ask;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new AppError('Executable close price is unavailable', {
      statusCode: 503,
      code: 'EXECUTABLE_QUOTE_UNAVAILABLE',
    });
  }
  return normalizeDecimal(String(numeric));
}

function normalizeProtectionPrice(value, instrument, field) {
  if (value === null || value === '') return null;
  let normalized;
  try {
    normalized = assertPositiveDecimal(value, field);
  } catch (error) {
    throw new AppError(error.message, { statusCode: 400, code: 'INVALID_PROTECTION_PRICE' });
  }
  if (!isStepAligned(normalized, instrument.tickSize)) {
    throw new AppError(`${field} is not aligned to the instrument tick size`, {
      statusCode: 400,
      code: 'INVALID_PROTECTION_PRICE_STEP',
      details: { field, price: normalized, tickSize: normalizeDecimal(instrument.tickSize) },
    });
  }
  return normalized;
}

function validateProtectionAgainstMarket({ side, executablePrice, stopLoss, takeProfit }) {
  if (side === 'BUY') {
    if (stopLoss != null && compareDecimal(stopLoss, executablePrice) >= 0) {
      throw invalidProtection('BUY stop loss must be below the current BID', { stopLoss, bid: executablePrice });
    }
    if (takeProfit != null && compareDecimal(takeProfit, executablePrice) <= 0) {
      throw invalidProtection('BUY take profit must be above the current BID', { takeProfit, bid: executablePrice });
    }
  } else {
    if (stopLoss != null && compareDecimal(stopLoss, executablePrice) <= 0) {
      throw invalidProtection('SELL stop loss must be above the current ASK', { stopLoss, ask: executablePrice });
    }
    if (takeProfit != null && compareDecimal(takeProfit, executablePrice) >= 0) {
      throw invalidProtection('SELL take profit must be below the current ASK', { takeProfit, ask: executablePrice });
    }
  }
}

function validateBreakEvenAvailability({ side, entryPrice, executablePrice }) {
  const favorable = side === 'BUY'
    ? compareDecimal(executablePrice, entryPrice) > 0
    : compareDecimal(executablePrice, entryPrice) < 0;
  if (!favorable) {
    throw new AppError('Break-even stop is not available until price has moved beyond entry', {
      statusCode: 409,
      code: 'BREAK_EVEN_NOT_AVAILABLE',
      details: { side, entryPrice, executablePrice },
    });
  }
}

function invalidProtection(message, details) {
  return new AppError(message, { statusCode: 400, code: 'INVALID_PROTECTION_PRICE', details });
}

function decimalOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return normalizeDecimal(value?.toString ? value.toString() : String(value));
}

function sameDecimal(left, right) {
  if (left == null || right == null) return left == null && right == null;
  return compareDecimal(left, right) === 0;
}

module.exports = {
  planPositionProtection,
  validateProtectionAgainstMarket,
  validateBreakEvenAvailability,
};
