'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WeekendActionService } = require('../../src/modules/trading/weekend-action.service');

test('weekend shutdown finishes existing claims without draining additional jobs', async () => {
  let claims = 0;
  let completed = 0;
  let releaseWrites;
  const writes = new Promise(resolve => { releaseWrites = resolve; });
  let enteredBoth;
  const bothEntered = new Promise(resolve => { enteredBoth = resolve; });
  const worker = new WeekendActionService({
    policyService: { config: { weekendEnforcementEnabled: true } },
    concurrency: 2,
    jobsPerWorker: 32,
    now: () => 10000,
    actionModel: {
      findOneAndUpdate() {
        const id = ++claims;
        return { lean: async () => ({ _id: String(id), generation: 1, marketCloseAt: new Date(0) }) };
      },
      async updateOne(claim, update) {
        assert.equal(update.$set.state, 'MISSED');
        if (claims === 2) enteredBoth();
        await writes;
        completed++;
      },
    },
  });
  const running = worker.runDue();
  assert.equal(worker.runDue(), running, 'overlapping polls share the current batch');
  await bothEntered;
  let stopped = false;
  const stopping = worker.stop().then(() => { stopped = true; });
  await Promise.resolve();
  assert.equal(stopped, false, 'shutdown waits for outstanding claim writes');
  releaseWrites();
  await stopping;
  assert.equal(completed, 2);
  assert.equal(claims, 2, 'shutdown must not drain the rest of the batch');
  await worker.runDue();
  assert.equal(claims, 2, 'a late poll cannot claim work after shutdown');
});
