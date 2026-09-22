'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeLegacyFundedPercentageRiskDefaults,
  modifiedCount,
} = require('../../src/modules/accounts/risk-policy-migration');

test('legacy ACG Funded percentage-risk defaults are cleared independently', async () => {
  const calls = [];
  const accountModel = {
    async updateMany(filter, update) {
      calls.push({ filter, update });
      return { modifiedCount: calls.length === 1 ? 3 : 2 };
    },
  };

  const result = await normalizeLegacyFundedPercentageRiskDefaults({ accountModel });

  assert.deepEqual(result, {
    maxRiskPerTradeCleared: 3,
    maxAggregateRiskCleared: 2,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].filter['metadata.fundedAccountId'], { $exists: true, $ne: null });
  assert.equal(calls[0].filter['riskPolicy.maxRiskPerTradePercent'], '1');
  assert.equal(calls[0].update.$set['riskPolicy.maxRiskPerTradePercent'], null);
  assert.equal(calls[1].filter['riskPolicy.maxAggregateRiskPercent'], '2');
  assert.equal(calls[1].update.$set['riskPolicy.maxAggregateRiskPercent'], null);
});

test('migration count helper supports modern and legacy mongoose results', () => {
  assert.equal(modifiedCount({ modifiedCount: 4 }), 4);
  assert.equal(modifiedCount({ nModified: 2 }), 2);
  assert.equal(modifiedCount(null), 0);
});
