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
  isStepAligned,
  quantizeToStep,
  assertPositiveDecimal,
} = require('../../shared/decimal/decimal');
const { normalizeSymbol } = require('../market-data/market.utils');
const { assertInstrumentSessionOpen } = require('../instruments/session-calendar');
const { executionPriceForVolume } = require('../market-data/execution-pricing');
const { dayKeyInTimezone } = require('./risk-day-engine');
const { calculateCommission: calculateTradingCommission, convertTradingCurrency } = require('./trading-costs');
const { calculatePositionValuation } = require('./valuation-calculator');
const {
  validatePreTradeRiskPolicy,
  validateActiveExposurePolicy,
} = require('./firm-risk-policy');

function planMarketOpen({ account, instrument, quote, side, volume, stopLoss = null, takeProfit = null, nowMs = Date.now(), currencyConverter = null, exposure = null }) {
  validateAccountForOpen(account, instrument?.symbol, nowMs);
  validateInstrumentForOpen(instrument);
  assertInstrumentSessionOpen(instrument, nowMs);
  validateQuote(quote, instrument, nowMs);

  const normalizedSide = normalizeSide(side);
  const normalizedVolume = validateVolume(volume, instrument);
  const execution = executionPriceForVolume({ quote, instrument, side: normalizedSide, volume: normalizedVolume });
  const fillPrice = executablePrice({ ...quote, [normalizedSide === 'BUY' ? 'ask' : 'bid']: execution.price }, normalizedSide, instrument);
  const normalizedStopLoss = optionalPrice(stopLoss, instrument);
  const normalizedTakeProfit = optionalPrice(takeProfit, instrument);
  validateProtection({ side: normalizedSide, fillPrice, stopLoss: normalizedStopLoss, takeProfit: normalizedTakeProfit });
  const commission = calculateCommission(instrument, normalizedVolume, {
    account,
    fillPrice,
    currencyConverter,
    nowMs,
  });
  const estimatedCloseCommission = normalizedStopLoss == null
    ? '0'
    : calculateCommission(instrument, normalizedVolume, {
      account,
      fillPrice: normalizedStopLoss,
      currencyConverter,
      nowMs,
    });
  const requiredMargin = calculateRequiredMargin({ account, instrument, volume: normalizedVolume, fillPrice, currencyConverter, nowMs });
  const firmRisk = validatePreTradeRiskPolicy({
    account,
    instrument,
    symbol: instrument.symbol,
    side: normalizedSide,
    entryPrice: fillPrice,
    volume: normalizedVolume,
    stopLoss: normalizedStopLoss,
    requiredMargin,
    openingCommission: commission,
    closingCommission: estimatedCloseCommission,
    exposure,
    orderKind: 'OPEN_EXECUTION',
    currencyConverter,
    nowMs,
  });
  const immediateOpeningPnl = calculateImmediateOpeningPnl({
    account,
    instrument,
    quote,
    side: normalizedSide,
    volume: normalizedVolume,
    fillPrice,
    currencyConverter,
    nowMs,
  });
  const projectedAccountState = projectAccountAfterOpen({
    account,
    requiredMargin,
    commission,
    immediateOpeningPnl,
  });

  if (compareDecimal(projectedAccountState.freeMargin, '0') < 0) {
    throw new AppError('Insufficient projected free margin for this order', {
      statusCode: 409,
      code: 'INSUFFICIENT_MARGIN',
      details: {
        freeMargin: normalizeDecimal(account.state?.freeMargin ?? '0'),
        requiredMargin,
        commission,
        immediateOpeningPnl,
        projectedBalance: projectedAccountState.balance,
        projectedFloatingPnl: projectedAccountState.floatingPnl,
        projectedEquity: projectedAccountState.equity,
        projectedUsedMargin: projectedAccountState.usedMargin,
        projectedFreeMargin: projectedAccountState.freeMargin,
        projectedMarginLevel: projectedAccountState.marginLevel,
        accountCurrency: account.currency,
      },
    });
  }

  return Object.freeze({
    symbol: normalizeSymbol(instrument.symbol),
    side: normalizedSide,
    volume: normalizedVolume,
    fillPrice,
    stopLoss: normalizedStopLoss,
    takeProfit: normalizedTakeProfit,
    riskAmount: firmRisk.tradeRiskAmount,
    riskPercent: firmRisk.tradeRiskPercent,
    rawStopRiskAmount: firmRisk.rawStopRiskAmount ?? null,
    openingCommission: firmRisk.openingCommission ?? commission,
    estimatedCloseCommission: firmRisk.closingCommission ?? estimatedCloseCommission,
    commission,
    requiredMargin,
    immediateOpeningPnl,
    projectedAccountState: Object.freeze(projectedAccountState),
    projectedEquityAfterCommission: firmRisk.projectedEquityAfterCommission ?? null,
    marginCurrency: String(account.currency || '').toUpperCase(),
    contractSize: normalizeDecimal(instrument.contractSize),
    volumeStep: normalizeDecimal(instrument.volumeStep),
    quoteCurrency: String(instrument.quoteCurrency || '').toUpperCase(),
    pnlCurrency: String(instrument.pnlCurrency || instrument.quoteCurrency || '').toUpperCase(),
    quoteSequence: quote.sequence ?? null,
    quoteReceivedAtMs: quote.receivedAtMs,
    referencePrice: decimalOrNull(execution.referencePrice),
    executionBid: decimalOrNull(execution.executionBid),
    executionAsk: decimalOrNull(execution.executionAsk),
    spreadPoints: decimalOrNull(execution.spreadPoints),
    providerSpreadPoints: decimalOrNull(execution.providerSpreadPoints),
    liquidityAdjustmentPoints: normalizeDecimal(String(execution.liquidityAdjustmentPoints || 0)),
    volumeBand: execution.volumeBand,
    pricingModel: execution.pricingModel,
  });
}

