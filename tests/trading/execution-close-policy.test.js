'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planMarketOpen, planMarketClose } = require('../../src/modules/trading/execution-planner');

function account(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    status: 'ACTIVE',
    tradingEnabled: true,
    currency: 'USD',
    leverage: 100,
    riskPolicy: { allowedSymbols: [] },
    state: { balance: '10000', equity: '10000', freeMargin: '9000', usedMargin: '1000' },
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

const quote = {
  symbol: 'EURUSD',
  bid: 1.099,
  ask: 1.0992,
  sequence: 1,
  receivedAtMs: 1000,
  isStale: false,
};

const position = {
  _id: '507f191e810c19729de860ea',
  accountId: '507f1f77bcf86cd799439011',
  symbol: 'EURUSD',
  side: 'BUY',
  status: 'OPEN',
  openVolume: '1',
  entryPrice: '1.1',
  contractSize: '100000',
  volumeStep: '0.01',
  quoteCurrency: 'USD',
  margin: '1100',
};

test('new exposure remains blocked when account or instrument execution is disabled', () => {
  assert.throws(
    () => planMarketOpen({ account: account({ status: 'BREACHED' }), instrument: instrument(), quote, side: 'BUY', volume: '1', nowMs: 1100 }),
    error => error.code === 'ACCOUNT_NOT_ACTIVE',
  );
  assert.throws(
    () => planMarketOpen({ account: account(), instrument: instrument({ executionEnabled: false }), quote, side: 'BUY', volume: '1', nowMs: 1100 }),
    error => error.code === 'INSTRUMENT_EXECUTION_DISABLED',
  );
});

test('risk-reducing close remains available for paused/breached accounts and execution-disabled instruments', () => {
  const plan = planMarketClose({
    account: account({ status: 'BREACHED', tradingEnabled: false }),
    instrument: instrument({ status: 'HALTED', executionEnabled: false }),
    quote,
    position,
    nowMs: 1100,
  });
  assert.equal(plan.fullClose, true);
  assert.equal(plan.fillPrice, '1.099');
  assert.equal(plan.realizedPnl, '-100');
});
