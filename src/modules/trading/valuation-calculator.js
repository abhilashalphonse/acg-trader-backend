'use strict';

const {
  normalizeDecimal,
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  compareDecimal,
} = require('../../shared/decimal/decimal');

function calculatePositionValuation({ position, quote }) {
  const normalized = normalizePosition(position);
  const closePriceNumber = normalized.side === 'BUY' ? quote?.bid : quote?.ask;
  const hasExecutablePrice = Number.isFinite(closePriceNumber);
  const status = !quote || !hasExecutablePrice
    ? 'WAITING'
    : quote.isStale ? 'STALE' : 'LIVE';

  if (!hasExecutablePrice) {
    return {
      ...normalized,
      closePrice: null,
      floatingPnl: null,
      quoteSequence: quote?.sequence ?? null,
      quoteReceivedAtMs: quote?.receivedAtMs ?? null,
      quoteSource: quote?.source ?? null,
      valuationStatus: status,
      isStale: status !== 'LIVE',
    };
  }

  const closePrice = normalizeDecimal(String(closePriceNumber));
  const priceDifference = normalized.side === 'BUY'
    ? subtractDecimal(closePrice, normalized.entryPrice)
    : subtractDecimal(normalized.entryPrice, closePrice);
  const floatingPnl = multiplyDecimal(
    multiplyDecimal(priceDifference, normalized.contractSize),
    normalized.openVolume,
  );

  return {
    ...normalized,
    closePrice,
    floatingPnl,
    quoteSequence: quote?.sequence ?? null,
    quoteReceivedAtMs: quote?.receivedAtMs ?? null,
    quoteSource: quote?.source ?? null,
    valuationStatus: status,
    isStale: status !== 'LIVE',
  };
}

function aggregateAccountValuation({ account, positionValuations = [] }) {
  const balance = decimalValue(account?.state?.balance, '0');
  let floatingPnl = '0';
  let usedMargin = '0';
  let hasUnpriced = false;
  let hasStale = false;
  const staleSymbols = new Set();

  const accountCurrency = String(account?.currency || '').toUpperCase();
  for (const valuation of positionValuations) {
    usedMargin = addDecimal(usedMargin, decimalValue(valuation.margin, '0'));
    const quoteCurrency = String(valuation.quoteCurrency || '').toUpperCase();
    if ((accountCurrency && quoteCurrency && accountCurrency !== quoteCurrency) || valuation.floatingPnl == null) {
      hasUnpriced = true;
      staleSymbols.add(valuation.symbol);
      continue;
    }
    floatingPnl = addDecimal(floatingPnl, valuation.floatingPnl);
    if (valuation.valuationStatus !== 'LIVE') {
      hasStale = true;
      staleSymbols.add(valuation.symbol);
    }
  }

  const valuationStatus = hasUnpriced ? 'WAITING' : hasStale ? 'STALE' : 'LIVE';
  const complete = !hasUnpriced;
  const equity = complete ? addDecimal(balance, floatingPnl) : null;
  const freeMargin = complete ? subtractDecimal(equity, usedMargin) : null;
  const marginLevel = complete && compareDecimal(usedMargin, '0') > 0
    ? multiplyDecimal(divideDecimal(equity, usedMargin, { scale: 8 }), '100')
    : null;

  return {
    accountId: accountIdOf(account),
    accountCode: account?.accountCode || null,
    currency: account?.currency || null,
    balance,
    floatingPnl: complete ? floatingPnl : null,
    equity,
    usedMargin,
    freeMargin,
    marginLevel,
    positionCount: positionValuations.length,
    valuationStatus,
    complete,
    staleSymbols: [...staleSymbols].sort(),
  };
}

function normalizePosition(position) {
  return {
    id: String(position?.id || position?._id || ''),
    positionId: String(position?.positionId || ''),
    accountId: String(position?.accountId || ''),
    symbol: String(position?.symbol || '').toUpperCase(),
    side: String(position?.side || '').toUpperCase(),
    status: String(position?.status || 'OPEN').toUpperCase(),
    openVolume: decimalValue(position?.openVolume),
    entryPrice: decimalValue(position?.entryPrice),
    contractSize: decimalValue(position?.contractSize),
    quoteCurrency: position?.quoteCurrency ? String(position.quoteCurrency).toUpperCase() : null,
    margin: decimalValue(position?.margin, '0'),
  };
}

function accountIdOf(account) {
  return String(account?.id || account?._id || account?.accountId || '');
}

function decimalValue(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  return normalizeDecimal(value?.toString ? value.toString() : String(value));
}

module.exports = {
  calculatePositionValuation,
  aggregateAccountValuation,
  normalizePosition,
};
