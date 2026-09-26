'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { runMongoTransaction } = require('../../src/modules/trading/market-order.service');

const mongoUri = process.env.MONGODB_URI;

test('independent backend connections cannot both consume the same financial capacity', {
  skip: !mongoUri,
  timeout: 20_000,
}, async () => {
  const connectionA = mongoose.createConnection(mongoUri);
  const connectionB = mongoose.createConnection(mongoUri);
  await Promise.all([connectionA.asPromise(), connectionB.asPromise()]);

  const collection = `v2_concurrency_${process.pid}_${Date.now()}`;
  const schemaA = new mongoose.Schema({
    remainingCapacity: { type: Number, required: true },
    financialRevision: { type: Number, required: true, default: 0 },
  }, { optimisticConcurrency: true });
  const schemaB = schemaA.clone();

  const AccountA = connectionA.model('V2ConcurrencyAccountA', schemaA, collection);
  const AccountB = connectionB.model('V2ConcurrencyAccountB', schemaB, collection);
  const created = await AccountA.create({
    remainingCapacity: 1,
    financialRevision: 0,
  });

  let arrivals = 0;
  let release;
  const bothRead = new Promise(resolve => { release = resolve; });
  const attempts = { A: 0, B: 0 };

  async function firstAttemptBarrier(worker) {
    if (attempts[worker] !== 1) return;
    arrivals += 1;
    if (arrivals === 2) release();
    await bothRead;
  }

  async function consume(Model, connection, worker) {
    return runMongoTransaction(async session => {
      attempts[worker] += 1;
      const account = await Model.findById(created._id).session(session);
      assert.ok(account);
      await firstAttemptBarrier(worker);

      if (account.remainingCapacity < 1) {
        return {
          accepted: false,
          financialRevision: account.financialRevision,
        };
      }

      account.remainingCapacity -= 1;
      account.financialRevision += 1;
      await account.save({ session });
      return {
        accepted: true,
        financialRevision: account.financialRevision,
      };
    }, null, {
      startSession: () => connection.startSession(),
      maxTransientRetries: 3,
    });
  }

  try {
    const [a, b] = await Promise.all([
      consume(AccountA, connectionA, 'A'),
      consume(AccountB, connectionB, 'B'),
    ]);

    assert.equal([a, b].filter(result => result.accepted).length, 1);
    assert.equal([a, b].filter(result => !result.accepted).length, 1);
    assert.ok(attempts.A + attempts.B >= 3, 'one transaction must be replayed after the write conflict');

    const finalAccount = await AccountA.findById(created._id).lean();
    assert.equal(finalAccount.remainingCapacity, 0);
    assert.equal(finalAccount.financialRevision, 1);
  } finally {
    await connectionA.db.dropCollection(collection).catch(() => undefined);
    await Promise.all([
      connectionA.close(),
      connectionB.close(),
    ]);
  }
});
