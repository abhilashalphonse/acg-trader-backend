'use strict';

const {
  normalizeDecimal,
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  compareDecimal,
} = require('../../shared/decimal/decimal');
const {
  INSTRUMENT_QUALITIES,
  FX_QUALITIES,
  resolveInstrumentValuationQuality,
  accountValuationQuality,
} = require('./valuation-quality');

function calculatePositionValuation({ position, quote, instrument = null, nowMs = Date.now() }) {
  const normalized = normalizePosition(position);
  const closePriceNumber = normalized.side === 'BUY' ? quote?.bid : quote?.ask;
  const hasExecutablePrice = Number.isFinite(closePriceNumber) && closePriceNumber > 0;
  const quality = resolveInstrumentValuationQuality({
    instrument,
    quote,
    nowMs,
    hasExecutablePrice,
  });
  const status = legacyValuationStatus(quality.instrumentValuationQuality);

  if (!hasExecutablePrice) {
    return {
      ...normalized,
      closePrice: null,
      floatingPnl: null,
      quoteSequence: quote?.sequence ?? null,
      quoteReceivedAtMs: quote?.receivedAtMs ?? null,
      quoteSource: quote?.source ?? null,
      valuationStatus: status,
      instrumentValuationQuality: quality.instrumentValuationQuality,
      executionAvailability: quality.executionAvailability,
      approvedCloseAtMs: quality.approvedCloseAtMs,
      isStale: ![
        INSTRUMENT_QUALITIES.LIVE,
        INSTRUMENT_QUALITIES.APPROVED_CLOSE,
      ].includes(quality.instrumentValuationQuality),
    };
  }

  const closePrice = normalizeDecimal(String(closePriceNumber));
  const priceDifference = normalized.side === 'BUY'
    ? subtractDecimal(closePrice, normalized.entryPrice)
    : subtractDecimal(normalized.entryPrice, closePrice);
  const floatingPnl = multiplyDecimal(multiplyDecimal(priceDifference, normalized.contractSize), normalized.openVolume);

  return {
    ...normalized,
    closePrice,
    floatingPnl,
    quoteSequence: quote?.sequence ?? null,
    quoteReceivedAtMs: quote?.receivedAtMs ?? null,
    quoteSource: quote?.source ?? null,
    valuationStatus: status,
    instrumentValuationQuality: quality.instrumentValuationQuality,
    executionAvailability: quality.executionAvailability,
    approvedCloseAtMs: quality.approvedCloseAtMs,
    isStale: ![
      INSTRUMENT_QUALITIES.LIVE,
      INSTRUMENT_QUALITIES.APPROVED_CLOSE,
    ].includes(quality.instrumentValuationQuality),
  };
}

function aggregateAccountValuation({ account, positionValuations = [], currencyConverter = null, nowMs = Date.now() }) {
  const balance = decimalValue(account?.state?.balance, '0');
  let floatingPnl = '0';
  let usedMargin = '0';
  let hasUnpriced = false;
  let instrumentQuality = INSTRUMENT_QUALITIES.LIVE;
  let fxQuality = FX_QUALITIES.NOT_REQUIRED;
  const staleSymbols = new Set();

  const accountCurrency = String(account?.currency || '').toUpperCase();
  for (const valuation of positionValuations) {
    usedMargin = addDecimal(usedMargin, decimalValue(valuation.margin, '0'));
    const pnlCurrency = String(valuation.quoteCurrency || '').toUpperCase();
    if (valuation.floatingPnl == null) {
      hasUnpriced = true;
      instrumentQuality = INSTRUMENT_QUALITIES.MISSING;
      staleSymbols.add(valuation.symbol);
      continue;
    }

    const currentQuality = String(
      valuation.instrumentValuationQuality || valuation.valuationStatus || '',
    ).toUpperCase();
    if (['WAITING', INSTRUMENT_QUALITIES.MISSING].includes(currentQuality)) {
      hasUnpriced = true;
      instrumentQuality = INSTRUMENT_QUALITIES.MISSING;
      staleSymbols.add(valuation.symbol);
    } else if (currentQuality === INSTRUMENT_QUALITIES.STALE) {
      instrumentQuality = INSTRUMENT_QUALITIES.STALE;
      staleSymbols.add(valuation.symbol);
    } else if (
      currentQuality === INSTRUMENT_QUALITIES.APPROVED_CLOSE
      && instrumentQuality === INSTRUMENT_QUALITIES.LIVE
    ) {
      instrumentQuality = INSTRUMENT_QUALITIES.APPROVED_CLOSE;
    }

    try {
      const converted = convertPnlWithEvidence(
        valuation.floatingPnl,
        pnlCurrency,
        accountCurrency,
        currencyConverter,
        nowMs,
      );
      floatingPnl = addDecimal(floatingPnl, converted.amount);
      fxQuality = combineFxQuality(fxQuality, converted.fxValuationQuality);
    } catch {
      hasUnpriced = true;
      fxQuality = FX_QUALITIES.MISSING;
      staleSymbols.add(valuation.symbol);
      continue;
    }
  }

  const complete = !hasUnpriced;
  const accountQuality = accountValuationQuality({
    positionValuations,
    fxValuationQuality: fxQuality,
    complete,
  });
  const valuationStatus = legacyAccountStatus(accountQuality, fxQuality, complete);
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
    instrumentValuationQuality: instrumentQuality,
    fxValuationQuality: fxQuality,
    accountValuationQuality: accountQuality,
    accountValuationCompleteness: complete ? 'COMPLETE' : 'INCOMPLETE',
    complete,
    staleSymbols: [...staleSymbols].sort(),
  };
}

