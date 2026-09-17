'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planMarketOpen, planMarketClose } = require('../../src/modules/trading/execution-planner');
const { CurrencyConversionEngine } = require('../../src/modules/trading/currency-conversion-engine');

const NOW = new Date('2026-09-17T12:00:00.000Z').getTime();

function quote(symbol, bid, ask) { return { symbol, bid, ask, receivedAtMs: NOW - 100, isStale: false, sequence: 1 }; }
function converter() {
  const quotes = new Map([
    ['EURUSD', quote('EURUSD', 1.1, 1.2)],
    ['XAUUSD', quote('XAUUSD', 2000, 2000.5)],
  ]);
  return new CurrencyConversionEngine({ quoteStore: { get: symbol => quotes.get(symbol) || null }, symbols: [...quotes.keys()], maxQuoteAgeMs: 5000 });
}
function account() {
  return {
    _id: '507f1f77bcf86cd799439011', status: 'ACTIVE', tradingEnabled: true,
    currency: 'EUR', leverage: 100, riskPolicy: { allowedSymbols: [] },
    state: { balance: '100000', equity: '100000', freeMargin: '100000', usedMargin: '0' },
  };
}
function gold() {
  return {
    symbol: 'XAUUSD', status: 'ACTIVE', executionEnabled: true,
    quoteCurrency: 'USD', pnlCurrency: 'USD', marginCurrency: 'USD',
    tickSize: '0.01', minVolume: '0.01', maxVolume: '100', volumeStep: '0.01', contractSize: '100',
    defaultLeverage: 100, marginRate: null, commissionPerLot: '0', maxQuoteAgeMs: 5000,
    timezone: 'UTC', tradingSessions: [{ days: [4], open: '00:00', close: '23:59' }], tradingHolidays: [],
  };
}

test('gold margin is converted from USD into EUR account currency', () => {
  const plan = planMarketOpen({ account: account(), instrument: gold(), quote: quote('XAUUSD', 2000, 2000.5), side: 'BUY', volume: '1', nowMs: NOW, currencyConverter: converter() });
  // USD margin = 2000.5; USD->EUR uses inverse EURUSD ask 1.2.
  assert.equal(plan.requiredMargin, '1667.083333333333');
  assert.equal(plan.marginCurrency, 'EUR');
});

test('realized USD profit is converted to EUR using executable inverse rate', () => {
  const position = {
    _id: '507f191e810c19729de860ea', accountId: '507f1f77bcf86cd799439011', symbol: 'XAUUSD', side: 'BUY', status: 'OPEN',
    openVolume: '1', entryPrice: '2000', contractSize: '100', volumeStep: '0.01', quoteCurrency: 'USD', margin: '1666.666666666667',
  };
  const plan = planMarketClose({ account: account(), instrument: gold(), quote: quote('XAUUSD', 2001.2, 2001.5), position, nowMs: NOW, currencyConverter: converter() });
  assert.equal(plan.realizedPnlQuote, '120');
  assert.equal(plan.realizedPnl, '100');
});

test('market execution rejects orders outside the instrument session', () => {
  assert.throws(
    () => planMarketOpen({ account: account(), instrument: gold(), quote: quote('XAUUSD', 2000, 2000.5), side: 'BUY', volume: '1', nowMs: new Date('2026-09-19T12:00:00.000Z').getTime(), currencyConverter: converter() }),
    error => error.code === 'MARKET_SESSION_CLOSED',
  );
});
