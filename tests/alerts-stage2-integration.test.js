'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { DurableAlertStream } = require('../src/modules/alerts/alert-journal');
const { AlertShadowWorker } = require('../src/modules/alerts/alert-worker');
const { position } = require('../src/modules/alerts/alert-event-contract');
const {
  AlertRule, MarketBatch, StreamCoverage, AlertTrigger, AlertOutbox, AlertLease, AlertReplayGap,
} = require('../src/modules/alerts/alert-models');

const ENABLED = process.env.ACG_ALERTS_STAGE2_E2E === 'true';
const URI = process.env.ACG_ALERTS_STAGE2_E2E_MONGO_URI;
const streamId = 'twelve-data:XAUUSD';

if (!ENABLED) {
  test('Stage 2 MongoDB fault injection (requires explicit E2E flag)', { skip: true }, () => {});
} else {
  before(async () => {
    if (!URI || !/^(mongodb:\/\/127\.0\.0\.1|mongodb:\/\/localhost)/.test(URI)) {
      throw new Error('E2E MongoDB must be a dedicated localhost-only test instance');
    }
    await mongoose.connect(URI, { serverSelectionTimeoutMS: 15000, maxPoolSize: 10 });
    await Promise.all([AlertRule, MarketBatch, StreamCoverage, AlertTrigger, AlertOutbox, AlertLease, AlertReplayGap]
      .map(model => model.init()));
  });
  after(async () => { await mongoose.disconnect(); });

  async function clear() {
    await Promise.all([AlertRule, MarketBatch, StreamCoverage, AlertTrigger, AlertOutbox, AlertLease]
      .map(model => model.deleteMany({})));
  }

  function price(seq, value, receivedAtMs, generation = 1) {
    return {
      schemaVersion: 1, kind: 'quote', eventId: position(streamId, generation, seq), streamId,
      marketTimeMs: receivedAtMs, receivedAtMs, acceptedAtMs: Date.now(),
      prices: { bid: String(value), ask: String(value), last: String(value) },
      quality: 'LIVE',
    };
  }
  async function rule(fields = {}) {
    return AlertRule.create({
      tenantId: 'stage2-test-only', ownerId: 'stage2-user-only', streamId,
      symbol: 'XAUUSD', feedId: 'twelve-data',
      condition: { type: 'crosses_above', level: '100' },
      priceSource: 'bid', tickSize: '1', status: 'STARTING',
      frequency: 'repeat', version: 1,
      effectiveFrom: new Date(Date.now() - 120000),
      ...fields,
    });
  }
  async function batch(events, generation = 1, firstSequence = 1) {
    return MarketBatch.create({
      streamId, generation, firstSequence,
      lastSequence: firstSequence + events.length - 1, events,
      acceptedAt: new Date(), expiresAt: new Date(Date.now() + 3600000),
    });
  }

  test('pre-expiry trigger and outbox survive replay after wall-clock expiry', async () => {
    await clear();
    const now = Date.now(), expiry = now - 15000;
    const r = await rule({ expiresAt: new Date(expiry) });
    await batch([
      { kind: 'coverage_gap', eventId: position(streamId,1,1), streamId,
        marketTimeMs: now-30000, receivedAtMs: now-30000, acceptedAtMs: now,
        quality: 'GAP', reason: 'START' },
      price(2,99,now-22000),
      price(3,101,now-20000), // observed before expiry, committed after it
      { kind: 'expiry_watermark', eventId: position(streamId,1,4), streamId,
        marketTimeMs: now, receivedAtMs: now, acceptedAtMs: now,
        quality: 'CAPTURE_WATERMARK' },
    ]);
    const worker = new AlertShadowWorker();
    assert.ok(await worker.acquireLease() != null);
    assert.equal(await worker.processRule(r.toObject()), true);
    const finished = await AlertRule.findById(r._id).lean();
    assert.equal(finished.status, 'EXPIRED');
    assert.deepEqual(finished.checkpoint, { streamId, generation: 1, sequence: 4 });
    const triggers = await AlertTrigger.find({ alertId: r._id }).lean();
    assert.equal(triggers.length, 1);
    assert.equal(triggers[0].eventId, position(streamId,1,3));
    assert.equal(await AlertOutbox.countDocuments({triggerId: triggers[0]._id,channel:'shadow'}),1);
    const reloaded = await AlertRule.findById(r._id).lean();
    assert.equal(await worker.processRule(reloaded), false);
    assert.equal(await AlertTrigger.countDocuments({ alertId: r._id }), 1);
  });

  test('fault after trigger insert rolls back state, checkpoint, trigger and outbox', async () => {
    await clear();
    const r = await rule();
    const now=Date.now();
    await batch([price(1,99,now-5000),price(2,101,now-4000)]);
    const worker = new AlertShadowWorker();
    await worker.acquireLease();
    const original = AlertOutbox.create;
    try {
      AlertOutbox.create = async () => { throw new Error('INJECTED_OUTBOX_FAILURE'); };
      await assert.rejects(worker.processRule(r.toObject()), /INJECTED_OUTBOX_FAILURE/);
    } finally {
      AlertOutbox.create = original;
    }
    const afterFailure = await AlertRule.findById(r._id).lean();
    assert.equal(afterFailure.checkpoint, null);
    assert.equal(await AlertTrigger.countDocuments({ alertId: r._id }),0);
    assert.equal(await AlertOutbox.countDocuments({}),0);
    assert.equal(await worker.processRule(r.toObject()),true);
    assert.equal(await AlertTrigger.countDocuments({ alertId: r._id }),1);
    assert.equal(await AlertOutbox.countDocuments({}),1);
  });

  test('replacement evaluator fences previous token before committing a trigger', async () => {
    await clear();
    const r = await rule();
    const now=Date.now();
    await batch([price(1,99,now-5000),price(2,101,now-4000)]);
    const oldWorker = new AlertShadowWorker({ ownerId: 'old-evaluator' });
    const newerWorker = new AlertShadowWorker({ ownerId: 'new-evaluator' });
    assert.ok(await oldWorker.acquireLease() != null);
    assert.equal(await newerWorker.acquireLease(),null);
    await AlertLease.updateOne({ _id:'stage2-alert-evaluator' },
      { $set: { expiresAt: new Date(0) } });
    assert.ok(await newerWorker.acquireLease() != null);
    await assert.rejects(oldWorker.processRule(r.toObject()), /ALERT_LEASE_FENCED/);
    assert.equal(await AlertTrigger.countDocuments({}),0);
    assert.equal(await newerWorker.processRule(r.toObject()),true);
    assert.equal(await AlertTrigger.countDocuments({}),1);
  });


  for (const mutation of ['PAUSED','EDITED']) {
    test('concurrent '+mutation.toLowerCase()+' during evaluation rejects stale work', async () => {
      await clear();
      const r = await rule();
      const now=Date.now();
      await batch([price(1,99,now-5000),price(2,101,now-4000)]);
      const worker = new AlertShadowWorker();
      await worker.acquireLease();
      const originalNext = worker.nextBatch.bind(worker);
      let signalStarted;
      const entered = new Promise(resolve => { signalStarted = resolve; });
      let releaseEvaluation;
      const hold = new Promise(resolve => { releaseEvaluation = resolve; });
      worker.nextBatch = async (...args) => {
        const result = await originalNext(...args);
        signalStarted();
        await hold; // The rule was loaded before the external lifecycle change.
        return result;
      };
      const staleAttempt = worker.processRule(r.toObject());
      await entered;
      if (mutation === 'PAUSED') {
        await AlertRule.updateOne({ _id:r._id, version:1 },
          { $set:{status:'PAUSED'}, $inc:{version:1} });
      } else {
        await AlertRule.updateOne({ _id:r._id, version:1 },
          { $set:{ condition:{type:'crosses_below',level:'100'},
            effectiveFrom:new Date(),runtime:null,checkpoint:null }, $inc:{version:1} });
      }
      releaseEvaluation();
      await assert.rejects(staleAttempt,/ALERT_RULE_CHANGED_DURING_EVALUATION/);
      const persisted = await AlertRule.findById(r._id).lean();
      assert.equal(persisted.version,2);
      assert.equal(persisted.status,mutation === 'PAUSED' ? 'PAUSED':'STARTING');
      assert.equal(persisted.checkpoint,null);
      assert.equal(await AlertTrigger.countDocuments({alertId:r._id}),0);
      assert.equal(await AlertOutbox.countDocuments({}),0);
    });
  }

  test('journal ownership cannot ping-pong after a new generation takes over', async () => {
    await clear();
    const first = new DurableAlertStream({ streamId,ownerId:'first-capture' });
    const second = new DurableAlertStream({ streamId,ownerId:'second-capture' });
    try {
      assert.equal(await first.start(),true);
      await first.flush();
      assert.equal(await second.start(),false);
      assert.equal((await StreamCoverage.findById(streamId)).generation,1);
      await StreamCoverage.updateOne({ _id: streamId },
        { $set: { captureLeaseUntil: new Date(0) } });
      assert.equal(await second.start(),true);
      assert.equal(await first.renewLease(),false);
      assert.equal(first.superseded,true);
      assert.equal(await first.restart(),false);
      second.accept({kind:'quote', schemaVersion:1, streamId,
        marketTimeMs:Date.now(),receivedAtMs:Date.now(), prices:{bid:'100',ask:'101',last:'100'},
        quality:'LIVE'});
      await second.flush();
      const coverage = await StreamCoverage.findById(streamId).lean();
      assert.equal(coverage.generation,2);
      assert.equal(coverage.captureOwnerId,'second-capture');
      assert.equal(coverage.status,'MONITORING');
      assert.equal(await MarketBatch.countDocuments({streamId,generation:2}),1);
    } finally {
      first.buffer=[]; second.buffer=[];
      await first.stop(); await second.stop();
    }
  });


  async function awaitCondition(callback, message, timeoutMs = 10000) {
    const limit = Date.now() + timeoutMs;
    do {
      if (await callback()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    } while (Date.now() < limit);
    throw new Error('Timed out: ' + message);
  }

  test('provider disconnect records interrupted health and requires fresh baseline', async () => {
    await clear();
    const r = await rule();
    const stream = new DurableAlertStream({streamId, ownerId:'feed-outage-capture'});
    const event = (value, when) => ({kind:'quote', schemaVersion:1, streamId,
      marketTimeMs:when,receivedAtMs:when,quality:'LIVE',
      prices:{bid:String(value),ask:String(value),last:String(value)} });
    try {
      await stream.start();
      await stream.flush(); // Durable starting coverage gap.
      const startAt = Date.now();
      assert.equal(stream.accept(event(99,startAt)),true);
      await stream.flush();
      const worker = new AlertShadowWorker({ownerId:'feed-gap-evaluator'});
      await worker.acquireLease();
      let persisted = await AlertRule.findById(r._id).lean();
      assert.equal(await worker.processRule(persisted),true);
      persisted = await AlertRule.findById(r._id).lean();
      assert.equal(await worker.processRule(persisted),true);
      assert.equal(await AlertTrigger.countDocuments({alertId:r._id}),0);

      stream.interrupt('FEED_DISCONNECTED');
      await awaitCondition(async () => (await StreamCoverage.findById(streamId).lean())?.status === 'INTERRUPTED',
        'feed interruption persisted');
      assert.equal(await stream.restart('RECOVERY_AFTER_FEED_OUTAGE'),true);
      await stream.flush(); // Starting gap in a new generation.
      assert.equal(stream.accept(event(101,startAt+1000)),true);
      await stream.flush(); // Must NOT cross from previous generation 99.
      for(let i=0;i<2;i++){
        const next = await AlertRule.findById(r._id).lean();
        assert.equal(await worker.processRule(next),true);
      }
      assert.equal(await AlertTrigger.countDocuments({alertId:r._id}),0);
      assert.equal(stream.accept(event(99,startAt+2000)),true);
      await stream.flush();
      assert.equal(stream.accept(event(101,startAt+3000)),true);
      await stream.flush();
      for(let i=0;i<2;i++){
        const next = await AlertRule.findById(r._id).lean();
        assert.equal(await worker.processRule(next),true);
      }
      assert.equal(await AlertTrigger.countDocuments({alertId:r._id}),1);
      assert.ok(await AlertReplayGap.countDocuments({alertId:r._id}) >= 2);
      const final=await AlertRule.findById(r._id).lean();
      assert.ok(final.runtime.lastCoverageGap);
    } finally {
      await stream.stop();
    }
  });

  test('journal write rejection interrupts coverage, but never blocks later recovery', async () => {
    await clear();
    const stream = new DurableAlertStream({streamId, ownerId:'write-outage-capture'});
    try {
      await stream.start();
      await stream.flush();
      const original = stream.persist.bind(stream);
      stream.persist = async () => { throw new Error('INJECTED_DATABASE_WRITE_FAILURE'); };
      assert.equal(stream.accept({kind:'quote', schemaVersion:1, streamId,
        marketTimeMs:Date.now(),receivedAtMs:Date.now(),quality:'LIVE',
        prices:{bid:'99',ask:'100',last:'99'}}),true);
      await assert.rejects(stream.flush(), /INJECTED_DATABASE_WRITE_FAILURE/);
      await awaitCondition(async () => (await StreamCoverage.findById(streamId).lean())?.status === 'INTERRUPTED',
        'write failure persisted as interruption');
      const before=(await StreamCoverage.findById(streamId).lean()).generation;
      stream.persist = original;
      assert.equal(await stream.restart('RECOVERED_AFTER_DATABASE_OUTAGE'),true);
      await stream.flush();
      const after=await StreamCoverage.findById(streamId).lean();
      assert.equal(after.generation,before+1);
      assert.equal(after.status,'STARTING');
      const latest=await MarketBatch.findOne({streamId,generation:after.generation}).lean();
      assert.equal(latest.events[0].kind,'coverage_gap');
    } finally {
      await stream.stop();
    }
  });

  test('actual TTL deletion is recorded as unrecoverable; next tick is only baseline',
    { timeout: 85000 }, async () => {
      await clear();
      await mongoose.connection.db.admin().command({setParameter:1,ttlMonitorSleepSecs:1});
      const now=Date.now();
      const r=await rule({status:'MONITORING',
        checkpoint:{streamId,generation:1,sequence:1},
        runtime:{ baselineTicks:'99',armed:true,monitoring:'MONITORING',
          lastEventId:position(streamId,1,1),lastTriggerMs:null },
      });
      await StreamCoverage.create({_id:streamId,generation:1,lastSequence:2,
        status:'MONITORING',lastEventAt:new Date(now)});
      await MarketBatch.create({streamId,generation:1,firstSequence:2,lastSequence:2,
        events:[price(2,101,now-2000)],acceptedAt:new Date(now-2000),
        expiresAt:new Date(now-10000)});
      await awaitCondition(async () =>
        await MarketBatch.countDocuments({streamId,generation:1}) === 0,
        'Mongo TTL deletion',75000);
      const worker=new AlertShadowWorker();
      await worker.acquireLease();
      const stale=await AlertRule.findById(r._id).lean();
      assert.equal(await worker.processRule(stale),true); // Captured watermark, no retained events.
      const afterGap=await AlertRule.findById(r._id).lean();
      assert.equal(afterGap.runtime.monitoring,'INTERRUPTED');
      assert.equal(afterGap.runtime.baselineTicks,null);
      assert.deepEqual(afterGap.checkpoint,{streamId,generation:1,sequence:2});
      const gaps=await AlertReplayGap.find({alertId:r._id}).lean();
      assert.equal(gaps.length,1);
      assert.equal(gaps[0].reason,'REPLAY_UNAVAILABLE_NO_RETAINED_BATCH');
      assert.equal(await AlertTrigger.countDocuments({alertId:r._id}),0);

      await batch([price(3,101,now+1000),price(4,99,now+2000),
        price(5,101,now+3000)],1,3);
      const next=await AlertRule.findById(r._id).lean();
      assert.equal(await worker.processRule(next),true);
      const evidence=await AlertTrigger.find({alertId:r._id}).lean();
      assert.equal(evidence.length,1);
      assert.equal(evidence[0].eventId,position(streamId,1,5));
      assert.equal(await AlertReplayGap.countDocuments({alertId:r._id}),1);
    });

  test('missing replay segment resets crossing baseline rather than inventing a trigger', async () => {
    await clear();
    const now=Date.now();
    const r = await rule({
      status:'MONITORING', checkpoint:{streamId,generation:5,sequence:1},
      runtime: {baselineTicks:'99',armed:true,monitoring:'MONITORING',
        lastEventId:position(streamId,5,1),lastTriggerMs:null},
    });
    await batch([price(3,101,now-5000,5),price(4,99,now-4000,5),
      price(5,101,now-3000,5)],5,3);
    const worker = new AlertShadowWorker();
    await worker.acquireLease();
    assert.equal(await worker.processRule(r.toObject()),true);
    const evidence=await AlertTrigger.find({alertId:r._id}).lean();
    assert.equal(evidence.length,1);
    assert.equal(evidence[0].eventId,position(streamId,5,5));
    assert.equal(worker.gapResets,1);
  });
}
