'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planMarketOpen, planMarketClose, calculateAdverseSlippage } = require('../../src/modules/trading/execution-planner');

function account(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    status: 'ACTIVE',
    tradingEnabled: true,
    currency: 'USD',
    leverage: 100,
    riskPolicy: { allowedSymbols: [] },
    state: {
      balance: '100000',
      equity: '100000',
      freeMargin: '100000',
      usedMargin: '0',
      realizedPnlToday: '0',
    },
    ...overrides,
  };
}

function instrument(overrides = {}) {
  return {
    symbol: 'EURUSD',
    status: 'ACTIVE',
    executionEnabled: true,
    quoteCurrency: 'USD',
    tickSize: '0.00001',
    minVolume: '0.01',
    maxVolume: '100',
    volumeStep: '0.01',
    contractSize: '100000',
    defaultLeverage: 100,
    marginRate: null,
    commissionPerLot: '0',
    maxQuoteAgeMs: 5000,
    ...overrides,
  };
}

function quote(overrides = {}) {
  return {
    symbol: 'EURUSD',
    bid: 1.09995,
    ask: 1.10005,
    sequence: 42,
    receivedAtMs: 10_000,
    isStale: false,
    ...overrides,
  };
}

test('market BUY fills at ask and reserves exact margin', () => {
  const plan = planMarketOpen({
    account: account(),
    instrument: instrument(),
    quote: quote(),
    side: 'BUY',
    volume: '1',
    nowMs: 10_100,
  });

  assert.equal(plan.fillPrice, '1.10005');
  assert.equal(plan.requiredMargin, '1100.05');
  assert.equal(plan.commission, '0');
  assert.equal(plan.quoteSequence, 42);
});

test('market SELL fills at bid and applies per-lot commission', () => {
  const plan = planMarketOpen({
    account: account(),
    instrument: instrument({ commissionPerLot: '3.5' }),
    quote: quote(),
    side: 'SELL',
    volume: '0.5',
    nowMs: 10_100,
  });

  assert.equal(plan.fillPrice, '1.09995');
  assert.equal(plan.commission, '1.75');
  assert.equal(plan.requiredMargin, '549.975');
});

test('market execution rejects stale quotes and disabled instruments', () => {
  assert.throws(
    () => planMarketOpen({ account: account(), instrument: instrument(), quote: quote({ isStale: true }), side: 'BUY', volume: '1', nowMs: 10_100 }),
    error => error.code === 'QUOTE_STALE',
  );
  assert.throws(
    () => planMarketOpen({ account: account(), instrument: instrument({ executionEnabled: false }), quote: quote(), side: 'BUY', volume: '1', nowMs: 10_100 }),
    error => error.code === 'INSTRUMENT_EXECUTION_DISABLED',
  );
});

test('market execution enforces volume steps and free margin', () => {
  assert.throws(
    () => planMarketOpen({ account: account(), instrument: instrument(), quote: quote(), side: 'BUY', volume: '0.015', nowMs: 10_100 }),
    error => error.code === 'INVALID_VOLUME_STEP',
  );
  assert.throws(
    () => planMarketOpen({ account: account({ state: { ...account().state, freeMargin: '100' } }), instrument: instrument(), quote: quote(), side: 'BUY', volume: '1', nowMs: 10_100 }),
    error => error.code === 'INSUFFICIENT_MARGIN',
  );
});

test('protection prices must be on the correct side of the fill', () => {
  assert.throws(
    () => planMarketOpen({ account: account(), instrument: instrument(), quote: quote(), side: 'BUY', volume: '1', stopLoss: '1.10100', nowMs: 10_100 }),
    error => error.code === 'INVALID_PROTECTION_PRICE',
  );

  const plan = planMarketOpen({
    account: account(),
    instrument: instrument(),
    quote: quote(),
    side: 'BUY',
    volume: '1',
    stopLoss: '1.09000',
    takeProfit: '1.12000',
    nowMs: 10_100,
  });
  assert.equal(plan.stopLoss, '1.09');
  assert.equal(plan.takeProfit, '1.12');
});

