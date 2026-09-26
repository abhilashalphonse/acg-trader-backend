'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  FUNDED_ACCOUNT_RISK_POLICY,
  repairFundedAccountRiskPolicy,
  metadataValue,
  decimalText,
  modifiedCount,
} = require('../../src/modules/accounts/risk-policy-migration');

test('missing ACG Funded account risk fields are repaired without touching non-Funded accounts', async () => {
  const updates = [];
  const funded = {
    _id: '64b000000000000000000001',
    metadata: { fundedAccountId: 'funded-1' },
    riskPolicy: {},
  };
  const nonFunded = {
    _id: '64b000000000000000000002',
    metadata: {},
    riskPolicy: {},
  };

  const accountModel = {
    find(filter) {
      const field = Object.keys(filter)[0];
      assert.match(field, /^riskPolicy\./);
      assert.equal(filter[field], null);
      return {
        select() { return this; },
        async lean() { return [funded, nonFunded]; },
      };
    },
    async updateMany(filter, update) {
      updates.push({ filter, update });
      assert.deepEqual(filter._id.$in, [funded._id]);
      return { modifiedCount: 1 };
    },
  };

  const result = await repairFundedAccountRiskPolicy({ accountModel });

  assert.equal(updates.length, FUNDED_ACCOUNT_RISK_POLICY.length);
  assert.deepEqual(
    updates.map(update => update.update.$set),
    FUNDED_ACCOUNT_RISK_POLICY.map(item => ({ [`riskPolicy.${item.key}`]: item.value })),
  );
  assert.deepEqual(
    result,
    Object.fromEntries(FUNDED_ACCOUNT_RISK_POLICY.map(item => [item.resultKey, 1])),
  );
});

test('repair preserves existing explicit policy values because it only queries null or missing fields', async () => {
  const findFilters = [];
  let updates = 0;
  const accountModel = {
    find(filter) {
      findFilters.push(filter);
      return {
        select() { return this; },
        async lean() { return []; },
      };
    },
    async updateMany() {
      updates += 1;
      return { modifiedCount: 0 };
    },
  };

  const result = await repairFundedAccountRiskPolicy({ accountModel });

  assert.equal(findFilters.length, FUNDED_ACCOUNT_RISK_POLICY.length);
  assert.equal(updates, 0);
  assert.ok(Object.values(result).every(value => value === 0));
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
