'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planMarketOpen, planMarketClose } = require('../../src/modules/trading/execution-planner');
const { MarketOrderService } = require('../../src/modules/trading/market-order.service');

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


test('new exposure is blocked while margin stop-out is active but closing remains available', () => {
  const stopOutAccount = account({
    marginStopOutState: 'ACTIVE',
    marginStopOutEpisodeId: 'episode-1',
  });

  assert.throws(
    () => planMarketOpen({
      account: stopOutAccount,
      instrument: instrument(),
      quote,
      side: 'BUY',
      volume: '1',
      nowMs: 1100,
    }),
    error => error.code === 'MARGIN_STOP_OUT_ACTIVE',
  );

  const close = planMarketClose({
    account: stopOutAccount,
    instrument: instrument(),
    quote,
    position,
    volume: '0.5',
    nowMs: 1100,
  });
  assert.equal(close.volume, '0.5');
});

test('non-production quote preflight fault blocks configured symbols before provider recovery', async () => {
  let recoveryCalls = 0;
  const service = new MarketOrderService({
    quoteStore: { get: () => quote },
    eventBus: { emit() {} },
    logger: { warn() {} },
    quoteRecovery: async () => { recoveryCalls += 1; },
    quotePreflightUnavailableSymbols: ['EURUSD'],
    instrumentModel: {
      findOne() {
        return { lean: async () => instrument() };
      },
    },
  });

  await assert.rejects(
    () => service.ensureExecutableQuote('EURUSD', { reason: 'weekend-policy-preflight' }),
    error => error.code === 'QUOTE_UNAVAILABLE' && error.statusCode === 503,
  );
  assert.equal(recoveryCalls, 0);
});

