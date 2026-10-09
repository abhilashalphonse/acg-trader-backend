'use strict';

const { AppError } = require('../../shared/errors/app-error');
const {
  ROUNDING, normalizeDecimal, compareDecimal, multiplyDecimal, divideDecimal,
  subtractDecimal,
} = require('../../shared/decimal/decimal');

// Every probe delegates to the authoritative execution planner. This retains
// the real spread, volume tiers, FX liability convention, commission and
// available-margin checks instead of building a second sizing calculator.
function sizeMarketOrder({
  mode,
  amount,
  instrument,
  evaluate,
  maxIterations = 128,
}) {
  const normalizedMode = String(mode || '').toUpperCase();
  if (!['RISK', 'AMOUNT'].includes(normalizedMode)) {
    throw new AppError('Unsupported order sizing mode', { statusCode: 400, code: 'INVALID_SIZING_MODE' });
  }
  const budget = normalizeDecimal(amount);
  if (compareDecimal(budget, '0') <= 0) {
    throw new AppError('Sizing budget must be positive', { statusCode: 400, code: 'INVALID_SIZING_BUDGET' });
  }
  const step = normalizeDecimal(instrument?.volumeStep || '0');
  const min = normalizeDecimal(instrument?.minVolume || step);
  const max = normalizeDecimal(instrument?.maxVolume || '0');
  if (compareDecimal(step, '0') <= 0 || compareDecimal(max, min) < 0) {
    throw new AppError('Instrument sizing limits are invalid', { statusCode: 409, code: 'INSTRUMENT_SIZING_UNAVAILABLE' });
  }

  const minUnits = BigInt(divideDecimal(min, step, { scale: 0, rounding: ROUNDING.CEIL }));
  const maxUnits = BigInt(divideDecimal(max, step, { scale: 0, rounding: ROUNDING.DOWN }));
  if (minUnits <= 0n || maxUnits < minUnits) {
    throw new AppError('No valid volume meets instrument limits', { statusCode: 409, code: 'INSTRUMENT_SIZING_UNAVAILABLE' });
  }

  let low = minUnits;
  let high = maxUnits;
  let selected = null;
  let iterations = 0;

  while (low <= high) {
    if (++iterations > maxIterations) {
      throw new AppError('Sizing precision exceeds supported limits', { statusCode: 409, code: 'SIZING_ITERATION_LIMIT' });
    }
    const units = (low + high) / 2n;
    const volume = multiplyDecimal(units.toString(), step);
    let plan;
    try {
      plan = evaluate(volume);
    } catch (error) {
      // Margin or risk-policy rejection can only reduce the permissible volume.
      // Other errors (e.g., missing FX, session closure, invalid SL) must
      // fail the preview instead of silently turning into a smaller order.
      if (!['INSUFFICIENT_MARGIN', 'MAX_TRADE_RISK', 'MAX_AGGREGATE_RISK',
        'MAX_MARGIN_USAGE', 'MAX_SINGLE_ORDER_EXPOSURE', 'MAX_SYMBOL_EXPOSURE',
        'MAX_POSITION_VOLUME_REACHED', 'MAX_TOTAL_VOLUME_REACHED', 'MAX_SYMBOL_VOLUME_REACHED'].includes(error?.code)) throw error;
      high = units - 1n;
      continue;
    }

    const cost = normalizedMode === 'RISK'
      ? plan.riskAmount
      : plan.exposureAccountCurrency;
    if (cost == null) {
      throw new AppError('Authoritative sizing amount unavailable', { statusCode: 409, code: 'SIZING_AMOUNT_UNAVAILABLE' });
    }
    if (compareDecimal(cost, budget) <= 0) {
      selected = { plan, volume, actualAmount: normalizeDecimal(cost) };
      low = units + 1n;
    } else {
      high = units - 1n;
    }
  }

  if (!selected) {
    throw new AppError('Budget cannot purchase the minimum instrument quantity', {
      statusCode: 409,
      code: 'SIZING_BELOW_MIN_VOLUME',
      details: { budget, minVolume: min, volumeStep: step },
    });
  }
  return Object.freeze({
    mode: normalizedMode,
    requestedAmount: budget,
    volume: selected.volume,
    actualAmount: selected.actualAmount,
    unusedBudget: subtractDecimal(budget, selected.actualAmount),
    plan: selected.plan,
  });
}

module.exports = { sizeMarketOrder };
