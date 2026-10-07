'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { previewSchema } = require('../../src/modules/trading/trading.routes');
const { serializeMarketPreview } = require('../../src/modules/trading/market-order.service');

test('order preview accepts trading inputs without an idempotency key', () => {
  const result = previewSchema.safeParse({
    accountId: '507f1f77bcf86cd799439011',
    symbol: 'RELIANCE',
    side: 'BUY',
    volume: '10',
    stopLoss: null,
    takeProfit: null,
    source: 'WEB',
  });

  assert.equal(result.success, true);
  assert.equal(result.data.symbol, 'RELIANCE');
  assert.equal(Object.hasOwn(result.data, 'clientOrderId'), false);
});

test('order preview response carries margin, leverage, risk and projected account evidence', () => {
  const preview = serializeMarketPreview({
    account: {
      _id: '507f1f77bcf86cd799439011',
      currency: 'USD',
    },
    instrument: {
      assetClass: 'EQUITY',
    },
    plan: {
      symbol: 'RELIANCE',
      side: 'BUY',
      volume: '10',
      fillPrice: '2500',
      accountLeverage: 100,
      instrumentLeverage: 10,
      effectiveLeverage: 10,
      leveragePolicyVersion: 2,
      marginRate: null,
      requiredMargin: '27.777777777778',
      commission: '0',
      estimatedCloseCommission: '0',
      immediateOpeningPnl: '-0.111111111111',
      riskAmount: null,
      riskPercent: null,
      rawStopRiskAmount: null,
      projectedAccountState: {
        balance: '100000',
        floatingPnl: '-0.111111111111',
        equity: '99999.888888888889',
        usedMargin: '27.777777777778',
        freeMargin: '99972.111111111111',
        marginLevel: '359999.6',
      },
    },
    quoteSnapshot: {
      bid: 2499,
      ask: 2500,
      source: 'ACCELPIX_TEST',
      sequence: 77,
      receivedAtMs: 1791360000000,
    },
    policyDecision: {
      allowed: true,
      wouldBlock: false,
      enforced: false,
      kind: null,
      decisions: [],
    },
    nowMs: 1791360000100,
  });

  assert.equal(preview.previewVersion, 'ACG_ORDER_PREVIEW_V1');
  assert.equal(preview.accountCurrency, 'USD');
  assert.equal(preview.assetClass, 'EQUITY');
  assert.equal(preview.leverage.effective, 10);
  assert.equal(preview.leverage.policyVersion, 2);
  assert.equal(preview.costs.requiredMargin, '27.777777777778');
  assert.equal(preview.costs.immediateOpeningPnl, '-0.111111111111');
  assert.equal(preview.projectedAccount.equity, '99999.888888888889');
  assert.equal(preview.executionPolicy.allowed, true);
  assert.equal(preview.quote.source, 'ACCELPIX_TEST');
});
