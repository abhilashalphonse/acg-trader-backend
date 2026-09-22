'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeLegacyFundedRiskDefaults,
  metadataValue,
  decimalText,
  modifiedCount,
} = require('../../src/modules/accounts/risk-policy-migration');

test('legacy ACG Funded risk defaults are cleared without touching non-Funded accounts', async () => {
  const updates = [];
  const candidates = [
    {
      _id: '64b000000000000000000001',
      metadata: { fundedAccountId: 'funded-1' },
      riskPolicy: {
        maxRiskPerTradePercent: '1',
        maxAggregateRiskPercent: '2',
        maxMarginUsagePercent: '50',
        maxSingleOrderMarginPercentOfFree: '20',
        maxSymbolMarginPercentOfPermitted: '30',
      },
    },
    {
      _id: '64b000000000000000000002',
      metadata: new Map([['fundedAccountId', 'funded-2']]),
      riskPolicy: {
        maxRiskPerTradePercent: '1',
        maxAggregateRiskPercent: null,
        maxMarginUsagePercent: '50',
        maxSingleOrderMarginPercentOfFree: '20',
        maxSymbolMarginPercentOfPermitted: '30',
      },
    },
    {
      _id: '64b000000000000000000003',
      metadata: {},
      riskPolicy: {
        maxRiskPerTradePercent: '1',
        maxAggregateRiskPercent: '2',
        maxMarginUsagePercent: '50',
        maxSingleOrderMarginPercentOfFree: '20',
        maxSymbolMarginPercentOfPermitted: '30',
      },
    },
  ];

  const expectedCounts = {
    'riskPolicy.maxRiskPerTradePercent': 2,
    'riskPolicy.maxAggregateRiskPercent': 1,
    'riskPolicy.maxMarginUsagePercent': 2,
    'riskPolicy.maxSingleOrderMarginPercentOfFree': 2,
    'riskPolicy.maxSymbolMarginPercentOfPermitted': 2,
  };

  const accountModel = {
    find() {
      return {
        select() { return this; },
        async lean() { return candidates; },
      };
    },
    async updateMany(filter, update) {
      updates.push({ filter, update });
      const field = Object.keys(update.$set)[0];
      return { modifiedCount: expectedCounts[field] || 0 };
    },
  };

  const result = await normalizeLegacyFundedRiskDefaults({ accountModel });

  assert.deepEqual(result, {
    maxRiskPerTradeCleared: 2,
    maxAggregateRiskCleared: 1,
    maxMarginUsageCleared: 2,
    maxSingleOrderMarginCleared: 2,
    maxSymbolMarginCleared: 2,
  });
  assert.equal(updates.length, 5);
  for (const update of updates) {
    const field = Object.keys(update.update.$set)[0];
    assert.equal(update.update.$set[field], null);
  }
});

test('migration helpers normalize metadata and decimal representations', () => {
  assert.equal(metadataValue(new Map([['fundedAccountId', 'abc']]), 'fundedAccountId'), 'abc');
  assert.equal(metadataValue({ fundedAccountId: 'xyz' }, 'fundedAccountId'), 'xyz');
  assert.equal(metadataValue({}, 'fundedAccountId'), null);
  assert.equal(decimalText({ toString: () => '1' }), '1');
  assert.equal(decimalText(null), null);
  assert.equal(modifiedCount({ modifiedCount: 4 }), 4);
  assert.equal(modifiedCount({ nModified: 2 }), 2);
  assert.equal(modifiedCount(null), 0);
});
