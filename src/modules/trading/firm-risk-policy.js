'use strict';

const { AppError } = require('../../shared/errors/app-error');
const {
  ROUNDING,
  normalizeDecimal,
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  compareDecimal,
} = require('../../shared/decimal/decimal');
const { normalizeSymbol } = require('../market-data/market.utils');

function policyDecimal(policy, key) {
  const value = policy?.[key];
  if (value === null || value === undefined || value === '') return null;
  return normalizeDecimal(value?.toString ? value.toString() : String(value));
}

function enabledLimit(policy, key) {
  const value = policyDecimal(policy, key);
  return value != null && compareDecimal(value, '0') > 0 ? value : null;
}

function convertRiskCurrency(amount, fromCurrency, toCurrency, currencyConverter = null, nowMs = Date.now()) {
  const from = String(fromCurrency || '').toUpperCase();
  const to = String(toCurrency || '').toUpperCase();
  if (from && to && from === to) return normalizeDecimal(amount);
  const converter = currencyConverter || require('./currency-conversion-engine').getDefaultCurrencyConversionEngine();
  if (!converter?.convert) {
    throw new AppError('Live currency conversion path is unavailable for risk policy enforcement', {
      statusCode: 409,
      code: 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE',
      details: { fromCurrency: from || null, toCurrency: to || null },
    });
  }
  return converter.convert(amount, from, to, { nowMs });
}

function riskPercent(amount, account) {
  if (amount == null) return null;
  const equity = normalizeDecimal(account?.state?.equity ?? account?.state?.balance ?? '0');
  if (compareDecimal(equity, '0') <= 0) {
    throw new AppError('Account equity is unavailable for percentage risk enforcement', {
      statusCode: 409,
      code: 'RISK_POLICY_EQUITY_UNAVAILABLE',
    });
  }
  return divideDecimal(multiplyDecimal(amount, '100'), equity, { scale: 8, rounding: ROUNDING.HALF_UP });
}

function calculateStopRiskAmount({
  account,
  instrument,
  side,
  entryPrice,
  volume,
  stopLoss,
  currencyConverter = null,
  nowMs = Date.now(),
}) {
  if (stopLoss === null || stopLoss === undefined || stopLoss === '') return null;
  const normalizedSide = String(side || '').toUpperCase();
  const entry = normalizeDecimal(entryPrice);
  const stop = normalizeDecimal(stopLoss);
  const distance = normalizedSide === 'BUY'
    ? subtractDecimal(entry, stop)
    : subtractDecimal(stop, entry);
  if (compareDecimal(distance, '0') <= 0) return '0';

  const contractSize = normalizeDecimal(instrument?.contractSize ?? '0');
  const normalizedVolume = normalizeDecimal(volume);
  const riskInPnlCurrency = multiplyDecimal(multiplyDecimal(distance, contractSize), normalizedVolume);
  const pnlCurrency = String(instrument?.pnlCurrency || instrument?.quoteCurrency || '').toUpperCase();
  return convertRiskCurrency(riskInPnlCurrency, pnlCurrency, account?.currency, currencyConverter, nowMs);
}

function calculatePositionStopRiskAmount({
  account,
  position,
  currencyConverter = null,
  nowMs = Date.now(),
}) {
  if (position?.stopLoss === null || position?.stopLoss === undefined || position?.stopLoss === '') return null;
  return calculateStopRiskAmount({
    account,
    instrument: {
      contractSize: position.contractSize,
      pnlCurrency: position.quoteCurrency,
      quoteCurrency: position.quoteCurrency,
    },
    side: position.side,
    entryPrice: position.entryPrice,
    volume: position.openVolume,
    stopLoss: position.stopLoss,
    currencyConverter,
    nowMs,
  });
}

function validatePerOrderRiskPolicy({
  account,
  instrument,
  side,
  entryPrice,
  volume,
  stopLoss,
  currencyConverter = null,
  nowMs = Date.now(),
  checkPositionVolume = true,
}) {
  const policy = account?.riskPolicy || {};
  const maxPositionVolume = enabledLimit(policy, 'maxPositionVolume');
  const maxRiskPerTradePercent = enabledLimit(policy, 'maxRiskPerTradePercent');
  const maxAggregateRiskPercent = enabledLimit(policy, 'maxAggregateRiskPercent');

  if (checkPositionVolume && maxPositionVolume && compareDecimal(normalizeDecimal(volume), maxPositionVolume) > 0) {
    throw new AppError('Order volume exceeds the firm per-position limit', {
      statusCode: 409,
      code: 'MAX_POSITION_VOLUME_REACHED',
      details: { requestedVolume: normalizeDecimal(volume), maxPositionVolume },
    });
  }

  const requiresMeasuredStop = policy.requireStopLoss === true
    || maxRiskPerTradePercent != null
    || maxAggregateRiskPercent != null;
  if (requiresMeasuredStop && (stopLoss === null || stopLoss === undefined || stopLoss === '')) {
    throw new AppError('A stop loss is required by the trading account risk policy', {
      statusCode: 409,
      code: 'STOP_LOSS_REQUIRED_BY_POLICY',
    });
  }

  const needsRiskMeasurement = maxRiskPerTradePercent != null || maxAggregateRiskPercent != null;
  const tradeRiskAmount = needsRiskMeasurement
    ? calculateStopRiskAmount({
      account,
      instrument,
      side,
      entryPrice,
      volume,
      stopLoss,
      currencyConverter,
      nowMs,
    })
    : null;
  const tradeRiskPercent = tradeRiskAmount == null ? null : riskPercent(tradeRiskAmount, account);

  if (maxRiskPerTradePercent && compareDecimal(tradeRiskPercent, maxRiskPerTradePercent) > 0) {
    throw new AppError('Trade risk exceeds the firm per-trade risk limit', {
      statusCode: 409,
      code: 'MAX_RISK_PER_TRADE_REACHED',
      details: {
        tradeRiskAmount,
        tradeRiskPercent,
        maxRiskPerTradePercent,
        accountCurrency: account?.currency || null,
      },
    });
  }

  return Object.freeze({ tradeRiskAmount, tradeRiskPercent });
}

