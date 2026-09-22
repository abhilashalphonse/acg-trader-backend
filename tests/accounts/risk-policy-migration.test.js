'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeLegacyFundedPercentageRiskDefaults,
  metadataValue,
  decimalText,
  modifiedCount,
} = require('../../src/modules/accounts/risk-policy-migration');

test('legacy ACG Funded percentage-risk defaults are cleared independently', async () => {
  const updates = [];
  const candidates = [
    {
      _id: '64b000000000000000000001',
      metadata: { fundedAccountId: 'funded-1' },
      riskPolicy: { maxRiskPerTradePercent: '1', maxAggregateRiskPercent: '2' },
    },
    {
      _id: '64b000000000000000000002',
      metadata: new Map([['fundedAccountId', 'funded-2']]),
      riskPolicy: { maxRiskPerTradePercent: '1', maxAggregateRiskPercent: null },
    },
    {
      _id: '64b000000000000000000003',
      metadata: {},
      riskPolicy: { maxRiskPerTradePercent: '1', maxAggregateRiskPercent: '2' },
    },
  ];

  const accountModel = {
    find() {
      return {
        select() { return this; },
        async lean() { return candidates; },
      };
    },
    async updateMany(filter, update) {
      updates.push({ filter, update });
      return { modifiedCount: updates.length === 1 ? 2 : 1 };
    },
  };

  const result = await normalizeLegacyFundedPercentageRiskDefaults({ accountModel });

  assert.deepEqual(result, {
    maxRiskPerTradeCleared: 2,
    maxAggregateRiskCleared: 1,
  });
  assert.equal(updates.length, 2);
  assert.equal(updates[0].update.$set['riskPolicy.maxRiskPerTradePercent'], null);
  assert.equal(updates[1].update.$set['riskPolicy.maxAggregateRiskPercent'], null);
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
