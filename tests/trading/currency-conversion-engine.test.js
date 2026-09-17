'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CurrencyConversionEngine } = require('../../src/modules/trading/currency-conversion-engine');

function store(quotes) {
  const map = new Map(Object.entries(quotes));
  return { get(symbol) { return map.get(symbol) || null; } };
}

const NOW = 1_000_000;

function quote(bid, ask, age = 100) {
  return { bid, ask, receivedAtMs: NOW - age, isStale: false };
}

test('currency conversion uses direct executable side for gains and losses', () => {
  const engine = new CurrencyConversionEngine({ quoteStore: store({ EURUSD: quote(1.1, 1.2) }), symbols: ['EURUSD'] });
  assert.equal(engine.convert('100', 'EUR', 'USD', { nowMs: NOW }), '110');
  assert.equal(engine.convert('-100', 'EUR', 'USD', { nowMs: NOW }), '-120');
});

test('currency conversion uses inverse ask for positive amounts and inverse bid for losses', () => {
  const engine = new CurrencyConversionEngine({ quoteStore: store({ EURUSD: quote(1.1, 1.2) }), symbols: ['EURUSD'] });
  assert.equal(engine.convert('120', 'USD', 'EUR', { nowMs: NOW }), '100');
  assert.equal(engine.convert('-110', 'USD', 'EUR', { nowMs: NOW }), '-100');
});

test('currency conversion can pivot through USD', () => {
  const engine = new CurrencyConversionEngine({
    quoteStore: store({ GBPUSD: quote(1.25, 1.26), EURUSD: quote(1.1, 1.2) }),
    symbols: ['GBPUSD', 'EURUSD'],
  });
  assert.equal(engine.convert('120', 'GBP', 'EUR', { nowMs: NOW }), '125');
});

test('currency conversion rejects stale or missing paths', () => {
  const engine = new CurrencyConversionEngine({ quoteStore: store({ EURUSD: quote(1.1, 1.2, 20_000) }), symbols: ['EURUSD'], maxQuoteAgeMs: 5000 });
  assert.throws(() => engine.convert('100', 'USD', 'EUR', { nowMs: NOW }), error => error.code === 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE');
});
