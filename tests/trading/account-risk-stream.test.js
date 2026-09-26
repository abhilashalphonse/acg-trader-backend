'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { AccountRiskStreamService } = require('../../src/modules/trading/account-risk-stream.service');
const { validateAccountForOpen } = require('../../src/modules/trading/execution-planner');

function makeQuery(resolver) {
  let sortSpec = null;
  return {
    session: async () => resolver(sortSpec),
    lean: async () => plain(resolver(sortSpec)),
    select() { return this; },
    sort(spec) { sortSpec = spec; return this; },
  };
}

function plain(value) {
  if (Array.isArray(value)) return value.map(item => plain(item));
  if (!value || typeof value !== 'object') return value;
  if (typeof value.toObject === 'function') return value.toObject();
  return JSON.parse(JSON.stringify(value));
}

function createFixture(overrides = {}) {
  const events = [];
  let eventId = 0;
  const account = {
    _id: '64b000000000000000000001',
    tenantId: '64b0000000000000000000aa',
    __v: 7,
    status: 'ACTIVE',
    tradingEnabled: true,
    financialRevision: 3,
    riskSequence: 0,
    riskProcessedSequence: 0,
    riskProcessingState: 'READY',
    riskExpectedSequence: null,
    riskNextAvailableSequence: null,
    riskDayKey: '2026-09-18',
    riskTimezone: 'UTC',
    state: {
      initialBalance: '100000',
      balance: '100000',
      equity: '100000',
      floatingPnl: '0',
      realizedPnlToday: '0',
      usedMargin: '0',
      freeMargin: '100000',
      dailyStartEquity: '100000',
    },
    riskPolicy: {
      dailyLoss: { limit: '3000', reference: 'DAILY_START_EQUITY' },
      maxLoss: { limit: '6000', reference: 'INITIAL_BALANCE' },
    },
    metadata: new Map([['riskPolicyVersion', 'ACG_FUNDED_V1']]),
    async save() { return this; },
    ...overrides,
  };

  class RiskEvent {
    constructor(input) {
      Object.assign(this, input);
      this._id = `event-${++eventId}`;
      this.processedAt = input.processedAt || null;
      this.processingResult = input.processingResult || null;
    }
    async save() {
      if (!events.includes(this)) events.push(this);
      return this;
    }
    toObject() {
      return { ...this, save: undefined };
    }
    static findOne(filter) {
      return makeQuery(sortSpec => {
        let rows = events.filter(event => String(event.accountId) === String(filter.accountId));
        if (filter.sourceEventId !== undefined) rows = rows.filter(event => event.sourceEventId === filter.sourceEventId);
        if (filter.sequence !== undefined) {
          if (typeof filter.sequence === 'object' && filter.sequence !== null && '$gt' in filter.sequence) {
            rows = rows.filter(event => Number(event.sequence) > Number(filter.sequence.$gt));
          } else {
            rows = rows.filter(event => Number(event.sequence) === Number(filter.sequence));
          }
        }
        if (sortSpec?.sequence) rows.sort((a, b) => sortSpec.sequence > 0 ? a.sequence - b.sequence : b.sequence - a.sequence);
        return rows[0] || null;
      });
    }
  }

  const accountModel = {
    findById(id) {
      return makeQuery(() => String(id) === String(account._id) ? account : null);
    },
    find() {
      return makeQuery(() => [account]);
    },
  };

  const runCalls = [];
  const runTransaction = async work => {
    runCalls.push('transaction');
    return work({ id: `session-${runCalls.length}` });
  };

  const eventBus = new EventEmitter();
  const service = new AccountRiskStreamService({
    eventBus,
    accountModel,
    eventModel: RiskEvent,
    runTransaction,
    now: () => new Date('2026-09-18T12:00:00.000Z'),
  });

  return { account, events, eventBus, service, runCalls, RiskEvent };
}

function valuation(overrides = {}) {
  return {
    eventId: 'valuation-1',
    accountId: '64b000000000000000000001',
    financialRevision: 3,
    complete: true,
    valuationStatus: 'LIVE',
    sequence: 88,
    valuedAtMs: Date.parse('2026-09-18T12:00:00.123Z'),
    balance: '100000',
    floatingPnl: '-1000',
    equity: '99000',
    usedMargin: '1100',
    freeMargin: '97900',
    marginLevel: '9000',
    ...overrides,
  };
}

test('valuation acceptance allocates risk sequence and event in one transaction', async () => {
  const { account, events, service, runCalls } = createFixture();

  const result = await service.ingestValuation(valuation());

  assert.equal(result.accepted, true);
  assert.equal(result.duplicate, false);
  assert.equal(runCalls.length, 1);
  assert.equal(account.riskSequence, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].sequence, 1);
  assert.equal(events[0].eventType, 'VALUATION');
  assert.equal(events[0].financialRevision, 3);
  assert.equal(events[0].policyVersion, 'ACG_FUNDED_V1');
  assert.equal(events[0].context.dailyStartEquity, '100000');
  assert.equal(events[0].context.valuation.equity, '99000');
});

