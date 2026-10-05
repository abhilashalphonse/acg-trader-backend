'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { fork } = require('node:child_process');
const path = require('node:path');
const mongoose = require('mongoose');
const { TradingAccount } = require('../../src/modules/accounts/trading-account.model');
const { Instrument } = require('../../src/modules/instruments/instrument.model');
const { Order } = require('../../src/modules/trading/order.model');
const { Position } = require('../../src/modules/trading/position.model');
const { Deal } = require('../../src/modules/trading/deal.model');
const { MarketOrderService } = require('../../src/modules/trading/market-order.service');
const { runMongoTransaction } = require('../../src/modules/trading/market-order.service');
const { AtomicReverseService } = require('../../src/modules/trading/atomic-reverse.service');
const { PendingOrderService } = require('../../src/modules/trading/pending-order.service');
const { PendingOrderAmendService } = require('../../src/modules/trading/pending-order-amend.service');
const { TradingPermissionPolicyService, normalizeCalendarEvent } = require('../../src/modules/trading/trading-permission-policy.service');
const { ValuationEngine } = require('../../src/modules/trading/valuation-engine');
const { AccountStateSynchronizer } = require('../../src/modules/trading/account-state-synchronizer');
const { NewsCalendarSnapshotService } = require('../../src/modules/trading/news-calendar-snapshot.service');
const { NewsCalendarSnapshot, NewsCalendarState } = require('../../src/modules/trading/news-calendar-snapshot.model');
const { ensureCriticalIndexes } = require('../../src/config/indexes');
const { WeekendActionService } = require('../../src/modules/trading/weekend-action.service');
const { WeekendAccountAction } = require('../../src/modules/trading/weekend-action.model');
const { PolicyControlService, PolicyControlAudit } = require('../../src/modules/trading/policy-control.service');
const { PolicyMetricsService, PolicyMetricBucket } = require('../../src/modules/trading/policy-metrics.service');
const uri = process.env.TEST_MONGODB_URI;
const enabled = Boolean(uri);
const tenantId = new mongoose.Types.ObjectId();
const logger = { info() {}, warn() {}, error() {} };
const quoteStore = { get: () => ({ symbol: 'EURUSD', bid: 1.101, ask: 1.1012, receivedAtMs: Date.now(), isStale: false, sequence: 1, source: 'test' }) };
let count = 0;
async function account() {
  const id = ++count;
  return TradingAccount.create({ tenantId, externalRef: `integration-${id}`, accountCode: `TEST-${id}`, ownerExternalRef: `owner-${id}`,
    accountType: 'CHALLENGE', riskDayKey: new Date().toISOString().slice(0, 10), tradingPermissionsVersion: 1,
    tradingPermissions: { newsTrading: false, weekendHolding: false },
    state: { initialBalance: '100000', balance: '100000', equity: '100000', freeMargin: '100000', dailyStartEquity: '100000' } });
}
before(async () => {
  if (!enabled) return;
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/acg_policy_test(?:\?|$)/.test(uri)) throw new Error('Integration tests require a dedicated local acg_policy_test database');
  mongoose.set('sanitizeFilter', true);
  await mongoose.connect(uri);
  await ensureCriticalIndexes();
  await Instrument.create({ symbol: 'EURUSD', displaySymbol: 'EUR/USD', name: 'Euro / US Dollar', assetClass: 'FOREX', baseCurrency: 'EUR', quoteCurrency: 'USD',
    digits: 5, tickSize: '0.00001', pipSize: '0.0001', contractSize: '100000', minVolume: '0.01', maxVolume: '100', volumeStep: '0.01', defaultLeverage: 100,
    executionEnabled: true, commissionPerLot: '0', tradingSessions: [] });
});
after(async () => { if (enabled) { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); } });

