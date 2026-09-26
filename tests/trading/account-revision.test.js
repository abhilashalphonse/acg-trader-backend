'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  financialRevisionOf,
  bumpFinancialRevision,
  assertFinancialRevision,
} = require('../../src/modules/trading/account-revision');

test('financial revisions advance independently from risk sequence', () => {
  const account = {
    financialRevision: 8,
    riskSequence: 31,
  };

  assert.equal(bumpFinancialRevision(account), 9);
  assert.equal(account.financialRevision, 9);
  assert.equal(account.riskSequence, 31);
});

test('missing financial revision is treated as revision zero for existing accounts', () => {
  const account = {};
  assert.equal(financialRevisionOf(account), 0);
  assert.equal(assertFinancialRevision(account, 0), 0);
});

test('stale financial revision is rejected with the current revision', () => {
  const account = { financialRevision: 12 };

  assert.throws(
    () => assertFinancialRevision(account, 11),
    error => error.code === 'STALE_VALUATION_REVISION'
      && error.details.expectedFinancialRevision === 11
      && error.details.currentFinancialRevision === 12,
  );
});
