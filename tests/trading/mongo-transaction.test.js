'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runMongoTransaction } = require('../../src/modules/trading/market-order.service');

test('transient transaction conflicts rerun the complete financial transaction', async () => {
  let withTransactionCalls = 0;
  let workCalls = 0;
  let ended = 0;

  const session = {
    async withTransaction(callback) {
      withTransactionCalls += 1;
      const value = await callback();
      if (withTransactionCalls === 1) {
        const error = new Error('simulated cross-process write conflict');
        error.errorLabels = ['TransientTransactionError'];
        throw error;
      }
      return value;
    },
    async endSession() {
      ended += 1;
    },
  };

  const result = await runMongoTransaction(
    async () => {
      workCalls += 1;
      return { attempt: workCalls };
    },
    null,
    {
      startSession: async () => session,
      maxTransientRetries: 2,
    },
  );

  assert.deepEqual(result, { attempt: 2 });
  assert.equal(withTransactionCalls, 2);
  assert.equal(workCalls, 2);
  assert.equal(ended, 1);
});

test('non-transient transaction failures are never replayed by the wrapper', async () => {
  let withTransactionCalls = 0;
  let workCalls = 0;

  const session = {
    async withTransaction(callback) {
      withTransactionCalls += 1;
      await callback();
      throw new Error('permanent failure');
    },
    async endSession() {},
  };

  await assert.rejects(
    () => runMongoTransaction(
      async () => {
        workCalls += 1;
      },
      null,
      {
        startSession: async () => session,
        maxTransientRetries: 3,
      },
    ),
    /permanent failure/,
  );

  assert.equal(withTransactionCalls, 1);
  assert.equal(workCalls, 1);
});

test('transient retry budget is bounded', async () => {
  let withTransactionCalls = 0;
  const session = {
    async withTransaction(callback) {
      withTransactionCalls += 1;
      await callback();
      const error = new Error('persistent transient conflict');
      error.hasErrorLabel = label => label === 'TransientTransactionError';
      throw error;
    },
    async endSession() {},
  };

  await assert.rejects(
    () => runMongoTransaction(
      async () => undefined,
      null,
      {
        startSession: async () => session,
        maxTransientRetries: 2,
      },
    ),
    /persistent transient conflict/,
  );

  assert.equal(withTransactionCalls, 3);
});