test('Mongo: policy metrics combine instances, separate preview from execution and isolate tenants', { skip: !enabled }, async () => {
  const a = await account();
  const instrument = await Instrument.findOne({ symbol: 'EURUSD' }).lean();
  const metricsA = new PolicyMetricsService();
  const metricsB = new PolicyMetricsService();
  const calendarSnapshots = { read: () => ({ dataStatus: 'FRESH', snapshotVersion: 'metrics-test', events: [
    { id: 'cpi', timestamp: new Date().toISOString(), title: 'US CPI', currency: 'USD' },
  ] }) };
  const policyA = new TradingPermissionPolicyService({ metricsService: metricsA, calendarSnapshots,
    config: { newsEnforcementEnabled: false, weekendEnforcementEnabled: false, shadowEnabled: false } });
  const policyB = new TradingPermissionPolicyService({ metricsService: metricsB, calendarSnapshots,
    config: { newsEnforcementEnabled: true, newsRolloutPercent: 100, weekendEnforcementEnabled: false, shadowEnabled: false } });
  const input = { accountId: a.id, account: a, instrument, symbol: 'EURUSD', action: 'MARKET_OPEN' };
  assert.equal((await policyA.evaluateExposureIncrease(input)).allowed, true);
  assert.equal((await policyA.authorizeExecution(input)).allowed, true);
  await assert.rejects(policyB.authorizeExecution(input), { code: 'NEWS_TRADING_RESTRICTED' });
  metricsB.observe({ tenantId: new mongoose.Types.ObjectId(), action: 'MARKET_OPEN', decision: { allowed: true }, latencyMs: 1 });
  await Promise.all([metricsA.flush(), metricsB.flush()]);
  await metricsA.flush();
  const summary = await metricsA.summary(tenantId);
  assert.equal(summary.groups.length, 2);
  const execution = summary.groups.find(row => row.stage === 'EXECUTION');
  assert.equal(execution.evaluations, 2);
  assert.equal(execution.allowed, 1);
  assert.equal(execution.blocked, 1);
  assert.equal(execution.newsWouldBlock, 2);
  assert.equal(execution.latency.samples, 2);
  assert.equal(summary.groups.find(row => row.stage === 'PREVIEW').evaluations, 1);
  const indexes = await PolicyMetricBucket.collection.indexes();
  assert.equal(indexes.find(index => index.key.expiresAt)?.expireAfterSeconds, 0);
});

test('Mongo: a queued market order rechecks the news window inside execution and persists no exposure', { skip: !enabled }, async () => {
  const a = await account();
  const eventMs = Date.now() + 5 * 60000;
  let clock = eventMs - 5 * 60000 - 1;
  const policy = new TradingPermissionPolicyService({ now: () => new Date(clock), logger,
    config: { newsEnforcementEnabled: true, newsRolloutPercent: 100, weekendEnforcementEnabled: false, shadowEnabled: false },
    calendarSnapshots: { read: () => ({ dataStatus: 'FRESH', snapshotVersion: 'test-v1', events: [{ id: 'cpi', timestamp: new Date(eventMs).toISOString(), title: 'US CPI', currency: 'USD' }] }) } });
  assert.equal((await policy.evaluateExposureIncrease({ accountId: a.id, symbol: 'EURUSD' })).allowed, true);
  const service = new MarketOrderService({ quoteStore, logger, eventBus: new EventEmitter(), tradingPermissionPolicyService: policy,
    commandQueue: { run: async (_id, task) => { clock++; return task(); } } });
  await assert.rejects(service.openMarketOrder({ accountId: a.id, clientOrderId: 'boundary', symbol: 'EURUSD', side: 'BUY', volume: '1' }), { code: 'NEWS_TRADING_RESTRICTED' });
  assert.equal(await Position.countDocuments({ accountId: a.id }), 0);
  assert.equal(await Order.countDocuments({ accountId: a.id }), 0);
});

