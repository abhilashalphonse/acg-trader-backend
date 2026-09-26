'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const {
  MarginStopOutEngine,
  STOP_OUT_LEVEL_PERCENT,
  shouldTriggerStopOut,
  isRecovered,
  rankStopOutPositions,
  findMinimumStopOutClose,
  projectStopOutClose,
  isProjectedRecovered,
  stopOutClientOrderId,
} = require('../../src/modules/trading/margin-stop-out-engine');

function account(overrides = {}) {
  return {
    _id: '64a000000000000000000001',
    tenantId: '64a000000000000000000099',
    status: 'ACTIVE',
    tradingEnabled: true,
    currency: 'USD',
    leverage: 100,
    financialRevision: 3,
    riskDayKey: '2026-09-26',
    riskTimezone: 'UTC',
    riskPolicy: {
      dailyLoss: { limit: '3000' },
      maxLoss: { limit: '6000' },
      allowedSymbols: [],
    },
    state: {
      initialBalance: '100000',
      balance: '420',
      equity: '420',
      floatingPnl: '0',
      realizedPnlToday: '0',
      usedMargin: '1000',
      freeMargin: '-580',
      marginLevel: '42',
      dailyStartEquity: '100000',
    },
    marginStopOutState: 'NONE',
    marginStopOutEpisodeId: null,
    marginStopOutStartedAt: null,
    marginStopOutRecoveredAt: null,
    metadata: new Map([['riskPolicyVersion', 'ACG_FUNDED_V1']]),
    async save() { return this; },
    ...overrides,
  };
}

function instrument(overrides = {}) {
  return {
    symbol: 'EURUSD',
    status: 'ACTIVE',
    executionEnabled: true,
    quoteCurrency: 'USD',
    pnlCurrency: 'USD',
    tickSize: '0.0001',
    minVolume: '0.05',
    maxVolume: '100',
    volumeStep: '0.05',
    contractSize: '100000',
    defaultLeverage: 100,
    marginRate: null,
    commissionPerLot: '0',
    maxQuoteAgeMs: 5000,
    ...overrides,
  };
}

function quote(overrides = {}) {
  return {
    symbol: 'EURUSD',
    bid: 1.1,
    ask: 1.1002,
    sequence: 10,
    receivedAtMs: 10_000,
    isStale: false,
    ...overrides,
  };
}

function position(overrides = {}) {
  return {
    _id: '64b000000000000000000001',
    positionId: 'position-1',
    accountId: '64a000000000000000000001',
    symbol: 'EURUSD',
    side: 'BUY',
    status: 'OPEN',
    initialVolume: '1',
    openVolume: '1',
    entryPrice: '1.1',
    contractSize: '100000',
    volumeStep: '0.05',
    quoteCurrency: 'USD',
    margin: '1000',
    openedAt: new Date('2026-09-26T10:00:00.000Z'),
    ...overrides,
  };
}

test('50 percent is an inclusive stop-out trigger and recovery is strictly above 50 percent', () => {
  assert.equal(STOP_OUT_LEVEL_PERCENT, '50');
  assert.equal(shouldTriggerStopOut({ complete: true, valuationStatus: 'LIVE', usedMargin: '1000', marginLevel: '50' }), true);
  assert.equal(shouldTriggerStopOut({ complete: true, valuationStatus: 'LIVE', usedMargin: '1000', marginLevel: '50.00000001' }), false);
  assert.equal(shouldTriggerStopOut({ complete: true, valuationStatus: 'LIVE', usedMargin: '0', marginLevel: null }), false);

  assert.equal(isRecovered({ usedMargin: '1000', marginLevel: '50' }), false);
  assert.equal(isRecovered({ usedMargin: '1000', marginLevel: '50.00000001' }), true);
  assert.equal(isRecovered({ usedMargin: '0', marginLevel: null }), true);
  assert.equal(isProjectedRecovered({ usedMargin: '1000', marginLevel: '50' }), false);
});

test('minimum stop-out close rounds upward to the smallest permitted volume that restores margin above 50 percent', () => {
  const selection = findMinimumStopOutClose({
    account: account(),
    position: position(),
    instrument: instrument(),
    quote: quote(),
    nowMs: 10_100,
  });

  assert.equal(selection.volume, '0.2');
  assert.equal(selection.plan.fullClose, false);
  assert.equal(selection.projection.usedMargin, '800');
  assert.equal(selection.projection.marginLevel, '52.5');
  assert.equal(selection.iterations, 4);
});

