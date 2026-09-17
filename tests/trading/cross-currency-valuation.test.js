'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePositionValuation, aggregateAccountValuation } = require('../../src/modules/trading/valuation-calculator');
const { CurrencyConversionEngine } = require('../../src/modules/trading/currency-conversion-engine');

const NOW = 1_000_000;
function q(symbol, bid, ask) { return { symbol, bid, ask, receivedAtMs: NOW - 100, isStale: false }; }

const quotes = new Map([
  ['EURUSD', q('EURUSD', 1.1, 1.2)],
  ['XAUUSD', q('XAUUSD', 2001.2, 2001.5)],
]);
const converter = new CurrencyConversionEngine({ quoteStore: { get: symbol => quotes.get(symbol) || null }, symbols: [...quotes.keys()], maxQuoteAgeMs: 5000 });

function position() {
  return {
    _id: '507f191e810c19729de860ea', positionId: 'P1', accountId: '507f1f77bcf86cd799439011', symbol: 'XAUUSD', side: 'BUY', status: 'OPEN',
    openVolume: '1', entryPrice: '2000', contractSize: '100', quoteCurrency: 'USD', margin: '1666.666666666667',
  };
}

test('floating PnL is converted into account currency before equity is calculated', () => {
  const pv = calculatePositionValuation({ position: position(), quote: quotes.get('XAUUSD') });
  assert.equal(pv.floatingPnl, '120');
  const account = { _id: '507f1f77bcf86cd799439011', currency: 'EUR', state: { balance: '10000' } };
  const value = aggregateAccountValuation({ account, positionValuations: [pv], currencyConverter: converter, nowMs: NOW });
  assert.equal(value.floatingPnl, '100');
  assert.equal(value.equity, '10100');
  assert.equal(value.usedMargin, '1666.666666666667');
  assert.equal(value.valuationStatus, 'LIVE');
});

test('missing conversion path makes valuation WAITING rather than fabricating equity', () => {
  const pv = calculatePositionValuation({ position: position(), quote: quotes.get('XAUUSD') });
  const account = { _id: '507f1f77bcf86cd799439011', currency: 'JPY', state: { balance: '10000' } };
  const value = aggregateAccountValuation({ account, positionValuations: [pv], currencyConverter: converter, nowMs: NOW });
  assert.equal(value.valuationStatus, 'WAITING');
  assert.equal(value.equity, null);
  assert.equal(value.floatingPnl, null);
});