test('Mongo: independent runtimes recover a remote close from a consistent account snapshot', { skip: !enabled }, async () => {
  const a = await account();
  const busA = new EventEmitter();
  const busB = new EventEmitter();
  const service = new MarketOrderService({ quoteStore, logger, eventBus: busA });
  const opened = await service.openMarketOrder({ accountId: a.id, clientOrderId: 'open-for-sync', symbol: 'EURUSD', side: 'BUY', volume: '1' });
  const engineA = new ValuationEngine({ quoteStore, logger, eventBus: busA });
  const engineB = new ValuationEngine({ quoteStore, logger, eventBus: busB });
  await engineA.start(); await engineB.start();
  service.valuationEngine = engineA;
  const sync = new AccountStateSynchronizer({ eventBus: busB, valuationEngine: engineB, logger });
  sync.started = true;
  try {
    await service.closeMarketPosition({ accountId: a.id, positionId: opened.position.id, clientOrderId: 'close-for-sync', volume: null });
    assert.equal(engineB.getAccountSnapshot(a.id).positionCount, 1);
    await sync.reload(a.id);
    assert.equal(engineB.getAccountSnapshot(a.id).positionCount, 0);
    const doc = await TradingAccount.findById(a.id);
    assert.doesNotThrow(() => engineB.overlayAccountDocument(doc));
    assert.equal(await Deal.countDocuments({ accountId: a.id }), 2);
  } finally { await sync.stop(); await engineA.stop(); await engineB.stop(); }
});

test('Mongo: a retried transaction evaluates the new policy time after rolling back its first attempt', { skip: !enabled }, async () => {
  const a = await account();
  const eventMs = Date.now() + 5 * 60000;
  let clock = eventMs - 5 * 60000 - 1;
  const policy = new TradingPermissionPolicyService({ now: () => new Date(clock), logger,
    config: { newsEnforcementEnabled: true, newsRolloutPercent: 100, shadowEnabled: false },
    calendarSnapshots: { read: () => ({ dataStatus: 'FRESH', snapshotVersion: 'retry-v1', events: [{ id: 'retry-cpi', timestamp: new Date(eventMs).toISOString(), title: 'US CPI', currency: 'USD' }] }) } });
  let firstAttemptRan = false;
  const abort = new Error('test rollback');
  const service = new MarketOrderService({ quoteStore, logger, eventBus: new EventEmitter(), tradingPermissionPolicyService: policy,
    runTransaction: async work => {
      try { await runMongoTransaction(async session => { await work(session); firstAttemptRan = true; throw abort; }); }
      catch (error) { if (error !== abort) throw error; }
      clock++;
      return runMongoTransaction(work);
    } });
  await assert.rejects(service.openMarketOrder({ accountId: a.id, clientOrderId: 'retry-boundary', symbol: 'EURUSD', side: 'BUY', volume: '1' }), { code: 'NEWS_TRADING_RESTRICTED' });
  assert.equal(firstAttemptRan, true);
  assert.equal(await Position.countDocuments({ accountId: a.id }), 0);
  assert.equal(await Deal.countDocuments({ accountId: a.id }), 0);
});

test('Mongo: news enforcement gates pending fills, activation, risky edits and reversal while reductions remain available', { skip: !enabled }, async () => {
  const a = await account();
  const config = { newsEnforcementEnabled: false, newsRolloutPercent: 100, shadowEnabled: false };
  const policy = new TradingPermissionPolicyService({ config, logger,
    calendarSnapshots: { read: () => ({ dataStatus: 'FRESH', snapshotVersion: 'paths-v1', events: [{ id: 'paths-cpi', timestamp: new Date().toISOString(), title: 'US CPI', currency: 'USD' }] }) } });
  const options = { quoteStore, logger, eventBus: new EventEmitter(), tradingPermissionPolicyService: policy };
  const market = new MarketOrderService(options), pending = new PendingOrderService(options), amend = new PendingOrderAmendService(options), reverse = new AtomicReverseService(options);
  const opened = await market.openMarketOrder({ accountId: a.id, clientOrderId: 'paths-open', symbol: 'EURUSD', side: 'BUY', volume: '1' });
  const placed = await pending.placePendingOrder({ accountId: a.id, clientOrderId: 'paths-limit', symbol: 'EURUSD', side: 'BUY', type: 'LIMIT', volume: '1', limitPrice: '1.09' });
  const stop = await pending.placePendingOrder({ accountId: a.id, clientOrderId: 'paths-stop', symbol: 'EURUSD', side: 'BUY', type: 'STOP_LIMIT', volume: '1', stopPrice: '1.11', limitPrice: '1.112' });
  config.newsEnforcementEnabled = true;
  assert.equal((await pending.executePendingOrder({ accountId: a.id, orderId: placed.order.id, tick: { ...quoteStore.get(), bid: 1.079, ask: 1.08 } })).skipped, true);
  assert.equal((await pending.activateStopLimit({ accountId: a.id, orderId: stop.order.id, tick: { ...quoteStore.get(), bid: 1.111, ask: 1.1112 } })).skipped, true);
  await amend.amend({ accountId: a.id, orderId: placed.order.id, clientRequestId: 'paths-reduce', volume: '0.5' });
  await assert.rejects(amend.amend({ accountId: a.id, orderId: placed.order.id, clientRequestId: 'paths-increase', volume: '1' }), { code: 'NEWS_TRADING_RESTRICTED' });
  await assert.rejects(reverse.reversePosition({ accountId: a.id, positionId: opened.position.id, clientRequestId: 'paths-reverse' }), { code: 'NEWS_TRADING_RESTRICTED' });
  await market.closeMarketPosition({ accountId: a.id, positionId: opened.position.id, clientOrderId: 'paths-close-half', volume: '0.5' });
  assert.equal(String((await Position.findById(opened.position.id)).openVolume), '0.5');
  assert.equal((await Order.findById(stop.order.id)).status, 'PENDING');
  assert.equal(await Deal.countDocuments({ accountId: a.id }), 2);
});

