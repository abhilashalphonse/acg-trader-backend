'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { WeekendActionService, rolloutBucket } = require('../../src/modules/trading/weekend-action.service');

function rows(docs) {
  return {
    select() { return this; },
    lean: async () => docs,
  };
}

test('weekend cohort summary uses the enforcement bucket and counts live exposure', async () => {
  const tenantId = new mongoose.Types.ObjectId('0000000000000000000000aa');
  const accountIds = [
    new mongoose.Types.ObjectId('000000000000000000000001'),
    new mongoose.Types.ObjectId('000000000000000000000002'),
    new mongoose.Types.ObjectId('000000000000000000000003'),
  ];
  const nowMs = Date.parse('2026-10-10T00:30:00.000Z');
  const service = new WeekendActionService({
    policyService: { config: { weekendRolloutPercent: 1 } },
    accountModel: { find: () => rows(accountIds.map(_id => ({ _id }))) },
    positionModel: { find: () => rows([{ accountId: accountIds[0] }]) },
    orderModel: { find: () => rows([{ accountId: accountIds[1] }]) },
    now: () => nowMs,
  });

  const result = await service.cohortSummary(String(tenantId));
  const buckets = accountIds.map(id => rolloutBucket(String(id)));
  const exposedBuckets = buckets.slice(0, 2);

  assert.equal(result.status, 'OK');
  assert.equal(result.rolloutPercent, 1);
  assert.equal(result.eligibleAccounts, 3);
  assert.equal(result.accountsWithExposure, 2);
  assert.equal(result.eligibleAtCurrentRollout, buckets.filter(bucket => bucket < 1).length);
  assert.equal(result.exposedAtCurrentRollout, exposedBuckets.filter(bucket => bucket < 1).length);
  assert.equal(result.minimumRolloutPercentForEligible, Math.min(...buckets) + 1);
  assert.equal(result.minimumRolloutPercentForExposure, Math.min(...exposedBuckets) + 1);
  assert.equal(result.generatedAt, '2026-10-10T00:30:00.000Z');
});

test('weekend cohort summary reports null minimums when no account is eligible', async () => {
  const service = new WeekendActionService({
    policyService: { config: { weekendRolloutPercent: 1 } },
    accountModel: { find: () => rows([]) },
    positionModel: { find: () => { throw new Error('position query should not run'); } },
    orderModel: { find: () => { throw new Error('order query should not run'); } },
    now: () => Date.parse('2026-10-10T00:30:00.000Z'),
  });

  const result = await service.cohortSummary('0000000000000000000000aa');
  assert.equal(result.eligibleAccounts, 0);
  assert.equal(result.accountsWithExposure, 0);
  assert.equal(result.minimumRolloutPercentForEligible, null);
  assert.equal(result.minimumRolloutPercentForExposure, null);
});
