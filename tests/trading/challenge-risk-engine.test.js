'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { ChallengeRiskEngine, evaluateRiskContext } = require('../../src/modules/trading/challenge-risk-engine');

function context(overrides = {}) {
  return {
    financialRevision: 4,
    policyVersion: 'ACG_FUNDED_V1',
    riskDayKey: '2026-09-26',
    riskTimezone: 'UTC',
    initialBalance: '100000',
    dailyStartEquity: '100000',
    dailyLossLimit: '3000',
    maxLossLimit: '6000',
    balance: '100000',
    equity: '100000',
    floatingPnl: '0',
    usedMargin: '0',
    freeMargin: '100000',
    marginLevel: null,
    valuationSequence: 10,
    valuedAtMs: 1234,
    ...overrides,
  };
}

test('durable risk context crossing max loss produces terminal breach evidence', () => {
  const result = evaluateRiskContext(context({ equity: '94000', floatingPnl: '-6000' }));
  assert.equal(result.breached, true);
  assert.equal(result.reason, 'MAX_LOSS_LIMIT_REACHED');
  assert.deepEqual(result.evidence.triggeredRules, ['DAILY_DRAWDOWN', 'MAX_DRAWDOWN']);
  assert.equal(result.evidence.thresholdEquity, '94000');
  assert.equal(result.evidence.financialRevision, 4);
  assert.equal(result.evidence.policyVersion, 'ACG_FUNDED_V1');
});

test('brief daily breach remains a breach even if a later valuation recovers', () => {
  const breached = evaluateRiskContext(context({ equity: '96999.50', valuationSequence: 11 }));
  const recovered = evaluateRiskContext(context({ equity: '99000', valuationSequence: 12 }));
  assert.equal(breached.breached, true);
  assert.equal(breached.reason, 'DAILY_LOSS_LIMIT_REACHED');
  assert.equal(recovered.breached, false);
});

test('engine ingests valuation durably before evaluating and completes the exact sequence', async () => {
  const eventBus = new EventEmitter();
  const calls = [];
  const queued = [];
  let sequence = 0;

  const riskStreamService = {
    async pendingAccountIds() { return []; },
    async ingestValuation(valuation) {
      calls.push('ingest');
      queued.push({
        sequence: ++sequence,
        type: 'VALUATION',
        state: 'RECEIVED',
        context: context({
          equity: valuation.equity,
          valuationSequence: valuation.sequence,
          valuedAtMs: valuation.valuedAtMs,
        }),
      });
      return { accepted: true, accountId: valuation.accountId };
    },
    async getNext() {
      const event = queued.shift() || null;
      return event
        ? { account: { status: 'ACTIVE', tradingEnabled: true }, event }
        : { account: { status: 'ACTIVE', tradingEnabled: true }, event: null };
    },
    async complete(_accountId, completedSequence, options) {
      calls.push(`complete:${completedSequence}:${options.state}`);
    },
  };

  const breaches = [];
  const engine = new ChallengeRiskEngine({
    eventBus,
    riskStreamService,
    accountControlService: {
      async breach(accountId, options) {
        calls.push('breach');
        breaches.push({ accountId, options });
      },
    },
  });

  await engine.start();
  eventBus.emit('valuation.account.updated', {
    accountId: 'account-a',
    complete: true,
    valuationStatus: 'LIVE',
    equity: '94000',
    sequence: 44,
    valuedAtMs: 555,
  });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();

  assert.equal(calls[0], 'ingest');
  assert.equal(breaches.length, 1);
  assert.equal(calls.includes('complete:1:BREACHED'), true);
});

test('startup replay drains already durable received events', async () => {
  const eventBus = new EventEmitter();
  let pending = true;
  let completed = false;
  const riskStreamService = {
    async pendingAccountIds() { return ['account-a']; },
    async ingestValuation() { throw new Error('not expected'); },
    async getNext() {
      if (!pending) return { account: { status: 'ACTIVE', tradingEnabled: true }, event: null };
      pending = false;
      return {
        account: { status: 'ACTIVE', tradingEnabled: true },
        event: { sequence: 1, type: 'VALUATION', state: 'RECEIVED', context: context({ equity: '99000' }) },
      };
    },
    async complete() { completed = true; },
  };
  const engine = new ChallengeRiskEngine({
    eventBus,
    riskStreamService,
    accountControlService: { async breach() { throw new Error('not expected'); } },
  });

  await engine.start();
  await new Promise(resolve => setImmediate(resolve));
  await engine.stop();

  assert.equal(completed, true);
});