test('partial close of a long uses bid, realizes PnL and releases proportional margin', () => {
  const position = {
    _id: '507f191e810c19729de860ea',
    accountId: '507f1f77bcf86cd799439011',
    symbol: 'EURUSD',
    side: 'BUY',
    status: 'OPEN',
    openVolume: '1',
    entryPrice: '1.10005',
    contractSize: '100000',
    volumeStep: '0.01',
    quoteCurrency: 'USD',
    margin: '1100.05',
  };
  const plan = planMarketClose({
    account: account(),
    instrument: instrument(),
    quote: quote({ bid: 1.10105, ask: 1.10115 }),
    position,
    volume: '0.4',
    nowMs: 10_100,
  });

  assert.equal(plan.fillPrice, '1.10105');
  assert.equal(plan.realizedPnl, '40');
  assert.equal(plan.remainingVolume, '0.6');
  assert.equal(plan.releasedMargin, '440.02');
  assert.equal(plan.dealType, 'PARTIAL_CLOSE');
});

test('full close of a short uses ask and releases all remaining margin', () => {
  const position = {
    _id: '507f191e810c19729de860ea',
    accountId: '507f1f77bcf86cd799439011',
    symbol: 'EURUSD',
    side: 'SELL',
    status: 'OPEN',
    openVolume: '0.5',
    entryPrice: '1.105',
    contractSize: '100000',
    volumeStep: '0.01',
    quoteCurrency: 'USD',
    margin: '552.5',
  };
  const plan = planMarketClose({
    account: account(),
    instrument: instrument(),
    quote: quote({ bid: 1.09995, ask: 1.10005 }),
    position,
    nowMs: 10_100,
  });

  assert.equal(plan.fillPrice, '1.10005');
  assert.equal(plan.realizedPnl, '247.5');
  assert.equal(plan.remainingVolume, '0');
  assert.equal(plan.releasedMargin, '552.5');
  assert.equal(plan.dealType, 'CLOSE');
});

test('adverse slippage is positive when the fill is worse for either side', () => {
  assert.equal(calculateAdverseSlippage({ side: 'BUY', fillPrice: '1.1001', requestedPrice: '1.1' }), '0.0001');
  assert.equal(calculateAdverseSlippage({ side: 'SELL', fillPrice: '1.0999', requestedPrice: '1.1' }), '0.0001');
});


test('market execution enforces maximum open positions', () => {
  assert.throws(
    () => planMarketOpen({
      account: account({ riskPolicy: { allowedSymbols: [], maxOpenPositions: 2 } }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '1',
      exposure: { currentOpenPositions: 2, currentTotalVolume: '1.5' },
      nowMs: 10_100,
    }),
    error => error.code === 'MAX_OPEN_POSITIONS_REACHED',
  );
});

test('market execution enforces maximum total volume', () => {
  assert.throws(
    () => planMarketOpen({
      account: account({ riskPolicy: { allowedSymbols: [], maxTotalVolume: '2' } }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '0.6',
      exposure: { currentOpenPositions: 2, currentTotalVolume: '1.5' },
      nowMs: 10_100,
    }),
    error => error.code === 'MAX_TOTAL_VOLUME_REACHED',
  );
});


test('market execution accepts a quote past soft recovery age but inside the hard cutoff', () => {
  const plan = planMarketOpen({
    account: account(),
    instrument: instrument({ softQuoteAgeMs: 1000, maxQuoteAgeMs: 5000 }),
    quote: quote({ receivedAtMs: 7000, isStale: false }),
    side: 'BUY',
    volume: '1',
    nowMs: 10_100,
  });
  assert.equal(plan.fillPrice, '1.10005');
});

test('market execution still blocks beyond the hard quote cutoff', () => {
  assert.throws(
    () => planMarketOpen({
      account: account(),
      instrument: instrument({ softQuoteAgeMs: 1000, maxQuoteAgeMs: 5000 }),
      quote: quote({ receivedAtMs: 4000, isStale: false }),
      side: 'BUY',
      volume: '1',
      nowMs: 10_100,
    }),
    error => error.code === 'QUOTE_STALE' && error.details.maxAgeMs === 5000,
  );
});
