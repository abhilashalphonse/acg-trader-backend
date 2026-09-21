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

const ACG_STANDARD_RISK_POLICY = Object.freeze({
  maxRiskPerTradePercent: '1',
  maxAggregateRiskPercent: '2',
  maxMarginUsagePercent: '50',
  maxOpenPositions: 10,
  maxPositionsPerSymbol: 3,
  maxPendingOrders: 10,
  maxPendingOrdersPerSymbol: 3,
  maxSingleOrderMarginPercentOfFree: '20',
  maxSymbolMarginPercentOfPermitted: '30',
});

const PRE_TRADE_REJECTION_CODES = Object.freeze({
  MAX_TRADE_RISK: 'MAX_TRADE_RISK',
  MAX_AGGREGATE_RISK: 'MAX_AGGREGATE_RISK',
  MAX_MARGIN_USAGE: 'MAX_MARGIN_USAGE',
  MAX_OPEN_POSITIONS: 'MAX_OPEN_POSITIONS',
  MAX_SYMBOL_POSITIONS: 'MAX_SYMBOL_POSITIONS',
  MAX_PENDING_ORDERS: 'MAX_PENDING_ORDERS',
  MAX_SYMBOL_PENDING: 'MAX_SYMBOL_PENDING',
  MAX_SINGLE_ORDER_EXPOSURE: 'MAX_SINGLE_ORDER_EXPOSURE',
  MAX_SYMBOL_EXPOSURE: 'MAX_SYMBOL_EXPOSURE',
});

function rawPolicyValue(policy, key) {
  const value = policy?.[key];
  if (value === null || value === undefined || value === '') return null;
  return value?.toString ? value.toString() : value;
}

function effectivePolicyValue(account, key) {
  const explicit = rawPolicyValue(account?.riskPolicy, key);
  return explicit == null ? ACG_STANDARD_RISK_POLICY[key] : explicit;
}

function policyDecimal(account, key) {
  const value = effectivePolicyValue(account, key);
  if (value === null || value === undefined || value === '') return null;
  return normalizeDecimal(String(value));
}

function enabledLimit(account, key) {
  const value = policyDecimal(account, key);
  return value != null && compareDecimal(value, '0') > 0 ? value : null;
}

