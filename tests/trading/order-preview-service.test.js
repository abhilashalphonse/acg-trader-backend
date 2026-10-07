'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MarketOrderService } = require('../../src/modules/trading/market-order.service');

function sessionValue(value) {
  return { session: async () => value };
}

function emptyExposureQuery() {
  return {
    select() { return this; },
    lean() { return this; },
    session: async () => [],
  };
}

test('market order preview plans against live state without reserving or persisting execution', async () => {
  const now = Date.now();
  const account = {
    _id: '507f1f77bcf86cd799439011',
    tenantId: '507f1f77bcf86cd799439012',
    currency: 'USD',
    leverage: 100,
    status: 'ACTIVE',
    tradingEnabled: true,
    riskProcessingState: 'RESOLVED',
    marginStopOutState: 'NONE',
    financialRevision: 7,
    riskPolicy: {
      maxRiskPerTradePercent: null,
      maxAggregateRiskPercent: null,
      maxMarginUsagePercent: null,
      maxSingleOrderMarginPercentOfFree: null,
      maxSymbolMarginPercentOfPermitted: null,
      maxOpenPositions: 10,
      maxPositionsPerSymbol: 3,
    },
    state: {
      initialBalance: '10000',
      balance: '10000',
      floatingPnl: '0',
      equity: '10000',
      usedMargin: '0',
      freeMargin: '10000',
      dailyStartEquity: '10000',
      realizedPnlToday: '0',
    },
  };
  const instrument = {
    symbol: 'EURUSD',
    assetClass: 'FOREX',
    status: 'ACTIVE',
    executionEnabled: true,
    quoteCurrency: 'USD',
    pnlCurrency: 'USD',
    marginCurrency: 'USD',
    tickSize: '0.00001',
    pipSize: '0.0001',
    contractSize: '100000',
    minVolume: '0.01',
    maxVolume: '100',
    volumeStep: '0.01',
    defaultLeverage: 100,
    leveragePolicyVersion: 2,
    marginRate: null,
    commissionPerLotPerSide: '2.5',
    commissionRate: '0',
    spread: { mode: 'MARKET', volumeBands: [] },
    tradingSessions: [],
    tradingHolidays: [],
    timezone: 'UTC',
    maxQuoteAgeMs: 30_000,
  };
  const quote = {
    symbol: 'EURUSD',
    bid: 1.0998,
    ask: 1.1000,
    source: 'TEST',
    sequence: 12,
    receivedAtMs: now,
    sourceTimestampMs: now,
    isStale: false,
  };

  let reserveCalls = 0;
  let policyPreviewCalls = 0;
  let transactionCalls = 0;
  let modelConstructs = 0;

  function forbiddenModel() {
    modelConstructs += 1;
    throw new Error('preview must not construct persistence models');
  }

  const service = new MarketOrderService({
    quoteStore: { get: symbol => symbol === 'EURUSD' ? quote : null },
    eventBus: null,
    logger: null,
    accountModel: {
      findById(id) {
        assert.equal(String(id), String(account._id));
        return sessionValue(account);
      },
    },
    instrumentModel: {
      findOne(filter) {
        assert.equal(filter.symbol, 'EURUSD');
        return sessionValue(instrument);
      },
      find() {
        throw new Error('instrument exposure query is unnecessary for empty exposure');
      },
    },
    positionModel: {
      find() { return emptyExposureQuery(); },
    },
    orderModel: forbiddenModel,
    dealModel: forbiddenModel,
    ledgerModel: forbiddenModel,
    commandQueue: {
      async run(accountId, callback) {
        assert.equal(String(accountId), String(account._id));
        return callback();
      },
    },
    idempotencyService: {
      async reserve() {
        reserveCalls += 1;
        throw new Error('preview must not reserve idempotency');
      },
    },
    tradingPermissionPolicyService: {
      async evaluateExposureIncrease(args) {
        policyPreviewCalls += 1;
        assert.equal(args.stage, 'PREVIEW');
        assert.equal(args.recordTelemetry, false);
        return { allowed: true, wouldBlock: false, enforced: false, decisions: [] };
      },
    },
    runTransaction: async callback => {
      transactionCalls += 1;
      return callback({ id: 'preview-session' });
    },
  });

  const revisionBefore = account.financialRevision;
  const balanceBefore = account.state.balance;

  const result = await service.previewMarketOrder({
    accountId: account._id,
    symbol: 'EURUSD',
    side: 'BUY',
    volume: '0.10',
    source: 'API',
  });

  assert.equal(result.previewVersion, 'ACG_ORDER_PREVIEW_V1');
  assert.equal(result.symbol, 'EURUSD');
  assert.equal(result.leverage.effective, 100);
  assert.equal(Number(result.costs.requiredMargin) > 0, true);
  assert.equal(Number(result.projectedAccount.usedMargin) > 0, true);

  assert.equal(account.financialRevision, revisionBefore);
  assert.equal(account.state.balance, balanceBefore);
  assert.equal(reserveCalls, 0);
  assert.equal(modelConstructs, 0);
  assert.equal(policyPreviewCalls, 1);
  assert.equal(transactionCalls, 1);
});