function convertPnl(amount, fromCurrency, toCurrency, currencyConverter, nowMs) {
  return convertPnlWithEvidence(amount, fromCurrency, toCurrency, currencyConverter, nowMs).amount;
}

function convertPnlWithEvidence(amount, fromCurrency, toCurrency, currencyConverter, nowMs) {
  if (fromCurrency && toCurrency && fromCurrency === toCurrency) {
    return {
      amount: normalizeDecimal(amount),
      fxValuationQuality: FX_QUALITIES.NOT_REQUIRED,
      evidence: null,
    };
  }
  if (!currencyConverter?.convert) throw new Error('conversion unavailable');

  if (typeof currencyConverter.convertWithEvidence === 'function') {
    const conversion = currencyConverter.convertWithEvidence(amount, fromCurrency, toCurrency, { nowMs });
    return {
      amount: conversion.amount,
      fxValuationQuality: fxQualityFromEvidence(conversion.evidence),
      evidence: conversion.evidence,
    };
  }

  return {
    amount: currencyConverter.convert(amount, fromCurrency, toCurrency, { nowMs }),
    fxValuationQuality: FX_QUALITIES.LIVE,
    evidence: null,
  };
}

function fxQualityFromEvidence(evidence) {
  const path = Array.isArray(evidence?.path) ? evidence.path : [];
  if (!path.length) return FX_QUALITIES.NOT_REQUIRED;
  return path.some(leg => String(leg?.fxValuationQuality || '').toUpperCase() === FX_QUALITIES.APPROVED_FALLBACK)
    ? FX_QUALITIES.APPROVED_FALLBACK
    : FX_QUALITIES.LIVE;
}

function combineFxQuality(current, next) {
  if (current === FX_QUALITIES.MISSING || next === FX_QUALITIES.MISSING) return FX_QUALITIES.MISSING;
  if (current === FX_QUALITIES.APPROVED_FALLBACK || next === FX_QUALITIES.APPROVED_FALLBACK) return FX_QUALITIES.APPROVED_FALLBACK;
  if (current === FX_QUALITIES.LIVE || next === FX_QUALITIES.LIVE) return FX_QUALITIES.LIVE;
  return FX_QUALITIES.NOT_REQUIRED;
}

function legacyValuationStatus(quality) {
  if (quality === INSTRUMENT_QUALITIES.LIVE) return 'LIVE';
  if (quality === INSTRUMENT_QUALITIES.APPROVED_CLOSE) return 'APPROVED_CLOSE';
  if (quality === INSTRUMENT_QUALITIES.STALE) return 'STALE';
  return 'WAITING';
}

function legacyAccountStatus(accountQuality, fxQuality, complete) {
  if (!complete || accountQuality === 'MISSING' || fxQuality === FX_QUALITIES.MISSING) return 'WAITING';
  if (accountQuality === INSTRUMENT_QUALITIES.STALE || fxQuality === FX_QUALITIES.STALE) return 'STALE';
  if (
    accountQuality === INSTRUMENT_QUALITIES.APPROVED_CLOSE
    || fxQuality === FX_QUALITIES.APPROVED_FALLBACK
  ) return 'APPROVED_CLOSE';
  return 'LIVE';
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

function accountIdOf(account) { return String(account?.id || account?._id || account?.accountId || ''); }
function decimalValue(value, fallback = null) { if (value === null || value === undefined) return fallback; return normalizeDecimal(value?.toString ? value.toString() : String(value)); }

module.exports = {
  calculatePositionValuation,
  aggregateAccountValuation,
  normalizePosition,
  convertPnl,
  convertPnlWithEvidence,
};