function planMarketClose({ account, instrument, quote, position, volume = null, nowMs = Date.now(), currencyConverter = null }) {
  validateAccountForClose(account);
  validateInstrumentForClose(instrument);
  validateQuote(quote, instrument, nowMs);
  validateOpenPosition(position, account);

  const openVolume = assertPositiveDecimal(position.openVolume, 'position.openVolume');
  const volumeStep = normalizeDecimal(position.volumeStep || instrument.volumeStep);
  const requestedVolume = volume == null ? openVolume : assertPositiveDecimal(volume, 'volume');
  if (compareDecimal(requestedVolume, openVolume) > 0) throw new AppError('Close volume exceeds the open position volume', { statusCode: 400, code: 'INVALID_CLOSE_VOLUME', details: { requestedVolume, openVolume } });
  if (!isStepAligned(requestedVolume, volumeStep)) throw new AppError('Close volume is not aligned to the instrument volume step', { statusCode: 400, code: 'INVALID_CLOSE_VOLUME_STEP', details: { volume: requestedVolume, volumeStep } });

  const remainingVolume = subtractDecimal(openVolume, requestedVolume);
  const minVolume = normalizeDecimal(instrument.minVolume);
  if (compareDecimal(remainingVolume, '0') > 0 && compareDecimal(remainingVolume, minVolume) < 0) throw new AppError('Partial close would leave a position below the minimum volume', { statusCode: 400, code: 'INVALID_REMAINING_VOLUME', details: { remainingVolume, minVolume } });

  const closeSide = position.side === 'BUY' ? 'SELL' : 'BUY';
  const execution = executionPriceForVolume({ quote, instrument, side: closeSide, volume: requestedVolume });
  const fillPrice = executablePrice({ ...quote, [closeSide === 'BUY' ? 'ask' : 'bid']: execution.price }, closeSide, instrument);
  const pnlCurrency = String(position.quoteCurrency || instrument.pnlCurrency || instrument.quoteCurrency || '').toUpperCase();
  const contractSize = normalizeDecimal(position.contractSize || instrument.contractSize);
  const entryPrice = normalizeDecimal(position.entryPrice);
  const priceDifference = position.side === 'BUY' ? subtractDecimal(fillPrice, entryPrice) : subtractDecimal(entryPrice, fillPrice);
  const realizedPnlQuote = multiplyDecimal(multiplyDecimal(priceDifference, contractSize), requestedVolume);
  const realizedPnl = convertCurrency(realizedPnlQuote, pnlCurrency, account.currency, currencyConverter, nowMs);
  const commission = calculateCommission(instrument, requestedVolume, {
    account,
    fillPrice,
    currencyConverter,
    nowMs,
  });
  const netBalanceChange = subtractDecimal(realizedPnl, commission);

  const currentMargin = normalizeDecimal(position.margin ?? '0');
  const fullClose = compareDecimal(requestedVolume, openVolume) === 0;
  let releasedMargin = fullClose ? currentMargin : divideDecimal(multiplyDecimal(currentMargin, requestedVolume), openVolume, { scale: 12, rounding: ROUNDING.HALF_UP });
  if (compareDecimal(releasedMargin, currentMargin) > 0) releasedMargin = currentMargin;

  return Object.freeze({
    symbol: normalizeSymbol(position.symbol), closeSide, volume: requestedVolume, remainingVolume, fullClose,
    fillPrice, entryPrice, contractSize, volumeStep, quoteCurrency: pnlCurrency, pnlCurrency,
    realizedPnlQuote, realizedPnl, commission, netBalanceChange, releasedMargin,
    quoteSequence: quote.sequence ?? null, quoteReceivedAtMs: quote.receivedAtMs,
    dealType: fullClose ? 'CLOSE' : 'PARTIAL_CLOSE',
    referencePrice: decimalOrNull(execution.referencePrice),
    executionBid: decimalOrNull(execution.executionBid),
    executionAsk: decimalOrNull(execution.executionAsk),
    spreadPoints: decimalOrNull(execution.spreadPoints),
    providerSpreadPoints: decimalOrNull(execution.providerSpreadPoints),
    liquidityAdjustmentPoints: normalizeDecimal(String(execution.liquidityAdjustmentPoints || 0)),
    volumeBand: execution.volumeBand,
    pricingModel: execution.pricingModel,
  });
}