function validateActiveExposurePolicy({
  account,
  symbol,
  newVolume,
  tradeRiskAmount = null,
  exposure = null,
}) {
  if (!exposure) return;
  const policy = account?.riskPolicy || {};
  const normalizedVolume = normalizeDecimal(newVolume);
  const currentOpenPositions = Number(exposure.currentOpenPositions || 0);
  const currentTotalVolume = normalizeDecimal(exposure.currentTotalVolume ?? '0');
  const currentSymbolVolume = normalizeDecimal(exposure.currentSymbolVolume ?? '0');

  if (policy.maxOpenPositions != null) {
    const limit = Number(policy.maxOpenPositions);
    if (Number.isFinite(limit) && currentOpenPositions + 1 > limit) {
      throw new AppError('Maximum number of open positions has been reached', {
        statusCode: 409,
        code: 'MAX_OPEN_POSITIONS_REACHED',
        details: { currentOpenPositions, maxOpenPositions: limit },
      });
    }
  }

  const maxTotalVolume = enabledLimit(policy, 'maxTotalVolume');
  if (maxTotalVolume && compareDecimal(addDecimal(currentTotalVolume, normalizedVolume), maxTotalVolume) > 0) {
    throw new AppError('Maximum total open volume would be exceeded', {
      statusCode: 409,
      code: 'MAX_TOTAL_VOLUME_REACHED',
      details: { currentTotalVolume, requestedVolume: normalizedVolume, maxTotalVolume },
    });
  }

  const maxSymbolVolume = enabledLimit(policy, 'maxSymbolVolume');
  if (maxSymbolVolume && compareDecimal(addDecimal(currentSymbolVolume, normalizedVolume), maxSymbolVolume) > 0) {
    throw new AppError('Maximum open volume for this symbol would be exceeded', {
      statusCode: 409,
      code: 'MAX_SYMBOL_VOLUME_REACHED',
      details: {
        symbol: normalizeSymbol(symbol),
        currentSymbolVolume,
        requestedVolume: normalizedVolume,
        maxSymbolVolume,
      },
    });
  }

  validateAggregateRiskPolicy({
    account,
    tradeRiskAmount,
    exposure,
  });
}

function validateAggregateRiskPolicy({
  account,
  tradeRiskAmount = null,
  exposure = null,
}) {
  const policy = account?.riskPolicy || {};
  const maxAggregateRiskPercent = enabledLimit(policy, 'maxAggregateRiskPercent');
  if (!maxAggregateRiskPercent) return;
  if (!exposure) return;

  const unmeasured = Number(exposure.unmeasuredRiskPositions || 0);
  if (unmeasured > 0) {
    throw new AppError('Aggregate open risk cannot be measured because an existing position has no stop loss', {
      statusCode: 409,
      code: 'AGGREGATE_RISK_UNMEASURABLE',
      details: { unmeasuredRiskPositions: unmeasured },
    });
  }
  if (tradeRiskAmount == null) {
    throw new AppError('A stop loss is required to enforce aggregate open risk', {
      statusCode: 409,
      code: 'STOP_LOSS_REQUIRED_BY_POLICY',
    });
  }
  const projectedRiskAmount = addDecimal(exposure.currentOpenRisk ?? '0', tradeRiskAmount);
  const projectedRiskPercent = riskPercent(projectedRiskAmount, account);
  if (compareDecimal(projectedRiskPercent, maxAggregateRiskPercent) > 0) {
    throw new AppError('Projected aggregate open risk exceeds the firm limit', {
      statusCode: 409,
      code: 'MAX_AGGREGATE_RISK_REACHED',
      details: {
        currentOpenRisk: normalizeDecimal(exposure.currentOpenRisk ?? '0'),
        tradeRiskAmount,
        projectedRiskAmount,
        projectedRiskPercent,
        maxAggregateRiskPercent,
        accountCurrency: account?.currency || null,
      },
    });
  }
}

function hasActiveExposurePolicy(account) {
  const policy = account?.riskPolicy || {};
  return policy.maxOpenPositions != null
    || enabledLimit(policy, 'maxTotalVolume') != null
    || enabledLimit(policy, 'maxSymbolVolume') != null
    || enabledLimit(policy, 'maxAggregateRiskPercent') != null;
}

module.exports = {
  calculateStopRiskAmount,
  calculatePositionStopRiskAmount,
  validatePerOrderRiskPolicy,
  validateActiveExposurePolicy,
  validateAggregateRiskPolicy,
  hasActiveExposurePolicy,
};
