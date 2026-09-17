'use strict';

const { AppError } = require('../../shared/errors/app-error');
const {
  ROUNDING,
  normalizeDecimal,
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  compareDecimal,
  quantizeToStep,
  assertPositiveDecimal,
} = require('../../shared/decimal/decimal');
const { planPositionProtection } = require('./position-protection-planner');

function planTrailingConfiguration({ position, instrument, quote, enabled, distancePoints, nowMs = Date.now() }) {
  validateOpenPosition(position);
  if (!enabled) {
    return Object.freeze({
      enabled: false,
      distancePoints: null,
      bestPrice: null,
      stopLoss: decimalOrNull(position.stopLoss),
      activatedAt: null,
      changed: Boolean(position.trailing?.enabled),
    });
  }

  const distance = normalizeDistance(distancePoints);
  const pointSize = instrumentPointSize(instrument);
  const bestPrice = executablePrice(position.side, quote);
  const candidate = trailingStopFromBest({ side: position.side, bestPrice, distancePoints: distance, pointSize });
  const nextStopLoss = tighterStop(position.side, decimalOrNull(position.stopLoss), candidate);

  planPositionProtection({
    position,
    instrument,
    quote,
    stopLoss: nextStopLoss,
    takeProfit: undefined,
    nowMs,
  });

  return Object.freeze({
    enabled: true,
    distancePoints: distance,
    bestPrice,
    stopLoss: nextStopLoss,
    activatedAt: position.trailing?.activatedAt || new Date(nowMs),
    changed: !position.trailing?.enabled
      || !sameDecimal(position.trailing?.distancePoints, distance)
      || !sameDecimal(position.trailing?.bestPrice, bestPrice)
      || !sameDecimal(position.stopLoss, nextStopLoss),
  });
}

function planTrailingAdvance({ position, instrument, tick, nowMs = Date.now() }) {
  if (!position || String(position.status || '').toUpperCase() !== 'OPEN' || !position.trailing?.enabled) return null;
  if (!tick || tick.isStale) return null;

  const distance = normalizeDistance(position.trailing.distancePoints);
  const pointSize = instrumentPointSize(instrument);
  const current = executablePrice(position.side, tick);
  const previousBest = decimalOrNull(position.trailing.bestPrice);
  const bestPrice = favorableBest(position.side, previousBest, current);
  const candidate = trailingStopFromBest({ side: position.side, bestPrice, distancePoints: distance, pointSize });
  const currentStop = decimalOrNull(position.stopLoss);
  const nextStopLoss = tighterStop(position.side, currentStop, candidate);
  const bestPriceChanged = !sameDecimal(previousBest, bestPrice);
  const stopChanged = !sameDecimal(currentStop, nextStopLoss);

  if (stopChanged) {
    planPositionProtection({
      position,
      instrument,
      quote: tick,
      stopLoss: nextStopLoss,
      takeProfit: undefined,
      nowMs,
    });
  }

  return Object.freeze({
    bestPrice,
    stopLoss: nextStopLoss,
    bestPriceChanged,
    stopChanged,
    changed: bestPriceChanged || stopChanged,
    executablePrice: current,
  });
}

function trailingStopFromBest({ side, bestPrice, distancePoints, pointSize }) {
  const distance = multiplyDecimal(distancePoints, pointSize);
  const raw = String(side).toUpperCase() === 'BUY'
    ? subtractDecimal(bestPrice, distance)
    : addDecimal(bestPrice, distance);
  const rounding = String(side).toUpperCase() === 'BUY' ? ROUNDING.FLOOR : ROUNDING.CEIL;
  return quantizeToStep(raw, pointSize, rounding);
}

function favorableBest(side, previousBest, current) {
  if (previousBest == null) return current;
  if (String(side).toUpperCase() === 'BUY') return compareDecimal(current, previousBest) > 0 ? current : previousBest;
  return compareDecimal(current, previousBest) < 0 ? current : previousBest;
}

function tighterStop(side, existing, candidate) {
  if (existing == null) return candidate;
  if (String(side).toUpperCase() === 'BUY') return compareDecimal(candidate, existing) > 0 ? candidate : existing;
  return compareDecimal(candidate, existing) < 0 ? candidate : existing;
}

function executablePrice(side, quote) {
  const raw = String(side).toUpperCase() === 'BUY' ? quote?.bid : quote?.ask;
  try {
    const normalized = assertPositiveDecimal(raw, 'executablePrice');
    return normalized;
  } catch (_error) {
    throw new AppError('Executable trailing price is unavailable', { statusCode: 503, code: 'EXECUTABLE_QUOTE_UNAVAILABLE' });
  }
}

function normalizeDistance(value) {
  try {
    return assertPositiveDecimal(value, 'distancePoints');
  } catch (error) {
    throw new AppError(error.message, { statusCode: 400, code: 'INVALID_TRAILING_DISTANCE' });
  }
}

function instrumentPointSize(instrument) {
  if (!instrument?.tickSize) throw new AppError('Instrument tick size is unavailable', { statusCode: 409, code: 'INVALID_INSTRUMENT_TICK_SIZE' });
  return normalizeDecimal(instrument.tickSize);
}

function validateOpenPosition(position) {
  if (!position) throw new AppError('Position was not found', { statusCode: 404, code: 'POSITION_NOT_FOUND' });
  if (String(position.status || '').toUpperCase() !== 'OPEN') {
    throw new AppError('Position is not open', { statusCode: 409, code: 'POSITION_NOT_OPEN' });
  }
}

function decimalOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return normalizeDecimal(value?.toString ? value.toString() : String(value));
}

function sameDecimal(left, right) {
  const a = decimalOrNull(left);
  const b = decimalOrNull(right);
  if (a == null || b == null) return a == null && b == null;
  return compareDecimal(a, b) === 0;
}

module.exports = {
  planTrailingConfiguration,
  planTrailingAdvance,
  trailingStopFromBest,
  favorableBest,
  tighterStop,
};