function policyInteger(account, key) {
  const value = effectivePolicyValue(account, key);
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
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

function accountEquity(account) {
  const equity = normalizeDecimal(account?.state?.equity ?? account?.state?.balance ?? '0');
  if (compareDecimal(equity, '0') <= 0) {
    throw new AppError('Account equity is unavailable for percentage risk enforcement', {
      statusCode: 409,
      code: 'RISK_POLICY_EQUITY_UNAVAILABLE',
    });
  }
  return equity;
}

function riskPercent(amount, account) {
  if (amount == null) return null;
  return divideDecimal(multiplyDecimal(amount, '100'), accountEquity(account), { scale: 8, rounding: ROUNDING.HALF_UP });
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

function throwLimit(message, code, details) {
  throw new AppError(message, { statusCode: 409, code, details });
}

function validateMeasuredRisk({
  account,
  instrument,
  side,
  entryPrice,
  volume,
  stopLoss,
  exposure,
  currencyConverter,
  nowMs,
}) {
  const maxRiskPerTradePercent = enabledLimit(account, 'maxRiskPerTradePercent');
  const maxAggregateRiskPercent = enabledLimit(account, 'maxAggregateRiskPercent');
  const needsRiskMeasurement = maxRiskPerTradePercent != null || maxAggregateRiskPercent != null;
  if (!needsRiskMeasurement || stopLoss === null || stopLoss === undefined || stopLoss === '') {
    return Object.freeze({ tradeRiskAmount: null, tradeRiskPercent: null, projectedAggregateRiskPercent: null });
  }

  const tradeRiskAmount = calculateStopRiskAmount({
    account,
    instrument,
    side,
    entryPrice,
    volume,
    stopLoss,
    currencyConverter,
    nowMs,
  });
  const tradeRiskPercent = riskPercent(tradeRiskAmount, account);

  if (maxRiskPerTradePercent && compareDecimal(tradeRiskPercent, maxRiskPerTradePercent) > 0) {
    throwLimit(`Order risk exceeds the ${maxRiskPerTradePercent}% ACG per-trade limit`, PRE_TRADE_REJECTION_CODES.MAX_TRADE_RISK, {
      tradeRiskAmount,
      tradeRiskPercent,
      maxRiskPerTradePercent,
      accountCurrency: account?.currency || null,
    });
  }

  let projectedAggregateRiskPercent = null;
  if (maxAggregateRiskPercent && exposure) {
    const projectedRiskAmount = addDecimal(exposure.currentOpenRisk ?? '0', tradeRiskAmount ?? '0');
    projectedAggregateRiskPercent = riskPercent(projectedRiskAmount, account);
    if (compareDecimal(projectedAggregateRiskPercent, maxAggregateRiskPercent) > 0) {
      throwLimit(`Projected aggregate measured risk exceeds the ${maxAggregateRiskPercent}% ACG limit`, PRE_TRADE_REJECTION_CODES.MAX_AGGREGATE_RISK, {
        currentOpenRisk: normalizeDecimal(exposure.currentOpenRisk ?? '0'),
        tradeRiskAmount,
        projectedRiskAmount,
        projectedRiskPercent: projectedAggregateRiskPercent,
        maxAggregateRiskPercent,
        unmeasuredRiskPositions: Number(exposure.unmeasuredRiskPositions || 0),
        accountCurrency: account?.currency || null,
      });
    }
  }

  return Object.freeze({ tradeRiskAmount, tradeRiskPercent, projectedAggregateRiskPercent });
}

function validateLegacyVolumeLimits({ account, newVolume, exposure, checkPositionVolume }) {
  const normalizedVolume = normalizeDecimal(newVolume);
  const maxPositionVolume = enabledLimit(account, 'maxPositionVolume');
  if (checkPositionVolume && maxPositionVolume && compareDecimal(normalizedVolume, maxPositionVolume) > 0) {
    throwLimit('Order volume exceeds the firm per-position limit', 'MAX_POSITION_VOLUME_REACHED', {
      requestedVolume: normalizedVolume,
      maxPositionVolume,
    });
  }
  if (!exposure) return;

  const maxTotalVolume = enabledLimit(account, 'maxTotalVolume');
  if (maxTotalVolume && compareDecimal(addDecimal(exposure.currentTotalVolume ?? '0', normalizedVolume), maxTotalVolume) > 0) {
    throwLimit('Maximum total open volume would be exceeded', 'MAX_TOTAL_VOLUME_REACHED', {
      currentTotalVolume: normalizeDecimal(exposure.currentTotalVolume ?? '0'),
      requestedVolume: normalizedVolume,
      maxTotalVolume,
    });
  }

  const maxSymbolVolume = enabledLimit(account, 'maxSymbolVolume');
  if (maxSymbolVolume && compareDecimal(addDecimal(exposure.currentSymbolVolume ?? '0', normalizedVolume), maxSymbolVolume) > 0) {
    throwLimit('Maximum open volume for this symbol would be exceeded', 'MAX_SYMBOL_VOLUME_REACHED', {
      currentSymbolVolume: normalizeDecimal(exposure.currentSymbolVolume ?? '0'),
      requestedVolume: normalizedVolume,
      maxSymbolVolume,
    });
  }
}

function validateCountLimits({ account, symbol, exposure, pendingExposure, orderKind }) {
  if (orderKind === 'OPEN_EXECUTION' && exposure) {
    const maxOpenPositions = policyInteger(account, 'maxOpenPositions');
    const currentOpenPositions = Number(exposure.currentOpenPositions || 0);
    if (maxOpenPositions && currentOpenPositions + 1 > maxOpenPositions) {
      throwLimit(`Maximum ${maxOpenPositions} open positions are allowed on this ACG account`, PRE_TRADE_REJECTION_CODES.MAX_OPEN_POSITIONS, {
        currentOpenPositions,
        maxOpenPositions,
      });
    }

    const maxPositionsPerSymbol = policyInteger(account, 'maxPositionsPerSymbol');
    const currentSymbolPositions = Number(exposure.currentSymbolPositions || 0);
    if (maxPositionsPerSymbol && currentSymbolPositions + 1 > maxPositionsPerSymbol) {
      throwLimit(`Maximum ${maxPositionsPerSymbol} open positions are allowed on this instrument`, PRE_TRADE_REJECTION_CODES.MAX_SYMBOL_POSITIONS, {
        symbol: normalizeSymbol(symbol),
        currentSymbolPositions,
        maxPositionsPerSymbol,
      });
    }
  }

  if (orderKind === 'PENDING_PLACEMENT' && pendingExposure) {
    const maxPendingOrders = policyInteger(account, 'maxPendingOrders');
    const currentPendingOrders = Number(pendingExposure.currentPendingOrders || 0);
    if (maxPendingOrders && currentPendingOrders + 1 > maxPendingOrders) {
      throwLimit(`Maximum ${maxPendingOrders} pending orders are allowed on this ACG account`, PRE_TRADE_REJECTION_CODES.MAX_PENDING_ORDERS, {
        currentPendingOrders,
        maxPendingOrders,
      });
    }

    const maxPendingOrdersPerSymbol = policyInteger(account, 'maxPendingOrdersPerSymbol');
    const currentSymbolPendingOrders = Number(pendingExposure.currentSymbolPendingOrders || 0);
    if (maxPendingOrdersPerSymbol && currentSymbolPendingOrders + 1 > maxPendingOrdersPerSymbol) {
      throwLimit(`Maximum ${maxPendingOrdersPerSymbol} pending orders are allowed on this instrument`, PRE_TRADE_REJECTION_CODES.MAX_SYMBOL_PENDING, {
        symbol: normalizeSymbol(symbol),
        currentSymbolPendingOrders,
        maxPendingOrdersPerSymbol,
      });
    }
  }
}

function validateMarginExposure({
  account,
  symbol,
  requiredMargin,
  exposure,
}) {
  if (requiredMargin === null || requiredMargin === undefined || requiredMargin === '') return Object.freeze({
    projectedMarginUsagePercent: null,
    singleOrderMarginPercentOfFree: null,
    projectedSymbolMarginPercentOfPermitted: null,
  });

  const margin = normalizeDecimal(requiredMargin);
  const equity = accountEquity(account);
  const usedMargin = normalizeDecimal(account?.state?.usedMargin ?? '0');
  const freeMargin = normalizeDecimal(account?.state?.freeMargin ?? subtractDecimal(equity, usedMargin));
  const projectedUsedMargin = addDecimal(usedMargin, margin);

  const maxMarginUsagePercent = enabledLimit(account, 'maxMarginUsagePercent');
  const projectedMarginUsagePercent = divideDecimal(multiplyDecimal(projectedUsedMargin, '100'), equity, { scale: 8, rounding: ROUNDING.HALF_UP });
  if (maxMarginUsagePercent && compareDecimal(projectedMarginUsagePercent, maxMarginUsagePercent) > 0) {
    throwLimit(`This order would increase margin usage above the ${maxMarginUsagePercent}% ACG limit`, PRE_TRADE_REJECTION_CODES.MAX_MARGIN_USAGE, {
      usedMargin,
      requiredMargin: margin,
      projectedUsedMargin,
      projectedMarginUsagePercent,
      maxMarginUsagePercent,
      accountCurrency: account?.currency || null,
    });
  }

  const maxSingleOrderMarginPercentOfFree = enabledLimit(account, 'maxSingleOrderMarginPercentOfFree');
  let singleOrderMarginPercentOfFree = null;
  if (maxSingleOrderMarginPercentOfFree) {
    if (compareDecimal(freeMargin, '0') <= 0) {
      throwLimit('No available margin capacity remains for new exposure', PRE_TRADE_REJECTION_CODES.MAX_SINGLE_ORDER_EXPOSURE, {
        freeMargin,
        requiredMargin: margin,
        maxSingleOrderMarginPercentOfFree,
      });
    }
    singleOrderMarginPercentOfFree = divideDecimal(multiplyDecimal(margin, '100'), freeMargin, { scale: 8, rounding: ROUNDING.HALF_UP });
    if (compareDecimal(singleOrderMarginPercentOfFree, maxSingleOrderMarginPercentOfFree) > 0) {
      throwLimit(`This order exceeds ${maxSingleOrderMarginPercentOfFree}% of available margin capacity`, PRE_TRADE_REJECTION_CODES.MAX_SINGLE_ORDER_EXPOSURE, {
        freeMargin,
        requiredMargin: margin,
        singleOrderMarginPercentOfFree,
        maxSingleOrderMarginPercentOfFree,
        accountCurrency: account?.currency || null,
      });
    }
  }

  const maxSymbolMarginPercentOfPermitted = enabledLimit(account, 'maxSymbolMarginPercentOfPermitted');
  let projectedSymbolMarginPercentOfPermitted = null;
  if (maxMarginUsagePercent && maxSymbolMarginPercentOfPermitted && exposure) {
    const permittedAccountExposure = divideDecimal(multiplyDecimal(equity, maxMarginUsagePercent), '100', { scale: 8, rounding: ROUNDING.HALF_UP });
    const currentSymbolMargin = normalizeDecimal(exposure.currentSymbolMargin ?? '0');
    const projectedSymbolMargin = addDecimal(currentSymbolMargin, margin);
    if (compareDecimal(permittedAccountExposure, '0') > 0) {
      projectedSymbolMarginPercentOfPermitted = divideDecimal(multiplyDecimal(projectedSymbolMargin, '100'), permittedAccountExposure, { scale: 8, rounding: ROUNDING.HALF_UP });
      if (compareDecimal(projectedSymbolMarginPercentOfPermitted, maxSymbolMarginPercentOfPermitted) > 0) {
        throwLimit(`This order would exceed the ${maxSymbolMarginPercentOfPermitted}% per-symbol gross exposure limit`, PRE_TRADE_REJECTION_CODES.MAX_SYMBOL_EXPOSURE, {
          symbol: normalizeSymbol(symbol),
          currentSymbolMargin,
          requiredMargin: margin,
          projectedSymbolMargin,
          permittedAccountExposure,
          projectedSymbolMarginPercentOfPermitted,
          maxSymbolMarginPercentOfPermitted,
          accountCurrency: account?.currency || null,
        });
      }
    }
  }

  return Object.freeze({
    projectedMarginUsagePercent,
    singleOrderMarginPercentOfFree,
    projectedSymbolMarginPercentOfPermitted,
  });
}

function validatePreTradeRiskPolicy({
  account,
  instrument,
  symbol = instrument?.symbol,
  side,
  entryPrice,
  volume,
  stopLoss = null,
  requiredMargin = null,
  exposure = null,
  pendingExposure = null,
  orderKind = 'OPEN_EXECUTION',
  currencyConverter = null,
  nowMs = Date.now(),
  checkPositionVolume = true,
}) {
  validateLegacyVolumeLimits({ account, newVolume: volume, exposure, checkPositionVolume });
  validateCountLimits({ account, symbol, exposure, pendingExposure, orderKind });

  const measuredRisk = validateMeasuredRisk({
    account,
    instrument,
    side,
    entryPrice,
    volume,
    stopLoss,
    exposure,
    currencyConverter,
    nowMs,
  });
  const marginExposure = validateMarginExposure({
    account,
    symbol,
    requiredMargin,
    exposure,
  });

  return Object.freeze({ ...measuredRisk, ...marginExposure });
}

function validatePerOrderRiskPolicy(args) {
  return validatePreTradeRiskPolicy({
    ...args,
    exposure: null,
    pendingExposure: null,
    requiredMargin: null,
    orderKind: 'PER_ORDER_ONLY',
  });
}

function validateActiveExposurePolicy({
  account,
  symbol,
  newVolume,
  tradeRiskAmount = null,
  exposure = null,
}) {
  validateLegacyVolumeLimits({ account, newVolume, exposure, checkPositionVolume: false });
  validateCountLimits({ account, symbol, exposure, pendingExposure: null, orderKind: 'OPEN_EXECUTION' });
  if (tradeRiskAmount != null) validateAggregateRiskPolicy({ account, tradeRiskAmount, exposure });
}

function validateAggregateRiskPolicy({
  account,
  tradeRiskAmount = null,
  exposure = null,
}) {
  const maxAggregateRiskPercent = enabledLimit(account, 'maxAggregateRiskPercent');
  if (!maxAggregateRiskPercent || !exposure || tradeRiskAmount == null) return;
  const projectedRiskAmount = addDecimal(exposure.currentOpenRisk ?? '0', tradeRiskAmount);
  const projectedRiskPercent = riskPercent(projectedRiskAmount, account);
  if (compareDecimal(projectedRiskPercent, maxAggregateRiskPercent) > 0) {
    throwLimit(`Projected aggregate measured risk exceeds the ${maxAggregateRiskPercent}% ACG limit`, PRE_TRADE_REJECTION_CODES.MAX_AGGREGATE_RISK, {
      currentOpenRisk: normalizeDecimal(exposure.currentOpenRisk ?? '0'),
      tradeRiskAmount,
      projectedRiskAmount,
      projectedRiskPercent,
      maxAggregateRiskPercent,
      unmeasuredRiskPositions: Number(exposure.unmeasuredRiskPositions || 0),
      accountCurrency: account?.currency || null,
    });
  }
}

function hasActiveExposurePolicy() {
  return true;
}

module.exports = {
  ACG_STANDARD_RISK_POLICY,
  PRE_TRADE_REJECTION_CODES,
  calculateStopRiskAmount,
  calculatePositionStopRiskAmount,
  validatePreTradeRiskPolicy,
  validatePerOrderRiskPolicy,
  validateActiveExposurePolicy,
  validateAggregateRiskPolicy,
  hasActiveExposurePolicy,
};