test('invalid remainder falls back to full close instead of leaving a sub-minimum position', () => {
  const selection = findMinimumStopOutClose({
    account: account({
      state: {
        ...account().state,
        balance: '30',
        equity: '30',
        usedMargin: '250',
        freeMargin: '-220',
        marginLevel: '12',
      },
    }),
    position: position({
      initialVolume: '0.25',
      openVolume: '0.25',
      margin: '250',
    }),
    instrument: instrument({ minVolume: '0.1', volumeStep: '0.05' }),
    quote: quote(),
    nowMs: 10_100,
  });

  assert.equal(selection.volume, '0.25');
  assert.equal(selection.plan.fullClose, true);
  assert.equal(selection.plan.remainingVolume, '0');
});

test('projection includes adverse size-impact fill and closing commission before choosing recovery volume', () => {
  const base = {
    account: account({
      state: {
        ...account().state,
        balance: '500',
        equity: '500',
        usedMargin: '1000',
        freeMargin: '-500',
        marginLevel: '50',
      },
    }),
    position: position(),
    quote: quote(),
    nowMs: 10_100,
  };

  const clean = projectStopOutClose({
    ...base,
    instrument: instrument({ minVolume: '0.1', volumeStep: '0.1' }),
    volume: '0.1',
  });
  const adverse = projectStopOutClose({
    ...base,
    instrument: instrument({
      minVolume: '0.1',
      volumeStep: '0.1',
      commissionPerLot: '10',
      spread: {
        volumeBands: [
          { upTo: '0.05', extraPoints: '0' },
          { upTo: null, extraPoints: '5' },
        ],
      },
    }),
    volume: '0.1',
  });

  assert.equal(clean.projection.equity, '500');
  assert.equal(clean.projection.marginLevel, '55.55555556');
  assert.equal(adverse.plan.fillPrice, '1.0995');
  assert.equal(adverse.plan.commission, '1');
  assert.equal(adverse.projection.equity, '494');
  assert.equal(adverse.projection.marginLevel, '54.88888889');
  assert.equal(Number(adverse.projection.equity) < Number(clean.projection.equity), true);
});

test('position selection is deterministic: largest margin, worst floating PnL, oldest, then positionId', () => {
  const rows = [
    position({ _id: 'p4', positionId: 'D', margin: '800', entryPrice: '1.1010', openedAt: new Date('2026-09-26T08:00:00Z') }),
    position({ _id: 'p3', positionId: 'C', margin: '1000', entryPrice: '1.1010', openedAt: new Date('2026-09-26T11:00:00Z') }),
    position({ _id: 'p2', positionId: 'B', margin: '1000', entryPrice: '1.1010', openedAt: new Date('2026-09-26T09:00:00Z') }),
    position({ _id: 'p1', positionId: 'A', margin: '1000', entryPrice: '1.1005', openedAt: new Date('2026-09-26T07:00:00Z') }),
  ];
  const ranked = rankStopOutPositions({
    positions: rows,
    account: account(),
    quoteStore: { get: () => quote() },
    nowMs: 10_100,
  });

  assert.deepEqual(ranked.map(row => row.positionId), ['B', 'C', 'A', 'D']);
});

test('stop-out liquidation command identity is stable for a durable job step', () => {
  assert.equal(stopOutClientOrderId('episode-abc', 4), 'margin-stop-out:episode-abc:4');
  assert.equal(stopOutClientOrderId('episode-abc', 4), stopOutClientOrderId('episode-abc', 4));
  assert.notEqual(stopOutClientOrderId('episode-abc', 4), stopOutClientOrderId('episode-abc', 5));
});