test('Mongo: pending amendment persists the amended quantity and entry price', { skip: !enabled }, async () => {
  const a = await account();
  const eventBus = new EventEmitter();
  const pending = new PendingOrderService({ quoteStore, logger, eventBus });
  const placed = await pending.placePendingOrder({ accountId: a.id, clientOrderId: 'pending-edit', symbol: 'EURUSD', side: 'BUY', type: 'LIMIT', volume: '1', limitPrice: '1.09' });
  const amend = new PendingOrderAmendService({ quoteStore, logger, eventBus });
  await amend.amend({ accountId: a.id, orderId: placed.order.id, clientRequestId: 'edit-1', volume: '0.5', limitPrice: '1.095' });
  const persisted = await Order.findById(placed.order.id).lean();
  assert.equal(String(persisted.requestedVolume), '0.5');
  assert.equal(String(persisted.limitPrice), '1.095');
});

test('Mongo: calendar refresh lease allows one provider fetch and pointer survives restart', { skip: !enabled }, async () => {
  await NewsCalendarState.deleteMany({}); await NewsCalendarSnapshot.deleteMany({});
  let calls = 0;
  const config = { financeCalendarBaseUrl: 'https://calendar.invalid', newsCalendarHttpTimeoutMs: 1000, newsCalendarCacheTtlMs: 60000, newsCalendarStaleMaxMs: 900000 };
  const options = { config, normalizeEvent: normalizeCalendarEvent, logger, fetchImpl: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return { ok: true, json: async () => [] }; } };
  const instances = Array.from({ length: 4 }, () => new NewsCalendarSnapshotService(options));
  await Promise.all(instances.map(instance => instance.tick()));
  assert.equal(calls, 1);
  assert.equal(await NewsCalendarSnapshot.countDocuments({}), 1);
  const restarted = new NewsCalendarSnapshotService(options);
  await restarted.tick();
  assert.equal(restarted.read().dataStatus, 'FRESH');
  assert.equal(calls, 1);
});

async function weekendFixture() {
  const a = await account();
  const policy = new TradingPermissionPolicyService({ logger,
    controlService: new PolicyControlService(),
    config: { weekendEnforcementEnabled: true, weekendRolloutPercent: 100, newsEnforcementEnabled: false, shadowEnabled: false } });
  const eventBus = new EventEmitter();
  const market = new MarketOrderService({ quoteStore, logger, eventBus, tradingPermissionPolicyService: policy });
  const pending = new PendingOrderService({ quoteStore, logger, eventBus, tradingPermissionPolicyService: policy });
  const opened = await market.openMarketOrder({ accountId: a.id, clientOrderId: 'weekend-open', symbol: 'EURUSD', side: 'BUY', volume: '1' });
  const placed = await pending.placePendingOrder({ accountId: a.id, clientOrderId: 'weekend-pending', symbol: 'EURUSD', side: 'BUY', type: 'LIMIT', volume: '1', limitPrice: '1.09' });
  const options = { policyService: policy, marketOrderService: market, pendingOrderService: pending, logger, concurrency: 1 };
  const worker = new WeekendActionService(options);
  market.weekendActionService = worker; pending.weekendActionService = worker;
  const instrument = await Instrument.findOne({ symbol: 'EURUSD' }).lean();
  const now = Date.now();
  await worker.plan({ account: a, instrument, enforced: true, weekend: {
    autoCloseAt: new Date(now - 1000).toISOString(), requiredFlatAt: new Date(now + 60000).toISOString(),
    marketCloseAt: new Date(now + 300000).toISOString(), reopenAt: new Date(now + 86400000).toISOString(),
  } });
  return { a, policy, market, pending, worker, options, opened, placed };
}

