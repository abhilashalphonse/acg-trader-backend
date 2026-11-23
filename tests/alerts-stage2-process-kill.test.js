'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const path = require('node:path');
const mongoose = require('mongoose');
const { AlertShadowWorker } = require('../src/modules/alerts/alert-worker');
const { position } = require('../src/modules/alerts/alert-event-contract');
const { AlertRule, MarketBatch, AlertTrigger, AlertOutbox, AlertLease,
  StreamCoverage } = require('../src/modules/alerts/alert-models');

const enabled = process.env.ACG_ALERTS_STAGE2_E2E === 'true';
const uri = process.env.ACG_ALERTS_STAGE2_E2E_MONGO_URI || '';
const streamId = 'twelve-data:XAUUSD';
const leaseId = 'stage2-alert-evaluator';
const boundaries = ['after_rule_update', 'after_trigger_insert',
  'after_outbox_insert', 'after_commit'];

if (!enabled) {
  test('real process-kill recovery (local replica set only)', { skip: true }, () => {});
} else {
  before(async () => {
    if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):27017\//.test(uri)) {
      throw new Error('Process-kill tests require dedicated localhost MongoDB');
    }
    await mongoose.connect(uri, { maxPoolSize: 10, serverSelectionTimeoutMS: 12000 });
    await Promise.all([AlertRule, MarketBatch, AlertTrigger, AlertOutbox,
      AlertLease, StreamCoverage].map(model => model.init()));
  });
  after(async () => { await mongoose.disconnect(); });

  async function reset() {
    await Promise.all([AlertRule, MarketBatch, AlertTrigger, AlertOutbox,
      AlertLease, StreamCoverage].map(model => model.deleteMany({})));
  }
  async function fixture() {
    const now = Date.now();
    const rule = await AlertRule.create({
      tenantId: 'process-kill-only', ownerId: 'test-user', streamId, symbol: 'XAUUSD',
      feedId: 'twelve-data', status: 'STARTING', version: 1,
      condition: { type: 'crosses_above', level: '100' },
      priceSource: 'bid', tickSize: '1', frequency: 'once',
      effectiveFrom: new Date(now - 60000),
    });
    const events = [99,101].map((price,i) => ({
      schemaVersion: 1, kind:'quote', streamId,
      eventId:position(streamId,1,i+1),
      marketTimeMs:now-10000+(i*1000), receivedAtMs:now-10000+(i*1000),
      acceptedAtMs:now,
      prices:{bid:String(price),ask:String(price),last:String(price)},
      quality:'LIVE',
    }));
    await MarketBatch.create({
      streamId, generation:1,firstSequence:1,lastSequence:2,events,
      acceptedAt:new Date(now), expiresAt:new Date(now+3600000),
    });
    return rule;
  }
  async function killAt(point, ruleId) {
    const child = fork(path.join(__dirname, 'helpers/alerts-kill-child.js'), [], {
      stdio: ['ignore','pipe','pipe','ipc'],
      env: { ...process.env, ACG_ALERTS_KILL_AT:point,
        ACG_ALERTS_KILL_RULE_ID:String(ruleId) },
    });
    let output = '';
    child.stderr.on('data', chunk => { output += String(chunk).slice(-3000); });
    try {
      await new Promise((resolve,reject) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          reject(new Error('Timed out awaiting ' + point + ': ' + output));
        }, 20000);
        child.on('message', msg => {
          if (done) return;
          if (msg.kind === 'ERROR') {
            done = true; clearTimeout(timer);
            reject(new Error('Child error: ' + msg.message));
          }
          if (msg.kind === 'BOUNDARY' && msg.boundary === point) {
            done = true; clearTimeout(timer); resolve();
          }
        });
        child.once('exit', (code,signal) => {
          if (done) return;
          done = true; clearTimeout(timer);
          reject(new Error('Child exited before boundary '+point+': '+code+'/'+signal+' '+output));
        });
        child.once('error', error => {
          if (done) return;
          done = true; clearTimeout(timer); reject(error);
        });
      });
    } finally {
      child.kill('SIGKILL'); // Actual OS-level termination, no graceful shutdown.
      await new Promise(resolve => {
        if (child.exitCode != null || child.signalCode != null) resolve();
        else child.once('exit',resolve);
      });
    }
  }

  async function snapshot(ruleId) {
    const current = await AlertRule.findById(ruleId).lean();
    const triggers = await AlertTrigger.find({alertId:ruleId}).lean();
    const outbox = await AlertOutbox.find({}).lean();
    return { current, triggers, outbox };
  }

  for (const boundary of boundaries) {
    test('SIGKILL at '+boundary+' leaves recoverable, exactly-once outcome', async () => {
      await reset();
      const rule = await fixture();
      await killAt(boundary, rule._id);
      // A dead evaluator's lease will eventually expire naturally. Set the
      // expiry to the past to avoid a 15-second delay for each test phase.
      await AlertLease.updateOne({_id:leaseId},{$set:{expiresAt:new Date(0)}});
      const state = await snapshot(rule._id);
      const committed = boundary === 'after_commit';
      assert.equal(state.triggers.length,committed ? 1 : 0);
      assert.equal(state.outbox.length,committed ? 1 : 0);
      assert.equal(Boolean(state.current.checkpoint),committed);
      if (committed) assert.equal(state.current.status,'COMPLETED');
      const replacement = new AlertShadowWorker({ownerId:'replacement-'+boundary});
      assert.ok(await replacement.acquireLease() != null);
      const fresh = await AlertRule.findById(rule._id).lean();
      if (!committed) assert.equal(await replacement.processRule(fresh),true);
      else assert.equal(await replacement.processRule(fresh),false);
      // Replaying the same input can never produce duplicate history or jobs.
      const last = await AlertRule.findById(rule._id).lean();
      assert.equal(await replacement.processRule(last),false);
      const final = await snapshot(rule._id);
      assert.equal(final.current.status,'COMPLETED');
      assert.deepEqual(final.current.checkpoint,{streamId,generation:1,sequence:2});
      assert.equal(final.triggers.length,1);
      assert.equal(final.triggers[0].eventId,position(streamId,1,2));
      assert.equal(final.outbox.length,1);
      assert.equal(String(final.outbox[0].triggerId),String(final.triggers[0]._id));
      assert.equal(final.outbox[0].channel,'shadow');
    });
  }
}