function query(value) {
  return {
    session() { return this; },
    lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function fakeJobModel(seed = []) {
  const jobs = seed;
  class FakeJob {
    constructor(input) {
      Object.assign(this, input);
      this._id = input._id || `job-doc-${jobs.length + 1}`;
    }
    async save() {
      if (!jobs.includes(this)) jobs.push(this);
      return this;
    }
    static findOne(filter) {
      const row = jobs.find(job => Object.entries(filter).every(([key, value]) => String(job[key]) === String(value))) || null;
      return query(row);
    }
    static findOneAndUpdate(_filter, update) {
      const now = update.$set.lastAttemptAt;
      const row = jobs.find(job => {
        if (job.state === 'PENDING' || job.state === 'RETRY') return new Date(job.nextAttemptAt || 0).getTime() <= now.getTime();
        if (job.state === 'PROCESSING') return job.leaseExpiresAt && new Date(job.leaseExpiresAt).getTime() <= now.getTime();
        return false;
      }) || null;
      if (!row) return Promise.resolve(null);
      Object.assign(row, update.$set);
      row.attempts = Number(row.attempts || 0) + Number(update.$inc?.attempts || 0);
      return Promise.resolve(row);
    }
    static async updateOne(filter, update) {
      const row = jobs.find(job => String(job._id) === String(filter._id));
      if (!row) return { modifiedCount: 0 };
      if (filter.state && row.state !== filter.state) return { modifiedCount: 0 };
      if (filter.step != null && Number(row.step) !== Number(filter.step)) return { modifiedCount: 0 };
      Object.assign(row, update.$set || {});
      if (update.$inc) for (const [key, value] of Object.entries(update.$inc)) row[key] = Number(row[key] || 0) + Number(value);
      if (update.$unset) for (const key of Object.keys(update.$unset)) delete row[key];
      return { modifiedCount: 1 };
    }
  }
  FakeJob.jobs = jobs;
  return FakeJob;
}

test('pending durable stop-out work is reclaimed after restart and uses the same step idempotency key', async () => {
  const a = account({
    marginStopOutState: 'ACTIVE',
    marginStopOutEpisodeId: 'episode-restart',
    state: {
      ...account().state,
      balance: '420',
      equity: '420',
      floatingPnl: '0',
      usedMargin: '1000',
      freeMargin: '-580',
      marginLevel: '42',
    },
  });
  const p = position();
  const Job = fakeJobModel([{
    _id: 'job-restart',
    jobId: 'episode-restart',
    tenantId: a.tenantId,
    accountId: a._id,
    activeKey: String(a._id),
    state: 'PROCESSING',
    step: 1,
    attempts: 1,
    nextAttemptAt: new Date('2026-09-26T09:00:00Z'),
    leaseExpiresAt: new Date('2026-09-26T09:59:00Z'),
  }]);
  const calls = [];

  const accountModel = { findById: () => query(a) };
  const positionModel = {
    find() { return { async lean() { return p.status === 'OPEN' ? [p] : []; } }; },
  };
  const instrumentModel = { findOne: () => ({ async lean() { return instrument(); } }) };
  const eventBus = new EventEmitter();

  const engine = new MarginStopOutEngine({
    eventBus,
    accountModel,
    positionModel,
    instrumentModel,
    jobModel: Job,
    quoteStore: { get: () => quote() },
    valuationEngine: {
      overlayAccountDocument(doc) { return { complete: true, ...doc.state, valuationStatus: 'LIVE' }; },
      scheduleAccountRevalue() {},
    },
    marketOrderService: {
      async closeMarketPosition(command) {
        calls.push(command);
        a.state.usedMargin = '800';
        a.state.equity = '420';
        a.state.freeMargin = '-380';
        a.state.marginLevel = '52.5';
        p.openVolume = '0.8';
        p.margin = '800';
        return {
          deal: { price: '1.1', commission: '0', realizedPnl: '0' },
          account: { state: { marginLevel: '52.5' } },
          idempotentReplay: true,
        };
      },
    },
    accountControlService: { async breach() { throw new Error('challenge breach not expected'); } },
    runTransaction: async work => work({ id: 'tx' }),
    now: () => new Date('2026-09-26T10:00:00Z'),
    batchSize: 1,
  });

  await engine.start();
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].clientOrderId, 'margin-stop-out:episode-restart:1');
  assert.equal(calls[0].reason, 'MARGIN_STOP_OUT');
  assert.equal(Job.jobs[0].state, 'COMPLETED');
  assert.equal(Job.jobs[0].completionReason, 'MARGIN_LEVEL_RECOVERED');
  assert.equal(a.marginStopOutState, 'NONE');
  assert.equal(a.marginStopOutEpisodeId, null);
});

