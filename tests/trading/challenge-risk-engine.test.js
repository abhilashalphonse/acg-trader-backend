'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const {
  ChallengeRiskEngine,
  evaluateRiskEvent,
} = require('../../src/modules/trading/challenge-risk-engine');
const { APPENDED_EVENT } = require('../../src/modules/trading/account-risk-stream.service');

function riskEvent(sequence, equity, overrides = {}) {
  return {
    id: `event-${sequence}`,
    accountId: '64b000000000000000000001',
    sequence,
    eventType: 'VALUATION',
    financialRevision: 9,
    policyVersion: 'ACG_FUNDED_V1',
    riskDayKey: '2026-09-18',
    riskTimezone: 'UTC',
    context: {
      accountStatus: 'ACTIVE',
      tradingEnabled: true,
      financialRevision: 9,
      policyVersion: 'ACG_FUNDED_V1',
      riskDayKey: '2026-09-18',
      riskTimezone: 'UTC',
      initialBalance: '100000',
      dailyStartEquity: '100000',
      dailyLossLimit: '3000',
      maxLossLimit: '6000',
      valuation: {
        sourceSequence: 80 + sequence,
        valuedAtMs: Date.parse(`2026-09-18T12:00:0${sequence}.000Z`),
        balance: '100000',
        floatingPnl: String(Number(equity) - 100000),
        equity: String(equity),
        usedMargin: '1000',
        freeMargin: String(Number(equity) - 1000),
        marginLevel: String(Number(equity) / 10),
      },
      ...overrides.context,
    },
    ...overrides,
  };
}

function fakeStream(events = [], { pendingOnStart = false, gap = null } = {}) {
  const rows = [...events];
  const processed = [];
  const unresolved = [];
  return {
    processed,
    unresolved,
    async pendingAccountIds() {
      return pendingOnStart && rows.length ? [String(rows[0].accountId)] : [];
    },
    async nextForProcessing(accountId) {
      if (gap) {
        return {
          state: 'GAP',
          expected: gap.expected,
          nextAvailable: gap.nextAvailable,
          highest: gap.highest,
        };
      }
      const next = rows[processed.length];
      if (!next) return { state: 'EMPTY' };
      assert.equal(String(next.accountId), String(accountId));
      return {
        state: 'EVENT',
        event: next,
        expected: next.sequence,
        highest: rows.at(-1).sequence,
      };
    },
    async markProcessed(accountId, sequence, options) {
      processed.push({ accountId: String(accountId), sequence, ...options });
      return { state: 'PROCESSED' };
    },
    async markUnresolved(accountId, options) {
      unresolved.push({ accountId: String(accountId), ...options });
      return {};
    },
  };
}

test('durable valuation evaluation captures exact breach evidence and ordering context', () => {
  const result = evaluateRiskEvent(riskEvent(12, '94000'));

  assert.equal(result.breached, true);
  assert.equal(result.reason, 'MAX_LOSS_LIMIT_REACHED');
  assert.equal(result.evidence.rule, 'MAX_DRAWDOWN');
  assert.deepEqual(result.evidence.triggeredRules, ['DAILY_DRAWDOWN', 'MAX_DRAWDOWN']);
  assert.equal(result.evidence.equity, '94000');
  assert.equal(result.evidence.thresholdEquity, '94000');
  assert.equal(result.evidence.actualLoss, '6000');
  assert.equal(result.evidence.breachAmount, '0');
  assert.equal(result.evidence.riskSequence, 12);
  assert.equal(result.evidence.financialRevision, 9);
  assert.equal(result.evidence.riskPolicyVersion, 'ACG_FUNDED_V1');
  assert.equal(result.evidence.valuationSequence, 92);
});

test('brief breach followed by recovery is still processed as an irreversible breach', async () => {
  const eventBus = new EventEmitter();
  const events = [
    riskEvent(1, '93990'),
    riskEvent(2, '98000'),
  ];
  const stream = fakeStream(events);
  const breaches = [];
  const engine = new ChallengeRiskEngine({
    eventBus,
    riskStreamService: stream,
    accountControlService: {
      async breach(accountId, options) {
        breaches.push({ accountId: String(accountId), options });
      },
    },
  });

  await engine.start();
  eventBus.emit(APPENDED_EVENT, events[0]);
  eventBus.emit(APPENDED_EVENT, events[1]);
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();

  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].options.reason, 'MAX_LOSS_LIMIT_REACHED');
  assert.equal(breaches[0].options.evidence.equity, '93990');
  assert.deepEqual(stream.processed.map(item => [item.sequence, item.processingState]), [
    [1, 'BREACH'],
    [2, 'PROCESSED'],
  ]);
});

test('startup replay drains durable pending risk events without a new market event', async () => {
  const eventBus = new EventEmitter();
  const events = [riskEvent(1, '99000')];
  const stream = fakeStream(events, { pendingOnStart: true });
  const engine = new ChallengeRiskEngine({
    eventBus,
    riskStreamService: stream,
    accountControlService: { async breach() { throw new Error('not expected'); } },
  });

  await engine.start();
  await engine.stop();

  assert.deepEqual(stream.processed.map(item => item.sequence), [1]);
});

test('sequence gap is persisted as unresolved and later valuations are not used to heal it', async () => {
  const eventBus = new EventEmitter();
  const stream = fakeStream([], {
    pendingOnStart: false,
    gap: { expected: 104, nextAvailable: 105, highest: 105 },
  });
  const engine = new ChallengeRiskEngine({
    eventBus,
    riskStreamService: stream,
    accountControlService: { async breach() { throw new Error('not expected'); } },
  });

  await engine.start();
  eventBus.emit(APPENDED_EVENT, {
    accountId: '64b000000000000000000001',
    sequence: 105,
  });
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();

  assert.equal(stream.processed.length, 0);
  assert.equal(stream.unresolved.length, 1);
  assert.deepEqual(stream.unresolved[0], {
    accountId: '64b000000000000000000001',
    expectedSequence: 104,
    nextAvailableSequence: 105,
    reason: 'RISK_SEQUENCE_GAP',
  });
});
