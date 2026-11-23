'use strict';
// Child of alerts-stage2-process-kill.test.js. Never runs against any remote DB.
// Parent SIGKILLs this process at one of four precise transaction boundaries.
const mongoose = require('mongoose');
const { AlertRule, AlertTrigger, AlertOutbox } = require('../../src/modules/alerts/alert-models');
const { AlertShadowWorker } = require('../../src/modules/alerts/alert-worker');

async function blockAt(boundary) {
  process.send?.({ kind: 'BOUNDARY', boundary });
  await new Promise(() => {}); // Hold the transaction; the parent must SIGKILL.
}
const point = process.env.ACG_ALERTS_KILL_AT;
function intercept(model, method, boundary) {
  const original = model[method].bind(model);
  model[method] = async (...args) => {
    const result = await original(...args);
    if (point === boundary) await blockAt(boundary);
    return result;
  };
}

async function run() {
  const uri = process.env.ACG_ALERTS_STAGE2_E2E_MONGO_URI || '';
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):27017\//.test(uri)) {
    throw new Error('Child process requires local-only MongoDB replica-set URI');
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 3 });
  const rule = await AlertRule.findById(process.env.ACG_ALERTS_KILL_RULE_ID).lean();
  if (!rule) throw new Error('Test rule does not exist');
  if (point === 'after_rule_update') intercept(AlertRule, 'updateOne', point);
  if (point === 'after_trigger_insert') intercept(AlertTrigger, 'create', point);
  if (point === 'after_outbox_insert') intercept(AlertOutbox, 'create', point);
  if (point === 'after_commit') {
    const nativeStart = mongoose.startSession.bind(mongoose);
    mongoose.startSession = async (...args) => {
      const session = await nativeStart(...args);
      const nativeWithTransaction = session.withTransaction.bind(session);
      session.withTransaction = async (...txArgs) => {
        const result = await nativeWithTransaction(...txArgs);
        await blockAt('after_commit');
        return result;
      };
      return session;
    };
  }
  const worker = new AlertShadowWorker({ ownerId: 'kill-test-' + point });
  if (await worker.acquireLease() == null) throw new Error('Cannot acquire test lease');
  process.send?.({ kind: 'LEASE_ACQUIRED' });
  await worker.processRule(rule);
  throw new Error('Worker unexpectedly finished without reaching injection boundary: ' + point);
}
run().catch(error => {
  process.send?.({ kind: 'ERROR', message: String(error.stack || error) });
  process.exitCode = 1;
});
