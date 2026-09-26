'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { challengeSyncSchema } = require('../../src/modules/trading/account-control.routes');
const { serializeAccount } = require('../../src/modules/trading/trading.serializer');

test('challenge sync accepts authoritative Funded risk policy version metadata', () => {
  const parsed = challengeSyncSchema.parse({
    riskPolicy: {
      maxRiskPerTradePercent: 1,
      maxAggregateRiskPercent: 2,
      maxMarginUsagePercent: 50,
      maxSingleOrderMarginPercentOfFree: 20,
      maxSymbolMarginPercentOfPermitted: 30,
      maxOpenPositions: 10,
      maxPositionsPerSymbol: 3,
      maxPendingOrders: 10,
      maxPendingOrdersPerSymbol: 3,
    },
    riskPolicyVersion: 'ACG_FUNDED_V1',
  });

  assert.equal(parsed.riskPolicyVersion, 'ACG_FUNDED_V1');
  assert.equal(parsed.riskPolicy.maxRiskPerTradePercent, '1');
  assert.equal(parsed.riskPolicy.maxAggregateRiskPercent, '2');
});

test('account serialization exposes risk policy version for audit verification', () => {
  const account = serializeAccount({
    _id: '507f1f77bcf86cd799439011',
    accountCode: 'ACG-TEST',
    accountType: 'CHALLENGE',
    currency: 'USD',
    leverage: 100,
    status: 'ACTIVE',
    tradingEnabled: true,
    riskDayKey: '2026-09-26',
    riskTimezone: 'UTC',
    state: {},
    riskPolicy: {},
    metadata: new Map([
      ['fundedAccountId', 'ACG-FUNDED-1'],
      ['riskPolicyVersion', 'ACG_FUNDED_V1'],
    ]),
  });

  assert.equal(account.challenge.fundedAccountId, 'ACG-FUNDED-1');
  assert.equal(account.challenge.riskPolicyVersion, 'ACG_FUNDED_V1');
});
