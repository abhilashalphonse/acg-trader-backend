'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { challengeSyncSchema, policyTransitionSchema, provisionSchema } = require('../../src/modules/trading/account-control.routes');
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


test('policy transition schema only permits the five explicit V2 null restrictions', () => {
  const parsed = policyTransitionSchema.parse({
    migrationId: 'v2-rollout-2026-09:account-1',
    fromVersion: 'ACG_FUNDED_V1',
    toVersion: 'ACG_FUNDED_V2',
    riskPolicy: {
      maxRiskPerTradePercent: null,
      maxAggregateRiskPercent: null,
      maxMarginUsagePercent: null,
      maxSingleOrderMarginPercentOfFree: null,
      maxSymbolMarginPercentOfPermitted: null,
    },
  });

  assert.equal(parsed.toVersion, 'ACG_FUNDED_V2');
  assert.equal(parsed.riskPolicy.maxRiskPerTradePercent, null);
  assert.throws(() => policyTransitionSchema.parse({
    ...parsed,
    riskPolicy: { ...parsed.riskPolicy, maxOpenPositions: null },
  }));
});

test('account serialization exposes V2 capabilities only when version and five null limits agree', () => {
  const base = {
    _id: '507f1f77bcf86cd799439011',
    accountCode: 'ACG-CAP',
    accountType: 'CHALLENGE',
    currency: 'USD',
    leverage: 100,
    status: 'ACTIVE',
    tradingEnabled: true,
    riskDayKey: '2026-09-26',
    riskTimezone: 'UTC',
    state: {},
    riskPolicy: {
      maxRiskPerTradePercent: null,
      maxAggregateRiskPercent: null,
      maxMarginUsagePercent: null,
      maxSingleOrderMarginPercentOfFree: null,
      maxSymbolMarginPercentOfPermitted: null,
    },
  };

  const v2 = serializeAccount({
    ...base,
    metadata: new Map([['riskPolicyVersion', 'ACG_FUNDED_V2']]),
  });
  assert.equal(v2.capabilities.fundedV2Confirmed, true);
  assert.equal(v2.capabilities.optionalStopLoss, true);
  assert.equal(v2.capabilities.manualLotWithoutStopLoss, true);
  assert.equal(v2.capabilities.riskPercentSizingRequiresStopDistance, true);
  assert.equal(v2.capabilities.marginStopOutLevelPercent, '50');

  const mismatched = serializeAccount({
    ...base,
    riskPolicy: { ...base.riskPolicy, maxMarginUsagePercent: '50' },
    metadata: new Map([['riskPolicyVersion', 'ACG_FUNDED_V2']]),
  });
  assert.equal(mismatched.capabilities.fundedV2Confirmed, false);
  assert.equal(mismatched.capabilities.optionalStopLoss, false);
});


test('provisioning contract accepts only the approved trading-permission invariants', () => {
  const parsed = provisionSchema.parse({
    externalRef: 'ACG-1:phase:1',
    ownerExternalRef: 'customer-1',
    initialBalance: '100000',
    tradingPermissions: {
      newsTrading: false,
      weekendHolding: true,
      highImpactOnly: true,
      newsRestrictionBeforeMinutes: 5,
      newsRestrictionAfterMinutes: 5,
      closeReduceAlwaysAllowed: true,
      pendingEntriesBlocked: true,
      weekendCloseBufferMinutes: 5,
      weekendBreach: false,
      carryToMaster: true,
    },
  });
  assert.equal(parsed.tradingPermissions.newsTrading, false);
  assert.equal(parsed.tradingPermissions.weekendHolding, true);
  assert.throws(() => provisionSchema.parse({
    externalRef: 'ACG-2:phase:1',
    ownerExternalRef: 'customer-2',
    initialBalance: '100000',
    tradingPermissions: { newsTrading: false, newsRestrictionBeforeMinutes: 30 },
  }));
});

test('account serialization treats missing historical trading permissions as permissive', () => {
  const serialized = serializeAccount({
    _id: '507f1f77bcf86cd799439011',
    accountCode: 'ACG-LEGACY',
    accountType: 'CHALLENGE',
    currency: 'USD',
    leverage: 100,
    status: 'ACTIVE',
    tradingEnabled: true,
    state: {},
    riskPolicy: {},
    metadata: new Map(),
  });
  assert.equal(serialized.tradingPermissions.newsTrading, true);
  assert.equal(serialized.tradingPermissions.weekendHolding, true);
  assert.equal(serialized.tradingPermissions.newsRestrictionBeforeMinutes, 5);
});
