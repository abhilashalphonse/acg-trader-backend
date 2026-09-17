'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ChallengeRiskEngine, riskDayKey } = require('../../src/modules/trading/challenge-risk-engine');

function account(overrides = {}) {
  const base = {
    _id: '507f1f77bcf86cd799439011',
    tenantId: '507f191e810c19729de860ea',
    accountCode: 'ACG1001',
    accountType: 'CHALLENGE',
    currency: 'USD',
    leverage: 100,
    status: 'ACTIVE',
    tradingEnabled: true,
    riskDayKey: '2026-09-17',
    riskTimezone: 'UTC',
    state: { initialBalance: '100000', balance: '100000', equity: '100000', floatingPnl: '0', realizedPnlToday: '0', usedMargin: '0', freeMargin: '100000', dailyStartEquity: '100000' },
    riskPolicy: {
      dailyLoss: { limit: '5000', reference: 'DAILY_START_EQUITY' },
      maxLoss: { limit: '10000', reference: 'INITIAL_BALANCE' },
      profitTarget: '8000', breachAction: 'LOCK_ONLY', maxOpenPositions: null, maxTotalVolume: null, allowedSymbols: [],
    },
    metadata: new Map([['challengeId', 'challenge-1'], ['fundedAccountId', 'funded-1']]),
    async save() { return this; },
  };
  return Object.assign(base, overrides);
}

function valuation(overrides = {}) {
  return { accountId: '507f1f77bcf86cd799439011', balance: '100000', equity: '100000', floatingPnl: '0', usedMargin: '0', freeMargin: '100000', marginLevel: null, positionCount: 0, valuationStatus: 'LIVE', complete: true, staleSymbols: [], sequence: 10, valuedAtMs: 1000, ...overrides };
}

function harness({ accountDoc = account(), snapshot = valuation() } = {}) {
  const events = new EventEmitter();
  const decisions = [];
  const controls = { breaches: [], pauses: [] };
  const accountModel = {
    async findById() { return accountDoc; },
  };
  const decisionModel = {
    findOne(query) { return { lean: async () => decisions.find(item => item.accountId === String(query.accountId) && (query.type?.$in || []).includes(item.type)) || null }; },
    async create(input) { const item = { decisionId: `d-${decisions.length + 1}`, ...input }; decisions.push({ ...item, accountId: String(input.accountId) }); return item; },
  };
  const commandQueue = { async run(_key, work) { return work(); } };
  const accountControlService = {
    async breach(id, options) { controls.breaches.push({ id, options }); accountDoc.status = 'BREACHED'; accountDoc.tradingEnabled = false; return { account: accountDoc }; },
    async pause(id, options) { controls.pauses.push({ id, options }); accountDoc.status = 'PAUSED'; accountDoc.tradingEnabled = false; return { account: accountDoc }; },
  };
  const valuationEngine = { async getOrLoadAccountSnapshot() { return snapshot; } };
  const positionModel = { find() { return { select() { return { lean: async () => [] }; } }; } };
  const engine = new ChallengeRiskEngine({ eventBus: events, valuationEngine, accountControlService, commandQueue, accountModel, positionModel, decisionModel, now: () => new Date('2026-09-17T12:00:00Z') });
  return { engine, decisions, controls, accountDoc, events };
}

test('daily loss breach is decided from live complete equity and locks the account', async () => {
  const h = harness({ snapshot: valuation({ equity: '95000' }) });
  const result = await h.engine.evaluateAccount(h.accountDoc._id, valuation({ equity: '95000' }));
  assert.equal(result.status, 'BREACHED');
  assert.equal(result.rule, 'DAILY_LOSS');
  assert.equal(h.controls.breaches.length, 1);
  assert.equal(h.decisions[0].type, 'BREACH');
  assert.equal(h.decisions[0].referenceValue, '95000');
});

test('profit target requires both balance and live equity to satisfy target', async () => {
  const h = harness();
  await h.engine.evaluateAccount(h.accountDoc._id, valuation({ balance: '108500', equity: '107500' }));
  assert.equal(h.controls.pauses.length, 0);
  assert.equal(h.decisions.length, 0);
  const result = await h.engine.evaluateAccount(h.accountDoc._id, valuation({ balance: '108500', equity: '108200' }));
  assert.equal(result.status, 'PASSED');
  assert.equal(h.controls.pauses.length, 1);
  assert.equal(h.accountDoc.metadata.get('challengeStatus'), 'PASSED');
});

test('stale or incomplete valuations never produce pass or breach decisions', async () => {
  const h = harness();
  assert.equal(await h.engine.evaluateAccount(h.accountDoc._id, valuation({ equity: '90000', valuationStatus: 'STALE' })), null);
  assert.equal(await h.engine.evaluateAccount(h.accountDoc._id, valuation({ equity: '90000', complete: false })), null);
  assert.equal(h.decisions.length, 0);
  assert.equal(h.controls.breaches.length, 0);
});

test('new risk day resets daily baseline before evaluating daily loss', async () => {
  const doc = account({ riskDayKey: '2026-09-16', state: { ...account().state, dailyStartEquity: '110000', realizedPnlToday: '2500' } });
  const h = harness({ accountDoc: doc, snapshot: valuation({ equity: '100000' }) });
  const result = await h.engine.evaluateAccount(doc._id, valuation({ equity: '100000' }));
  assert.equal(result, null);
  assert.equal(doc.riskDayKey, '2026-09-17');
  assert.equal(String(doc.state.dailyStartEquity), '100000');
  assert.equal(String(doc.state.realizedPnlToday), '0');
  assert.equal(h.decisions[0].type, 'DAILY_RESET');
});

test('riskDayKey respects account timezone calendar date', () => {
  assert.equal(riskDayKey(new Date('2026-09-17T23:30:00Z'), 'Europe/Lisbon'), '2026-09-18');
});
