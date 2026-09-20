'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculatePositionValuation,
  aggregateAccountValuation,
} = require('../../src/modules/trading/valuation-calculator');

function position(overrides = {}) {
  return {
    id: 'p1',
    positionId: 'pos-1',
    accountId: 'a1',
    symbol: 'EURUSD',
    side: 'BUY',
    status: 'OPEN',
    openVolume: '1',
    entryPrice: '1.1000',
    contractSize: '100000',
    quoteCurrency: 'USD',
    margin: '1100',
    ...overrides,
  };
}

function quote(overrides = {}) {
  return {
    symbol: 'EURUSD',
    bid: 1.101,
    ask: 1.1012,
    sequence: 7,
    receivedAtMs: 1000,
    source: 'test',
    isStale: false,
    ...overrides,
  };
}

test('values long positions at BID and short positions at ASK', () => {
  const long = calculatePositionValuation({ position: position(), quote: quote() });
  assert.equal(long.closePrice, '1.101');
  assert.equal(long.floatingPnl, '100');
  assert.equal(long.valuationStatus, 'LIVE');

  const short = calculatePositionValuation({
    position: position({ side: 'SELL', entryPrice: '1.1020' }),
    quote: quote(),
  });
  assert.equal(short.closePrice, '1.1012');
  assert.equal(short.floatingPnl, '80');
});

test('account valuation aggregates floating PnL, equity, free margin and margin level exactly', () => {
  const first = calculatePositionValuation({ position: position(), quote: quote() });
  const second = calculatePositionValuation({
    position: position({ id: 'p2', positionId: 'pos-2', side: 'SELL', entryPrice: '1.1020', margin: '550', openVolume: '0.5' }),
    quote: quote(),
  });
  const result = aggregateAccountValuation({
    account: { _id: 'a1', accountCode: 'A1', currency: 'USD', state: { balance: '10000' } },
    positionValuations: [first, second],
  });

  assert.equal(result.floatingPnl, '140');
  assert.equal(result.equity, '10140');
  assert.equal(result.usedMargin, '1650');
  assert.equal(result.freeMargin, '8490');
  assert.equal(result.marginLevel, '614.545455');
  assert.equal(result.valuationStatus, 'LIVE');
});

test('stale executable quotes preserve numeric valuation but mark the account stale', () => {
  const stale = calculatePositionValuation({ position: position(), quote: quote({ isStale: true }) });
  const result = aggregateAccountValuation({
    account: { _id: 'a1', currency: 'USD', state: { balance: '10000' } },
    positionValuations: [stale],
  });
  assert.equal(stale.floatingPnl, '100');
  assert.equal(result.valuationStatus, 'STALE');
  assert.equal(result.equity, '10100');
  assert.deepEqual(result.staleSymbols, ['EURUSD']);
});

test('missing executable prices make account equity incomplete instead of fabricating PnL', () => {
  const waiting = calculatePositionValuation({ position: position(), quote: null });
  const result = aggregateAccountValuation({
    account: { _id: 'a1', currency: 'USD', state: { balance: '10000' } },
    positionValuations: [waiting],
  });
  assert.equal(waiting.floatingPnl, null);
  assert.equal(result.valuationStatus, 'WAITING');
  assert.equal(result.floatingPnl, null);
  assert.equal(result.equity, null);
  assert.equal(result.freeMargin, null);
});

test('cross-currency positions are not silently aggregated without a conversion service', () => {
  const valued = calculatePositionValuation({ position: position({ quoteCurrency: 'EUR' }), quote: quote() });
  const result = aggregateAccountValuation({
    account: { _id: 'a1', currency: 'USD', state: { balance: '10000' } },
    positionValuations: [valued],
  });
  assert.equal(result.valuationStatus, 'WAITING');
  assert.equal(result.equity, null);
});


test('non-positive executable prices are treated as unavailable rather than valid PnL inputs', () => {
  const zero = calculatePositionValuation({ position: position(), quote: quote({ bid: 0 }) });
  assert.equal(zero.valuationStatus, 'WAITING');
  assert.equal(zero.closePrice, null);
  assert.equal(zero.floatingPnl, null);

  const negative = calculatePositionValuation({
    position: position({ side: 'SELL' }),
    quote: quote({ ask: -1 }),
  });
  assert.equal(negative.valuationStatus, 'WAITING');
  assert.equal(negative.closePrice, null);
  assert.equal(negative.floatingPnl, null);
});