function validateAccountForOpen(account, symbol, nowMs = Date.now()) {
  if (!account) throw new AppError('Trading account was not found', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });
  if (account.status !== 'ACTIVE') throw new AppError('Trading account is not active', { statusCode: 409, code: 'ACCOUNT_NOT_ACTIVE', details: { status: account.status } });
  if (account.tradingEnabled !== true) throw new AppError('Trading is disabled for this account', { statusCode: 409, code: 'ACCOUNT_TRADING_DISABLED' });
  if (String(account.riskProcessingState || 'RESOLVED').toUpperCase() === 'RISK_UNRESOLVED') {
    throw new AppError('New exposure is paused while account risk history is unresolved', {
      statusCode: 409,
      code: 'RISK_STATE_UNRESOLVED',
      details: { reason: account.riskUnresolvedReason || null },
    });
  }
  validateChallengeRiskForOpen(account, nowMs);
  const allowed = account.riskPolicy?.allowedSymbols || [];
  const canonical = normalizeSymbol(symbol);
  if (allowed.length && !allowed.map(normalizeSymbol).includes(canonical)) throw new AppError('Symbol is not allowed for this trading account', { statusCode: 403, code: 'SYMBOL_NOT_ALLOWED', details: { symbol: canonical } });
}
function validateExposureLimits(account, newVolume, exposure = null, options = {}) {
  validateActiveExposurePolicy({
    account,
    symbol: options.symbol,
    newVolume,
    tradeRiskAmount: options.tradeRiskAmount ?? null,
    exposure,
  });
}
function validateChallengeRiskForOpen(account, nowMs = Date.now()) {
  const state = account.state || {};
  const policy = account.riskPolicy || {};
  const equity = normalizeDecimal(state.equity ?? state.balance ?? '0');
  const balance = normalizeDecimal(state.balance ?? '0');
  const initial = normalizeDecimal(state.initialBalance ?? '0');

  const currentRiskDay = dayKeyInTimezone(new Date(nowMs), account.riskTimezone || 'UTC');
  // Only roll forward an explicitly known prior day. A missing riskDayKey must
  // never reset the baseline at order time because that could mask an existing
  // loss; the LIVE valuation RiskDayEngine will initialize it safely.
  if (account.riskDayKey && account.riskDayKey !== currentRiskDay) {
    account.riskDayKey = currentRiskDay;
    state.dailyStartEquity = equity;
    state.realizedPnlToday = '0';
  }

  const dailyStart = normalizeDecimal(state.dailyStartEquity ?? initial);

  const dailyLimit = normalizeDecimal(policy.dailyLoss?.limit ?? '0');
  if (compareDecimal(dailyLimit, '0') > 0) {
    const dailyFloor = subtractDecimal(dailyStart, dailyLimit);
    if (compareDecimal(equity, dailyFloor) <= 0) {
      throw new AppError('Daily loss limit has been reached', {
        statusCode: 409,
        code: 'DAILY_LOSS_LIMIT_REACHED',
        details: { equity, dailyStartEquity: dailyStart, dailyLossLimit: dailyLimit },
      });
    }
  }

  const maxLimit = normalizeDecimal(policy.maxLoss?.limit ?? '0');
  if (compareDecimal(maxLimit, '0') > 0) {
    const maxFloor = subtractDecimal(initial, maxLimit);
    if (compareDecimal(equity, maxFloor) <= 0) {
      throw new AppError('Maximum loss limit has been reached', {
        statusCode: 409,
        code: 'MAX_LOSS_LIMIT_REACHED',
        details: { equity, initialBalance: initial, maxLossLimit: maxLimit },
      });
    }
  }

  // Profit-target progression remains authoritative in ACG Funded because
  // minimum-trading-day state is owned there. Trader only enforces loss limits
  // locally; Funded disables the account once target + min-days are satisfied.
}