test('risk-day rollover and triggering valuation share the same ordered transaction', async () => {
  const { account, events, service, runCalls } = createFixture({
    riskDayKey: '2026-09-17',
    state: {
      initialBalance: '100000',
      balance: '99500',
      equity: '99500',
      floatingPnl: '0',
      realizedPnlToday: '-500',
      usedMargin: '0',
      freeMargin: '99500',
      dailyStartEquity: '100000',
    },
  });

  await service.ingestValuation(valuation({
    valuedAtMs: Date.parse('2026-09-18T00:00:01.000Z'),
    balance: '98750',
    floatingPnl: '0',
    equity: '98750',
    usedMargin: '0',
    freeMargin: '98750',
  }));

  assert.equal(runCalls.length, 1);
  assert.equal(account.riskDayKey, '2026-09-18');
  assert.equal(String(account.state.dailyStartEquity), '98750');
  assert.equal(String(account.state.realizedPnlToday), '0');
  assert.equal(account.riskSequence, 2);
  assert.deepEqual(events.map(event => [event.sequence, event.eventType]), [
    [1, 'RISK_DAY_ROLLOVER'],
    [2, 'VALUATION'],
  ]);
  assert.equal(events[1].context.riskDayKey, '2026-09-18');
  assert.equal(events[1].context.dailyStartEquity, '98750');
});

test('duplicate valuation delivery is idempotent and does not allocate another sequence', async () => {
  const { account, events, service } = createFixture();
  const input = valuation();

  await service.ingestValuation(input);
  const replay = await service.ingestValuation(input);

  assert.equal(replay.duplicate, true);
  assert.equal(account.riskSequence, 1);
  assert.equal(events.length, 1);
});

test('valuation from an older financial revision is rejected before risk acceptance', async () => {
  const { account, events, service } = createFixture({ financialRevision: 4 });

  await assert.rejects(
    () => service.ingestValuation(valuation({ financialRevision: 3 })),
    error => error.code === 'STALE_VALUATION_REVISION'
      && error.details.expectedFinancialRevision === 3
      && error.details.currentFinancialRevision === 4,
  );

  assert.equal(account.riskSequence, 0);
  assert.equal(events.length, 0);
});

test('historical risk sequence gaps persist RISK_UNRESOLVED and block new exposure', async () => {
  const { account, events, service, RiskEvent } = createFixture({
    riskSequence: 2,
    riskProcessedSequence: 0,
  });
  events.push(new RiskEvent({
    tenantId: account.tenantId,
    accountId: account._id,
    sequence: 2,
    eventType: 'VALUATION',
    sourceEventId: 'valuation-2',
    financialRevision: 3,
    accountRevision: 7,
    policyVersion: 'ACG_FUNDED_V1',
    riskDayKey: account.riskDayKey,
    riskTimezone: 'UTC',
    effectiveAt: new Date(),
    context: {},
    processingState: 'PENDING',
  }));

  const next = await service.nextForProcessing(account._id);
  assert.equal(next.state, 'GAP');
  assert.equal(next.expected, 1);
  assert.equal(next.nextAvailable, 2);

  await service.markUnresolved(account._id, {
    expectedSequence: next.expected,
    nextAvailableSequence: next.nextAvailable,
  });

  assert.equal(account.riskProcessingState, 'RISK_UNRESOLVED');
  assert.equal(account.riskExpectedSequence, 1);
  assert.equal(account.riskNextAvailableSequence, 2);

  assert.throws(
    () => validateAccountForOpen({
      ...account,
      riskPolicy: { allowedSymbols: [] },
    }, 'EURUSD'),
    error => error.code === 'RISK_STATE_UNRESOLVED',
  );
});

test('policy transition consumes the same account risk sequence', async () => {
  const { account, events, service } = createFixture();

  const event = await service.appendPolicyTransitionInSession({
    account,
    before: { riskPolicyVersion: 'ACG_FUNDED_V1' },
    after: { riskPolicyVersion: 'ACG_FUNDED_V2' },
    session: { id: 'session' },
    effectiveAt: new Date('2026-09-18T12:00:00Z'),
  });

  assert.equal(account.riskSequence, 1);
  assert.equal(event.sequence, 1);
  assert.equal(events[0].eventType, 'POLICY_TRANSITION');
  assert.equal(events[0].context.before.riskPolicyVersion, 'ACG_FUNDED_V1');
  assert.equal(events[0].context.after.riskPolicyVersion, 'ACG_FUNDED_V2');
});
