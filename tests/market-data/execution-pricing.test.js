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

test('dynamic pricing uses ACG spread profile while preserving provider spread only as diagnostics', () => {
  const service = new ExecutionPricingService();
  const quote = service.priceQuote({
    // Deliberately wide provider book: 21 pips on EURUSD.
    raw: { price: 1.1, bid: 1.09895, ask: 1.10105 },
    instrument: instrument(),
    nowMs: Date.parse('2026-09-21T12:00:00Z'),
  });

  assert.equal(quote.pricingModel, 'ACG_DYNAMIC');
  assert.equal(quote.spreadSource, 'ACG_SPREAD_PROFILE');
  assert.equal(quote.isSyntheticSpread, true);
  assert.ok(Math.abs(quote.referencePrice - 1.1) < 1e-12);
  assert.ok(Math.abs(quote.spreadPoints - 2) < 1e-9);
  assert.ok(Math.abs(quote.providerSpreadPoints - 210) < 1e-9);
  assert.ok(Math.abs(quote.bid - 1.09999) < 1e-12);
  assert.ok(Math.abs(quote.ask - 1.10001) < 1e-12);
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


test('synthetic pricing cannot inflate an exact two-point target through two-sided tick rounding', () => {
  const service = new ExecutionPricingService();
  const quote = service.priceQuote({
    raw: { price: 1.100006, bid: null, ask: null },
    instrument: instrument(),
    nowMs: Date.parse('2026-09-21T12:00:00Z'),
  });

  assert.equal(quote.targetSpreadPoints, 2);
  assert.equal(quote.spreadPoints, 2);
  assert.ok(Math.abs((quote.ask - quote.bid) - 0.00002) < 1e-12);
});

test('fractional dynamic targets resolve once to the next executable tick instead of double-rounding', () => {
  const service = new ExecutionPricingService();
  const fractional = instrument({
    spread: {
      ...instrument().spread,
      normalPoints: 2.4,
      minimumPoints: 2.4,
    },
  });
  const quote = service.priceQuote({
    raw: { price: 1.100006, bid: null, ask: null },
    instrument: fractional,
    nowMs: Date.parse('2026-09-21T12:00:00Z'),
  });

  assert.equal(quote.targetSpreadPoints, 2.4);
  assert.equal(quote.spreadPoints, 3);
  assert.ok(Math.abs((quote.ask - quote.bid) - 0.00003) < 1e-12);
});

test('order pricing reports quoted and effective spread separately after size adjustment', () => {
  const result = executionPriceForVolume({
    quote: {
      bid: 1.09999,
      ask: 1.10001,
      spreadPoints: 2,
      providerSpreadPoints: 210,
      pricingModel: 'ACG_DYNAMIC',
    },
    instrument: instrument(),
    side: 'BUY',
    volume: 10,
  });

  assert.equal(result.spreadPoints, 2);
  assert.equal(result.quotedSpreadPoints, 2);
  assert.equal(result.liquidityAdjustmentPoints, 2);
  assert.equal(result.effectiveExecutionSpreadPoints, 4);
  assert.ok(Math.abs(result.executionAsk - 1.10003) < 1e-12);
});

test('sell-side size adjustment reports the same effective spread accounting', () => {
  const result = executionPriceForVolume({
    quote: {
      bid: 1.09999,
      ask: 1.10001,
      spreadPoints: 2,
      pricingModel: 'ACG_DYNAMIC',
    },
    instrument: instrument(),
    side: 'SELL',
    volume: 10,
  });

  assert.equal(result.quotedSpreadPoints, 2);
  assert.equal(result.liquidityAdjustmentPoints, 2);
  assert.equal(result.effectiveExecutionSpreadPoints, 4);
  assert.ok(Math.abs(result.executionBid - 1.09997) < 1e-12);
});
