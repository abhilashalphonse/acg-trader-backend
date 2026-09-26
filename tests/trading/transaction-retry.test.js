'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runMongoTransaction } = require('../../src/modules/trading/market-order.service');

test('transaction wrapper preserves driver-level retry semantics', async () => {
  let attempts = 0;
  let ended = false;
  const fakeSession = {
    async withTransaction(work) {
      attempts += 1;
      await work();
      attempts += 1;
      await work();
    },
    async endSession() { ended = true; },
  };

  let workCalls = 0;
  const result = await runMongoTransaction(
    async () => {
      workCalls += 1;
      return { revision: workCalls };
    },
    null,
    { startSession: async () => fakeSession },
  );

  assert.equal(workCalls, 2);
  assert.equal(attempts, 2);
  assert.deepEqual(result, { revision: 2 });
  assert.equal(ended, true);
});

test('independent process-local queues are not treated as the cross-process correctness boundary', async () => {
  const { AccountCommandQueue } = require('../../src/modules/trading/account-command-queue');
  const left = new AccountCommandQueue();
  const right = new AccountCommandQueue();

  let active = 0;
  let overlapped = false;
  const task = async () => {
    active += 1;
    if (active > 1) overlapped = true;
    await new Promise(resolve => setImmediate(resolve));
    active -= 1;
  };

  await Promise.all([
    left.run('account-a', task),
    right.run('account-a', task),
  ]);

  assert.equal(overlapped, true);
});