function validateAccountForClose(account) { if (!account) throw new AppError('Trading account was not found', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' }); }
function validateInstrumentForOpen(instrument) {
  if (!instrument) throw new AppError('Instrument was not found', { statusCode: 404, code: 'INSTRUMENT_NOT_FOUND' });
  if (instrument.status !== 'ACTIVE') throw new AppError('Instrument is not available for execution', { statusCode: 409, code: 'INSTRUMENT_NOT_ACTIVE', details: { status: instrument.status } });
  if (instrument.executionEnabled !== true) throw new AppError('Execution is disabled for this instrument', { statusCode: 409, code: 'INSTRUMENT_EXECUTION_DISABLED' });
}
function validateInstrumentForClose(instrument) { if (!instrument) throw new AppError('Instrument was not found', { statusCode: 404, code: 'INSTRUMENT_NOT_FOUND' }); }

function validateQuote(quote, instrument, nowMs) {
  if (!quote) throw new AppError('No live quote is available for this symbol', { statusCode: 503, code: 'QUOTE_UNAVAILABLE' });
  const receivedAtMs = Number(quote.receivedAtMs);
  const maxAgeMs = Number(instrument.maxQuoteAgeMs || 5000);
  const ageMs = Number.isFinite(receivedAtMs) ? Math.max(0, nowMs - receivedAtMs) : Number.POSITIVE_INFINITY;
  if (quote.isStale || ageMs > maxAgeMs) throw new AppError('Market quote is stale', { statusCode: 503, code: 'QUOTE_STALE', details: { ageMs: Number.isFinite(ageMs) ? ageMs : null, maxAgeMs } });
  const bid = Number(quote.bid);
  const ask = Number(quote.ask);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
    throw new AppError('Executable bid/ask is unavailable', {
      statusCode: 503,
      code: 'EXECUTABLE_QUOTE_UNAVAILABLE',
      details: { bid: Number.isFinite(bid) ? bid : null, ask: Number.isFinite(ask) ? ask : null },
    });
  }
}

function validateVolume(volume, instrument) {
  let normalized;
  try { normalized = assertPositiveDecimal(volume, 'volume'); } catch (error) { throw new AppError(error.message, { statusCode: 400, code: 'INVALID_VOLUME' }); }
  const minVolume = normalizeDecimal(instrument.minVolume);
  const maxVolume = normalizeDecimal(instrument.maxVolume);
  const volumeStep = normalizeDecimal(instrument.volumeStep);
  if (compareDecimal(normalized, minVolume) < 0 || compareDecimal(normalized, maxVolume) > 0) throw new AppError('Volume is outside the instrument limits', { statusCode: 400, code: 'INVALID_VOLUME_RANGE', details: { volume: normalized, minVolume, maxVolume } });
  if (!isStepAligned(normalized, volumeStep)) throw new AppError('Volume is not aligned to the instrument volume step', { statusCode: 400, code: 'INVALID_VOLUME_STEP', details: { volume: normalized, volumeStep } });
  return normalized;
}

function executablePrice(quote, side, instrument) {
  const raw = side === 'BUY' ? quote.ask : quote.bid;
  const numeric = Number(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new AppError('Executable market price is unavailable', { statusCode: 503, code: 'EXECUTABLE_QUOTE_UNAVAILABLE' });
  return quantizeToStep(String(numeric), instrument.tickSize, ROUNDING.HALF_UP);
}
function optionalPrice(value, instrument) {
  if (value === null || value === undefined || value === '') return null;
  let normalized;
  try { normalized = assertPositiveDecimal(value, 'price'); } catch (error) { throw new AppError(error.message, { statusCode: 400, code: 'INVALID_PRICE' }); }
  if (!isStepAligned(normalized, instrument.tickSize)) throw new AppError('Price is not aligned to the instrument tick size', { statusCode: 400, code: 'INVALID_PRICE_STEP', details: { price: normalized, tickSize: normalizeDecimal(instrument.tickSize) } });
  return normalized;
}
function validateProtection({ side, fillPrice, stopLoss, takeProfit }) {
  if (side === 'BUY') {
    if (stopLoss != null && compareDecimal(stopLoss, fillPrice) >= 0) throw invalidProtection('BUY stop loss must be below the fill price');
    if (takeProfit != null && compareDecimal(takeProfit, fillPrice) <= 0) throw invalidProtection('BUY take profit must be above the fill price');
  } else {
    if (stopLoss != null && compareDecimal(stopLoss, fillPrice) <= 0) throw invalidProtection('SELL stop loss must be above the fill price');
    if (takeProfit != null && compareDecimal(takeProfit, fillPrice) >= 0) throw invalidProtection('SELL take profit must be below the fill price');
  }
}
function invalidProtection(message) { return new AppError(message, { statusCode: 400, code: 'INVALID_PROTECTION_PRICE' }); }
function calculateCommission(instrument, volume, options = {}) {
  return calculateTradingCommission(instrument, volume, options);
}

function decimalOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value?.toString ? value.toString() : value);
  return Number.isFinite(number) ? normalizeDecimal(String(number)) : null;
}

