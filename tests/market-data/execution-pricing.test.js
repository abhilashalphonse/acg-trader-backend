'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ExecutionPricingService, executionPriceForVolume } = require('../../src/modules/market-data/execution-pricing');

function instrument(overrides = {}) {
  return {
    symbol: 'EURUSD',
    tickSize: 0.00001,
    spread: {
      mode: 'DYNAMIC',
      normalPoints: 2,
      minimumPoints: 2,
      maximumPoints: 100,
      markupPoints: 0,
      rolloverMultiplier: 1,
      rolloverStartUtcMinute: null,
      rolloverEndUtcMinute: null,
      volumeBands: [
        { upTo: 1, extraPoints: 0 },
        { upTo: 5, extraPoints: 1 },
        { upTo: 15, extraPoints: 2 },
        { upTo: null, extraPoints: 4 },
      ],
    },
    ...overrides,
  };
}

test('dynamic pricing owns executable spread while using provider book as a market floor', () => {
  const service = new ExecutionPricingService();
  const quote = service.priceQuote({
    raw: { price: 1.1, bid: 1.099995, ask: 1.100005 },
    instrument: instrument(),
    nowMs: Date.parse('2026-09-21T12:00:00Z'),
  });

  assert.equal(quote.pricingModel, 'ACG_DYNAMIC');
  assert.equal(quote.isSyntheticSpread, true);
  assert.ok(Math.abs(quote.referencePrice - 1.1) < 1e-12);
  assert.ok(quote.spreadPoints >= 2);
  assert.ok(quote.bid < quote.ask);
});

test('REST price recovery uses the same dynamic pricing model instead of a separate fixed fallback', () => {
  const service = new ExecutionPricingService();
  const quote = service.priceQuote({
    raw: { price: 1.102, bid: null, ask: null },
    instrument: instrument(),
    nowMs: Date.parse('2026-09-21T12:00:00Z'),
  });

  assert.equal(quote.pricingModel, 'ACG_DYNAMIC');
  assert.equal(quote.spreadSource, 'ACG_SPREAD_PROFILE');
  assert.ok(Math.abs(quote.bid - 1.10199) < 1e-12);
  assert.ok(Math.abs(quote.ask - 1.10201) < 1e-12);
  assert.ok(Math.abs(quote.spreadPoints - 2) < 1e-9);
});

test('volume bands apply deterministic adverse liquidity adjustment without randomness', () => {
  const small = executionPriceForVolume({
    quote: { bid: 1.09999, ask: 1.10001, spreadPoints: 2, pricingModel: 'ACG_DYNAMIC' },
    instrument: instrument(),
    side: 'BUY',
    volume: 1,
  });
  const larger = executionPriceForVolume({
    quote: { bid: 1.09999, ask: 1.10001, spreadPoints: 2, pricingModel: 'ACG_DYNAMIC' },
    instrument: instrument(),
    side: 'BUY',
    volume: 10,
  });

  assert.equal(small.liquidityAdjustmentPoints, 0);
  assert.equal(larger.liquidityAdjustmentPoints, 2);
  assert.ok(larger.price > small.price);
  assert.equal(larger.executionAsk, larger.price);
  assert.equal(larger.executionBid, 1.09999);
  assert.equal(larger.volumeBand, 'UP_TO_15');
});
