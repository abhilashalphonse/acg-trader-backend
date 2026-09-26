'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BreachCleanupEngine } = require('../../src/modules/trading/breach-cleanup-engine');

function fakeJobModel(job) {
  return {
    findOneAndUpdate(_filter, update) {
      return Promise.resolve((() => {
        const now = update.$set.lastAttemptAt;
        const due = (job.state === 'PENDING' || job.state === 'RETRY')
          ? new Date(job.nextAttemptAt).getTime() <= now.getTime()
          : job.state === 'PROCESSING' && job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() <= now.getTime();
        if (!due) return null;
        Object.assign(job, update.$set);
        job.attempts = Number(job.attempts || 0) + Number(update.$inc?.attempts || 0);
        return job;
      })());
    },
    async updateOne(_filter, update) {
      Object.assign(job, update.$set || {});
      return { modifiedCount: 1 };
    },
  };
}

test('durable breach cleanup retries after a failed worker and completes after restart without creating a second job', async () => {
  let now = new Date('2026-09-26T20:00:00.000Z');
  const job = {
    _id: 'job-1',
    jobId: 'job-1',
    accountId: 'account-1',
    jobKey: 'post-fill-breach:order-1',
    state: 'PENDING',
    attempts: 0,
    nextAttemptAt: now,
    leaseExpiresAt: null,
    reason: 'DAILY_LOSS_LIMIT_REACHED',
    breachAction: 'LIQUIDATE_AND_LOCK',
    evidence: { equity: '96900' },
  };
  const model = fakeJobModel(job);

  let calls = 0;
  const first = new BreachCleanupEngine({
    jobModel: model,
    accountControlService: {
      async breach() {
        calls += 1;
        throw new Error('simulated process failure during liquidation');
      },
    },
    now: () => now,
    batchSize: 1,
  });

  await first.flush();
  assert.equal(job.state, 'RETRY');
  assert.equal(job.attempts, 1);
  assert.equal(calls, 1);

  now = new Date(job.nextAttemptAt.getTime() + 1);
  const second = new BreachCleanupEngine({
    jobModel: model,
    accountControlService: {
      async breach(accountId, options) {
        calls += 1;
        assert.equal(accountId, 'account-1');
        assert.equal(options.reason, 'DAILY_LOSS_LIMIT_REACHED');
        assert.equal(options.action, 'LIQUIDATE_AND_LOCK');
        assert.deepEqual(options.evidence, { equity: '96900' });
      },
    },
    now: () => now,
    batchSize: 1,
  });

  await second.flush();
  assert.equal(job.state, 'COMPLETED');
  assert.equal(job.attempts, 2);
  assert.equal(calls, 2);

  await second.flush();
  assert.equal(calls, 2);
});

test('expired processing lease is reclaimable after restart', async () => {
  const now = new Date('2026-09-26T21:00:00.000Z');
  const job = {
    _id: 'job-2',
    jobId: 'job-2',
    accountId: 'account-2',
    state: 'PROCESSING',
    attempts: 1,
    nextAttemptAt: new Date('2026-09-26T20:00:00.000Z'),
    leaseExpiresAt: new Date('2026-09-26T20:59:00.000Z'),
    reason: 'MAX_LOSS_LIMIT_REACHED',
    breachAction: 'LIQUIDATE_AND_LOCK',
    evidence: { equity: '93900' },
  };

  let calls = 0;
  const engine = new BreachCleanupEngine({
    jobModel: fakeJobModel(job),
    accountControlService: { async breach() { calls += 1; } },
    now: () => now,
    batchSize: 1,
  });

  await engine.flush();
  assert.equal(calls, 1);
  assert.equal(job.state, 'COMPLETED');
  assert.equal(job.attempts, 2);
});