test('Mongo: concurrent weekend workers cancel, flatten once, confirm from DB and block reopening', { skip: !enabled }, async () => {
  const f = await weekendFixture();
  const second = new WeekendActionService(f.options);
  await Promise.all([f.worker.runDue(), second.runDue()]);
  const job = await WeekendAccountAction.findOne({ accountId: f.a.id }).lean();
  assert.equal(job.state, 'CONFIRMED', job.lastError);
  assert.equal(job.attempt, 1);
  assert.equal(job.late, false);
  const openDeal = await Deal.findOne({ accountId: f.a.id, type: 'OPEN' }).lean();
  assert.equal(JSON.parse(openDeal.metadata.executionPolicy).permissionVersion, 1);
  assert.equal(await Position.countDocuments({ accountId: f.a.id, status: 'OPEN' }), 0);
  assert.equal((await Order.findById(f.placed.order.id)).status, 'CANCELLED');
  assert.equal(await Deal.countDocuments({ accountId: f.a.id }), 2);
  const summary = await f.worker.summary(tenantId);
  assert.ok(summary.states.CONFIRMED >= 1);
  assert.equal(summary.attentionRequired, false);
  assert.deepEqual((await f.worker.summary(new mongoose.Types.ObjectId())).states, {});
  const close = await Deal.findOne({ accountId: f.a.id, type: 'CLOSE' }).lean();
  assert.equal(close.metadata.closeReason, 'WEEKEND_HOLDING_POLICY');
  await assert.rejects(f.market.openMarketOrder({ accountId: f.a.id, clientOrderId: 'blocked-reopen', symbol: 'EURUSD', side: 'BUY', volume: '1' }), { code: 'WEEKEND_HOLDING_CUTOFF_ACTIVE' });
});

test('Mongo: a restarted weekend worker resumes after cancellation and transient close failure', { skip: !enabled }, async () => {
  const f = await weekendFixture();
  f.worker.marketOrderService = { closeMarketPosition: async () => { throw new Error('simulated worker interruption'); } };
  await f.worker.runDue();
  let job = await WeekendAccountAction.findOne({ accountId: f.a.id }).lean();
  assert.equal(job.state, 'RETRYING');
  assert.equal((await Order.findById(f.placed.order.id)).status, 'CANCELLED');
  await WeekendAccountAction.updateOne({ _id: job._id }, { $set: { nextAttemptAt: new Date(0) } });
  const restarted = new WeekendActionService(f.options);
  f.market.weekendActionService = restarted; f.pending.weekendActionService = restarted;
  await restarted.runDue();
  job = await WeekendAccountAction.findById(job._id).lean();
  assert.equal(job.state, 'CONFIRMED', job.lastError);
  assert.equal(job.generation, 2);
  assert.equal(await Deal.countDocuments({ accountId: f.a.id }), 2);
});

