'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planMarketOpen, planMarketClose } = require('../../src/modules/trading/execution-planner');
const { CurrencyConversionEngine } = require('../../src/modules/trading/currency-conversion-engine');
const { sizeMarketOrder } = require('../../src/modules/trading/order-sizing');
const { compareDecimal } = require('../../src/shared/decimal/decimal');

const NOW = Date.parse('2026-10-07T04:30:00.000Z');

function fixture() {
  const account = {
    _id: '507f1f77bcf86cd799439011',
    status: 'ACTIVE',
    tradingEnabled: true,
    currency: 'USD',
    leverage: 100,
    riskPolicy: { allowedSymbols: [] },
    state: {
      initialBalance: '100000',
      balance: '100000',
      equity: '100000',
      usedMargin: '0',
      floatingPnl: '0',
      freeMargin: '100000',
      dailyStartEquity: '100000',
      realizedPnlToday: '0',
    },
  };
  const instrument = {
    symbol: 'RELIANCE',
    assetClass: 'EQUITY',
    status: 'ACTIVE',
    executionEnabled: true, // Controlled planner fixture; not a catalog change.
    quoteCurrency: 'INR',
    pnlCurrency: 'INR',
    marginCurrency: 'INR',
    tickSize: '0.01',
    pipSize: '0.01',
    contractSize: '1',
    minVolume: '0.001',
    maxVolume: '100',
    volumeStep: '0.001',
    defaultLeverage: 10,
    leveragePolicyVersion: 2,
    marginRate: null,
    commissionPerLotPerSide: '0',
    commissionRate: '0',
    tradingSessions: [],
    tradingHolidays: [],
    timezone: 'Asia/Kolkata',
    maxQuoteAgeMs: 5000,
  };
  const quote = {
    symbol: 'RELIANCE',
    bid: 1425.60,
    ask: 1425.60,
    sequence: 1,
    receivedAtMs: NOW - 100,
    sourceTimestampMs: NOW - 100,
    isStale: false,
  };
  const fx = {
    symbol: 'USDINR',
    bid: 90.0238,
    ask: 90.0238,
    sequence: 17,
    receivedAtMs: NOW - 100,
    sourceTimestampMs: NOW - 100,
    isStale: false,
    source: 'SYNTHETIC_TEST',
  };
  const converter = new CurrencyConversionEngine({
    quoteStore: { get: symbol => symbol === 'USDINR' ? fx : null },
    symbols: ['USDINR'],
    maxQuoteAgeMs: 5000,
  }).createContext({ nowMs: NOW });

  const evaluate = volume => planMarketOpen({
    account,
    instrument,
    quote,
    side: 'BUY',
    volume,
    stopLoss: '1063.60',
    currencyConverter: converter,
    nowMs: NOW,
  });
  return { account, instrument, quote, fx, evaluate };
}

test('RELIANCE $50 risk sizing rounds down to 12.434 shares at 90.0238', () => {
  const { instrument, evaluate } = fixture();
  const sized = sizeMarketOrder({
    mode: 'RISK',
    amount: '50',
    instrument,
    evaluate,
  });
  assert.equal(sized.volume, '12.434');
  assert.equal(sized.plan.effectiveLeverage, 10);
  assert.equal(sized.plan.quoteCurrency, 'INR');
  assert.equal(sized.plan.marginCurrency, 'USD');
  assert.equal(compareDecimal(sized.plan.riskAmount, '50') <= 0, true);
  assert.equal(compareDecimal(evaluate('12.435').riskAmount, '50') > 0, true);
  assert.equal(sized.plan.marginConversionEvidence.path[0].symbol, 'USDINR');
  assert.equal(sized.plan.marginConversionEvidence.path[0].quoteRate, '90.0238');
  assert.equal(compareDecimal(sized.plan.requiredMargin, '19.69') >= 0, true);
  assert.equal(compareDecimal(sized.plan.requiredMargin, '19.70') < 0, true);
});

test('same RELIANCE conversion evidence is retained for $196.90 exposure sizing', () => {
  const { instrument, evaluate } = fixture();
  const sized = sizeMarketOrder({
    mode: 'AMOUNT',
    amount: '196.90',
    instrument,
    evaluate,
  });
  assert.equal(compareDecimal(sized.actualAmount, '196.90') <= 0, true);
  assert.equal(compareDecimal(sized.plan.exposureAccountCurrency, '196.90') <= 0, true);
  assert.equal(sized.plan.exposureConversionEvidence.path[0].symbol, 'USDINR');
  assert.equal(sized.plan.exposureConversionEvidence.fromCurrency, 'INR');
  assert.equal(sized.plan.exposureConversionEvidence.toCurrency, 'USD');
});


test('FX outage fails closed before any INR realization or USD ledger mutation', () => {
  const { account, instrument, quote } = fixture();
  const initialAccountBalance = account.state.balance;
  const position = {
    _id: '507f191e810c19729de860ea',
    accountId: account._id, symbol: 'RELIANCE',
    side: 'BUY', status: 'OPEN', openVolume: '12.434',
    entryPrice: '1425.60', contractSize: '1',
    volumeStep: '0.001', quoteCurrency: 'INR',
    margin: '19.69',
  };
  const converter = new CurrencyConversionEngine({
    quoteStore: { get: () => null }, symbols: ['USDINR'],
    maxQuoteAgeMs: 5000,
  });
  assert.throws(() => planMarketClose({
    account, instrument, quote, position, nowMs: NOW,
    currencyConverter: converter,
  }), error => error?.code === 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE');
  assert.equal(account.state.balance, initialAccountBalance);
  assert.equal(position.openVolume, '12.434');
  assert.equal(position.status, 'OPEN');
});