function calculateRequiredMargin({ account, instrument, volume, fillPrice, currencyConverter = null, nowMs = Date.now() }) {
  const notional = multiplyDecimal(multiplyDecimal(fillPrice, instrument.contractSize), volume);
  const marginCurrency = String(instrument.marginCurrency || instrument.quoteCurrency || '').toUpperCase();
  let rawMargin;
  if (instrument.marginRate != null && compareDecimal(instrument.marginRate, '0') > 0) rawMargin = multiplyDecimal(notional, instrument.marginRate);
  else {
    const accountLeverage = Number(account.leverage);
    const instrumentLeverage = Number(instrument.defaultLeverage);
    const effectiveLeverage = Math.min(accountLeverage, instrumentLeverage);
    if (!Number.isFinite(effectiveLeverage) || effectiveLeverage <= 0) throw new AppError('No valid leverage is configured for margin calculation', { statusCode: 409, code: 'INVALID_LEVERAGE' });
    rawMargin = divideDecimal(notional, String(effectiveLeverage), { scale: 12, rounding: ROUNDING.HALF_UP });
  }
  return convertCurrency(rawMargin, marginCurrency, account.currency, currencyConverter, nowMs);
}

function convertCurrency(amount, fromCurrency, toCurrency, currencyConverter = null, nowMs = Date.now()) {
  return convertTradingCurrency(amount, fromCurrency, toCurrency, currencyConverter, nowMs);
}