function spawnWeekendProcess(accountId, pauseAfterClose) {
  const child = fork(path.join(__dirname, '../../scripts/test-fixtures/weekend-worker.cjs'), [], {
    execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env: { ...process.env, ACG_WEEKEND_WORKER_TEST: '1', ACG_WEEKEND_TEST_ACCOUNT: String(accountId),
      ACG_WEEKEND_PAUSE_AFTER_CLOSE: pauseAfterClose ? '1' : '0' },
  });
  const messages = [];
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + String(data)).slice(-6000); });
  child.on('message', message => messages.push(message));
  const exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); });
  return {
    child,
    exited,
    waitFor(event) {
      const existing = messages.find(message => message.event === event);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${event}: ${stderr}`)), 15000);
        const onMessage = message => {
          if (message.event === event) finish(null, message);
          else if (message.event === 'failure') finish(new Error(message.message));
        };
        const onExit = () => finish(new Error(`Worker exited before ${event}: ${stderr}`));
        const onError = error => finish(error);
        function finish(error, value) {
          clearTimeout(timeout);
          child.off('message', onMessage); child.off('exit', onExit); child.off('error', onError);
          error ? reject(error) : resolve(value);
        }
        child.on('message', onMessage); child.once('exit', onExit); child.once('error', onError);
      });
    },
    async terminate() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
  };
}

test('Mongo processes: killing a worker after committed close recovers through lease expiry without duplicate execution', { skip: !enabled, timeout: 30000 }, async () => {
  const f = await weekendFixture();
  const first = spawnWeekendProcess(f.a.id, true);
  let second;
  try {
    await first.waitFor('closeCommitted');
    const interrupted = await WeekendAccountAction.findOne({ accountId: f.a.id }).lean();
    assert.equal(interrupted.state, 'CLOSING');
    assert.equal(interrupted.generation, 1);
    assert.equal(await Position.countDocuments({ accountId: f.a.id, status: 'OPEN' }), 0);
    assert.equal((await Order.findById(f.placed.order.id)).status, 'CANCELLED');
    assert.equal(await Deal.countDocuments({ accountId: f.a.id, type: 'CLOSE' }), 1);
    second = spawnWeekendProcess(f.a.id, false);
    const beforeExpiry = await second.waitFor('firstPoll');
    assert.equal(beforeExpiry.state, 'CLOSING', 'another process must respect an unexpired lease');
    assert.equal(beforeExpiry.generation, 1);
    await first.terminate();
    const recovered = await second.waitFor('confirmed');
    assert.notEqual(recovered.pid, first.child.pid);
    assert.equal(recovered.generation, 2);
    assert.equal((await second.exited).code, 0);
    const job = await WeekendAccountAction.findById(interrupted._id).lean();
    assert.equal(job.state, 'CONFIRMED');
    assert.equal(job.attempt, 2);
    assert.equal(job.late, false);
    assert.equal(await Deal.countDocuments({ accountId: f.a.id }), 2, 'one open and one close across both processes');
    await assert.rejects(f.market.openMarketOrder({ accountId: f.a.id, clientOrderId: 'process-recovery-reopen', symbol: 'EURUSD', side: 'BUY', volume: '1' }), { code: 'WEEKEND_HOLDING_CUTOFF_ACTIVE' });
  } finally {
    await first.terminate();
    await second?.terminate();
  }
});

test('Mongo: stale weekend generation cannot cancel or close in a transaction', { skip: !enabled }, async () => {
  const f = await weekendFixture();
  const job = await WeekendAccountAction.findOneAndUpdate({ accountId: f.a.id },
    { $set: { leaseOwner: 'replacement', generation: 2, leaseUntil: new Date(Date.now() + 30000) } }, { new: true }).lean();
  const stale = { _id: job._id, leaseOwner: 'previous', generation: 1 };
  await assert.rejects(f.pending.cancelPendingOrder({ accountId: f.a.id, orderId: f.placed.order.id, clientRequestId: 'stale-cancel' }, { weekendClaim: stale }), { code: 'WEEKEND_LEASE_LOST' });
  await assert.rejects(f.market.closeMarketPosition({ accountId: f.a.id, positionId: f.opened.position.id, clientOrderId: 'stale-close', volume: null }, { weekendClaim: stale }), { code: 'WEEKEND_LEASE_LOST' });
  assert.equal((await Order.findById(f.placed.order.id)).status, 'PENDING');
  assert.equal((await Position.findById(f.opened.position.id)).status, 'OPEN');
  assert.equal(await Deal.countDocuments({ accountId: f.a.id }), 1);
  await WeekendAccountAction.updateOne({ _id: job._id }, { $set: { leaseUntil: new Date(0) } });
  await f.worker.runDue();
  assert.equal((await WeekendAccountAction.findById(job._id)).state, 'CONFIRMED');
});

test('Mongo: persisted kill control stops the next weekend close across instances and resumes safely', { skip: !enabled }, async () => {
  const f = await weekendFixture();
  const controls = new PolicyControlService();
  const originalCancel = f.pending.cancelPendingOrder.bind(f.pending);
  const initial = await controls.read(tenantId);
  let disabled = false;
  f.pending.cancelPendingOrder = async (...args) => {
    const result = await originalCancel(...args);
    await controls.update({ tenantId, expectedRevision: initial.revision, weekendDisabled: true, actor: 'integration', reason: 'kill between cancellation and close' });
    disabled = true;
    return result;
  };
  try {
    await f.worker.runDue();
    let job = await WeekendAccountAction.findOne({ accountId: f.a.id }).lean();
    assert.equal(job.state, 'RETRYING');
    assert.equal(job.lastError, 'WEEKEND_ENFORCEMENT_DISABLED');
    assert.equal((await Position.findById(f.opened.position.id)).status, 'OPEN');
    assert.equal((await new PolicyControlService().read(tenantId)).weekendDisabled, true);
    assert.equal((await controls.read(new mongoose.Types.ObjectId())).weekendDisabled, false);
    await assert.rejects(controls.update({ tenantId, expectedRevision: initial.revision, weekendDisabled: false, actor: 'stale', reason: 'stale control' }), { code: 'POLICY_CONTROL_CONFLICT' });
    const restored = await controls.update({ tenantId, expectedRevision: initial.revision + 1, weekendDisabled: false, actor: 'integration', reason: 'resume test' });
    disabled = false;
    assert.equal(restored.newsDisabled, initial.newsDisabled);
    assert.equal(await PolicyControlAudit.countDocuments({ tenantId }), restored.revision);
    f.pending.cancelPendingOrder = originalCancel;
    await WeekendAccountAction.updateOne({ _id: job._id }, { $set: { nextAttemptAt: new Date(0) } });
    const restarted = new WeekendActionService(f.options);
    f.market.weekendActionService = restarted; f.pending.weekendActionService = restarted;
    await restarted.runDue();
    job = await WeekendAccountAction.findById(job._id).lean();
    assert.equal(job.state, 'CONFIRMED', job.lastError);
    assert.equal(await Deal.countDocuments({ accountId: f.a.id }), 2);
  } finally {
    if (disabled) {
      const current = await controls.read(tenantId);
      await controls.update({ tenantId, expectedRevision: current.revision, weekendDisabled: false, actor: 'integration', reason: 'test cleanup' });
    }
  }
});

test('Mongo: change streams repair remote positions automatically and sweep recovers a disconnected stream', { skip: !enabled }, async () => {
  const a = await account();
  const eventBus = new EventEmitter();
  const market = new MarketOrderService({ quoteStore, logger, eventBus: new EventEmitter() });
  const engine = new ValuationEngine({ quoteStore, logger, eventBus });
  await engine.start();
  const sync = new AccountStateSynchronizer({ eventBus, valuationEngine: engine, logger, sweepIntervalMs: 60000 });
  await sync.start();
  try {
    const opened = await market.openMarketOrder({ accountId: a.id, clientOrderId: 'remote-watch', symbol: 'EURUSD', side: 'BUY', volume: '1' });
    const expires = Date.now() + 5000;
    while (engine.getAccountSnapshot(a.id)?.positionCount !== 1 && Date.now() < expires) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(engine.getAccountSnapshot(a.id)?.positionCount, 1);
    await Promise.all(sync.streams.map(stream => stream.close()));
    await sync.drain();
    await market.closeMarketPosition({ accountId: a.id, positionId: opened.position.id, clientOrderId: 'remote-close-disconnected', volume: null });
    await sync.sweep();
    assert.equal(engine.getAccountSnapshot(a.id)?.positionCount, 0);
    assert.equal(sync.health().ready, true);
  } finally { await sync.stop(); await engine.stop(); }
});

test('Mongo: a stale stop-loss event cannot close a position after its protection was removed', { skip: !enabled }, async () => {
  const a = await account();
  const market = new MarketOrderService({ quoteStore, logger, eventBus: new EventEmitter() });
  const opened = await market.openMarketOrder({ accountId: a.id, clientOrderId: 'stop-race-open', symbol: 'EURUSD', side: 'BUY', volume: '1' });
  await assert.rejects(market.closeMarketPosition({ accountId: a.id, positionId: opened.position.id, clientOrderId: 'stale-stop', reason: 'STOP_LOSS', source: 'SYSTEM', volume: null }), { code: 'PROTECTION_TRIGGER_NO_LONGER_ACTIVE' });
  assert.equal((await Position.findById(opened.position.id)).status, 'OPEN');
  assert.equal(await Deal.countDocuments({ accountId: a.id }), 1);
});

test('Mongo capacity: 500 active accounts flatten through two workers before the target deadline', { skip: !enabled || process.env.RUN_SCALE_TEST !== '1', timeout: 300000 }, async () => {
  const fixtures = [];
  let next = 0;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (next++ < 500) {
      const f = await weekendFixture();
      for (let i = 2; i <= 3; i++) {
        await f.market.openMarketOrder({ accountId: f.a.id, clientOrderId: `capacity-open-${i}`, symbol: 'EURUSD', side: 'BUY', volume: '1' });
        await f.pending.placePendingOrder({ accountId: f.a.id, clientOrderId: `capacity-pending-${i}`, symbol: 'EURUSD', side: 'BUY', type: 'LIMIT', volume: '1', limitPrice: '1.09' });
      }
      fixtures.push(f);
    }
  }));
  const startedAt = Date.now();
  // Give every job the same five-minute processing budget after seeding completes.
  await WeekendAccountAction.updateMany({ accountId: mongoose.trusted({ $in: fixtures.map(f => f.a._id) }) },
    { $set: { requiredFlatAt: new Date(startedAt + 300000), marketCloseAt: new Date(startedAt + 600000) } });
  const engines = [];
  async function independentWorker() {
    const eventBus = new EventEmitter();
    const valuationEngine = new ValuationEngine({ eventBus, quoteStore, logger });
    await valuationEngine.start(); engines.push(valuationEngine);
    const options = { eventBus, quoteStore, logger, valuationEngine, tradingPermissionPolicyService: fixtures[0].policy };
    const marketOrderService = new MarketOrderService(options), pendingOrderService = new PendingOrderService(options);
    const worker = new WeekendActionService({ policyService: fixtures[0].policy, marketOrderService, pendingOrderService, logger, concurrency: 4 });
    marketOrderService.weekendActionService = worker; pendingOrderService.weekendActionService = worker;
    return worker;
  }
  const first = await independentWorker();
  const second = await independentWorker();
  const ids = fixtures.map(f => f.a._id);
  // Exercise 1,000 simultaneous policy reads, separately from the authenticated socket soak.
  const readStart = Date.now();
  await Promise.all(Array.from({ length: 1000 }, (_, i) => fixtures[i % 500].policy.policyStatus(fixtures[i % 500].a.id, 'EURUSD')));
  const policyBatchMs = Date.now() - readStart;
  let confirmed = 0;
  try {
    while (confirmed < 500 && Date.now() - startedAt < 240000) {
      await Promise.all([first.runDue(), second.runDue()]);
      confirmed = await WeekendAccountAction.countDocuments({ accountId: mongoose.trusted({ $in: ids }), state: 'CONFIRMED' });
      if (confirmed < 500) await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } finally { await Promise.all(engines.map(engine => engine.stop())); }
  const elapsedMs = Date.now() - startedAt;
  assert.equal(confirmed, 500);
  assert.equal(await Position.countDocuments({ accountId: mongoose.trusted({ $in: ids }), status: 'OPEN' }), 0);
  assert.equal(await Order.countDocuments({ accountId: mongoose.trusted({ $in: ids }), status: mongoose.trusted({ $in: ['PENDING', 'TRIGGERED'] }) }), 0);
  assert.equal(await WeekendAccountAction.countDocuments({ accountId: mongoose.trusted({ $in: ids }), late: true }), 0);
  console.log(JSON.stringify({ localCapacity: { accounts: 500, initialPositions: 1500, initialPendingOrders: 1500, workers: 2, independentValuationCaches: true, workerConcurrency: 4, jobsPerWorkerBatch: 32, betweenBatchDelayMs: 1000, policyReaders: 1000, policyBatchMs, elapsedMs, confirmed } }));
});