test('a later stop-out episode can start after the previous episode recovered', async () => {
  const a = account();
  const Job = fakeJobModel([]);
  const eventBus = new EventEmitter();
  const accountModel = { findById: () => query(a) };

  const engine = new MarginStopOutEngine({
    eventBus,
    accountModel,
    positionModel: { find: () => ({ async lean() { return []; } }) },
    instrumentModel: { findOne: () => ({ async lean() { return instrument(); } }) },
    jobModel: Job,
    quoteStore: { get: () => quote() },
    valuationEngine: {
      overlayAccountDocument(doc) {
        doc.state.usedMargin = '0';
        doc.state.marginLevel = null;
        return { complete: true, valuationStatus: 'LIVE', ...doc.state };
      },
      scheduleAccountRevalue() {},
    },
    marketOrderService: { async closeMarketPosition() { throw new Error('no close expected'); } },
    accountControlService: { async breach() { throw new Error('no breach expected'); } },
    runTransaction: async work => work({ id: 'tx' }),
    now: () => new Date('2026-09-26T10:00:00Z'),
    batchSize: 2,
  });

  await engine.start();
  const trigger = {
    accountId: String(a._id),
    complete: true,
    valuationStatus: 'LIVE',
    financialRevision: 3,
    balance: '420',
    equity: '420',
    floatingPnl: '0',
    usedMargin: '1000',
    freeMargin: '-580',
    marginLevel: '42',
    sequence: 1,
    valuedAtMs: Date.parse('2026-09-26T10:00:00Z'),
  };
  eventBus.emit('valuation.account.updated', trigger);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));

  const first = Job.jobs[0];
  assert.equal(first.state, 'COMPLETED');
  assert.equal(a.marginStopOutState, 'NONE');

  a.state.usedMargin = '1000';
  a.state.marginLevel = '42';
  a.state.equity = '420';
  a.state.freeMargin = '-580';
  eventBus.emit('valuation.account.updated', { ...trigger, sequence: 2, valuedAtMs: trigger.valuedAtMs + 1000 });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();

  assert.equal(Job.jobs.length, 2);
  assert.notEqual(Job.jobs[0].jobId, Job.jobs[1].jobId);
});

test('simultaneous challenge breach supersedes margin stop-out and does not create a stop-out job', async () => {
  const a = account({
    state: {
      ...account().state,
      initialBalance: '100000',
      dailyStartEquity: '100000',
      balance: '95000',
      equity: '93000',
      floatingPnl: '-2000',
      usedMargin: '200000',
      freeMargin: '-107000',
      marginLevel: '46.5',
    },
  });
  const Job = fakeJobModel([]);
  const eventBus = new EventEmitter();
  const breaches = [];

  const engine = new MarginStopOutEngine({
    eventBus,
    accountModel: { findById: () => query(a) },
    positionModel: { find: () => ({ async lean() { return []; } }) },
    instrumentModel: { findOne: () => ({ async lean() { return instrument(); } }) },
    jobModel: Job,
    quoteStore: { get: () => quote() },
    valuationEngine: { overlayAccountDocument: () => ({ complete: true, valuationStatus: 'LIVE', ...a.state }) },
    marketOrderService: { async closeMarketPosition() { throw new Error('stop-out close must not run'); } },
    accountControlService: { async breach(accountId, options) { breaches.push({ accountId, options }); a.status = 'BREACHED'; a.tradingEnabled = false; } },
    runTransaction: async work => work({ id: 'tx' }),
    now: () => new Date('2026-09-26T10:00:00Z'),
  });

  await engine.start();
  eventBus.emit('valuation.account.updated', {
    accountId: String(a._id),
    complete: true,
    valuationStatus: 'LIVE',
    financialRevision: 3,
    balance: '95000',
    equity: '93000',
    floatingPnl: '-2000',
    usedMargin: '200000',
    freeMargin: '-107000',
    marginLevel: '46.5',
    sequence: 7,
    valuedAtMs: Date.parse('2026-09-26T10:00:00Z'),
  });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();

  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].options.reason, 'MAX_LOSS_LIMIT_REACHED');
  assert.equal(Job.jobs.length, 0);
  assert.equal(a.status, 'BREACHED');
});