function calculateImmediateOpeningPnl({
  account,
  instrument,
  quote,
  side,
  volume,
  fillPrice,
  currencyConverter = null,
  nowMs = Date.now(),
}) {
  const valuation = calculatePositionValuation({
    position: {
      id: 'projected-open',
      accountId: account?._id || account?.id || '',
      symbol: instrument?.symbol,
      side,
      status: 'OPEN',
      openVolume: volume,
      entryPrice: fillPrice,
      contractSize: instrument?.contractSize,
      quoteCurrency: instrument?.quoteCurrency,
      margin: '0',
    },
    quote,
  });

  if (valuation.valuationStatus !== 'LIVE' || valuation.floatingPnl == null) {
    throw new AppError('Immediate opening valuation is unavailable', {
      statusCode: 409,
      code: 'OPENING_VALUATION_UNAVAILABLE',
    });
  }

  return convertTradingCurrency(
    valuation.floatingPnl,
    instrument?.quoteCurrency,
    account?.currency,
    currencyConverter,
    nowMs,
  );
}

function projectAccountAfterOpen({ account, requiredMargin, commission, immediateOpeningPnl }) {
  const balance = normalizeDecimal(account.state?.balance ?? '0');
  const floatingPnl = normalizeDecimal(account.state?.floatingPnl ?? '0');
  const usedMargin = normalizeDecimal(account.state?.usedMargin ?? '0');

  const projectedBalance = subtractDecimal(balance, commission);
  const projectedFloatingPnl = addDecimal(floatingPnl, immediateOpeningPnl);
  const projectedEquity = addDecimal(projectedBalance, projectedFloatingPnl);
  const projectedUsedMargin = addDecimal(usedMargin, requiredMargin);
  const projectedFreeMargin = subtractDecimal(projectedEquity, projectedUsedMargin);
  const projectedMarginLevel = compareDecimal(projectedUsedMargin, '0') > 0
    ? multiplyDecimal(divideDecimal(projectedEquity, projectedUsedMargin, { scale: 8, rounding: ROUNDING.HALF_UP }), '100')
    : null;

  return {
    balance: projectedBalance,
    floatingPnl: projectedFloatingPnl,
    equity: projectedEquity,
    usedMargin: projectedUsedMargin,
    freeMargin: projectedFreeMargin,
    marginLevel: projectedMarginLevel,
  };
}

function validateOpenPosition(position, account) {
  if (!position) throw new AppError('Position was not found', { statusCode: 404, code: 'POSITION_NOT_FOUND' });
  if (String(position.accountId) !== String(account._id)) throw new AppError('Position does not belong to this trading account', { statusCode: 403, code: 'POSITION_ACCOUNT_MISMATCH' });
  if (position.status !== 'OPEN' || compareDecimal(position.openVolume, '0') <= 0) throw new AppError('Position is not open', { statusCode: 409, code: 'POSITION_NOT_OPEN' });
}
function normalizeSide(side) { const value = String(side || '').toUpperCase(); if (!['BUY', 'SELL'].includes(value)) throw new AppError('Order side must be BUY or SELL', { statusCode: 400, code: 'INVALID_ORDER_SIDE' }); return value; }
function calculateAdverseSlippage({ side, fillPrice, requestedPrice }) { if (requestedPrice == null || requestedPrice === '') return '0'; const requested = normalizeDecimal(requestedPrice); return side === 'BUY' ? subtractDecimal(fillPrice, requested) : subtractDecimal(requested, fillPrice); }

module.exports = { planMarketOpen, planMarketClose, calculateRequiredMargin, calculateCommission, calculateAdverseSlippage, convertCurrency, calculateImmediateOpeningPnl, projectAccountAfterOpen, validateVolume, validateExposureLimits, validateAccountForOpen, validateChallengeRiskForOpen, validateAccountForClose, validateInstrumentForOpen, validateInstrumentForClose };
