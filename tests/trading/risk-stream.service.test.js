'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RiskStreamService } = require('../../src/modules/trading/risk-stream.service');

function sessionQuery(value) {
  return {
    session() { return this; },
    lean: async () => value,
    then(resolve, reject) { return Promise.resolve(value).then(resolve, reject); },
  };
}

function createFixture() {
  const events = [];
  const account = {
    _id: '64b000000000000000000001',
    financialRevision: 7,
    riskSequence: 0,
    lastEvaluatedRiskSequence: 0,
    riskProcessingState: 'RESOLVED',
    riskDayKey: '2026-09-25',
    riskTimezone: 'UTC',
    tradingEnabled: true,
    status: 'ACTIVE',
    state: {
      initialBalance: '100000',
      dailyStartEquity: '100000',
      realizedPnlToday: '0',
    },
    riskPolicy: {
      dailyLoss: { limit: '3000' },
      maxLoss: { limit: '6000' },
    },
    metadata: new Map([['riskPolicyVersion', 'ACG_FUNDED_V1']]),
    async save() { return this; },
  };

  class EventDoc {
    constructor(input) { Object.assign(this, input); this._id = `e-${events.length + 1}`; }
    async save() {
      if (!events.includes(this)) events.push(this);
      return this;
    }
  }
  EventDoc.findOne = filter => {
    const row = events.find(event =>
      String(event.accountId) === String(filter.accountId)
      && (filter.eventKey == null || event.eventKey === filter.eventKey)
      && (filter.sequence == null || Number(event.sequence) === Number(filter.sequence))
    ) || null;
    return sessionQuery(row);
  };
  EventDoc.find = filter => ({
    select() { return this; },
    async lean() {
      return events.filter(event => !filter?.state || event.state === filter.state);
    },
  });

  const accountModel = {
    findById() { return sessionQuery(account); },
  };

  const service = new RiskStreamService({
    accountModel,
    eventModel: EventDoc,
    runTransaction: async work => work({ id: 'fake-session' }),
    now: () => new Date('2026-09-26T12:00:00.000Z'),
  });

  return { service, account, events };
}

test('risk-day rollover and valuation receive consecutive sequences in one transaction boundary', async () => {
  const { service, account, events } = createFixture();

  const result = await service.ingestValuation({
    accountId: String(account._id),
    complete: true,
    valuationStatus: 'LIVE',
    financialRevision: 7,
    balance: '100000',
    equity: '98000',
    floatingPnl: '-2000',
    usedMargin: '1200',
    freeMargin: '96800',
    marginLevel: '8166.6667',
    sequence: 55,
    valuedAtMs: Date.parse('2026-09-26T12:00:00.000Z'),
  });

  assert.equal(result.accepted, true);
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'RISK_DAY_ROLLOVER');
  assert.equal(events[0].sequence, 1);
  assert.equal(events[1].type, 'VALUATION');
  assert.equal(events[1].sequence, 2);
  assert.equal(account.riskSequence, 2);
  assert.equal(account.riskDayKey, '2026-09-26');
  assert.equal(String(account.state.dailyStartEquity), '98000');
  assert.equal(events[1].context.financialRevision, 7);
  assert.equal(events[1].context.policyVersion, 'ACG_FUNDED_V1');
});

test('duplicate valuation is idempotent and does not allocate another sequence', async () => {
  const { service, account, events } = createFixture();
  account.riskDayKey = '2026-09-26';

  const valuation = {
    accountId: String(account._id),
    complete: true,
    valuationStatus: 'LIVE',
    financialRevision: 7,
    balance: '100000',
    equity: '99000',
    floatingPnl: '-1000',
    usedMargin: '1000',
    freeMargin: '98000',
    marginLevel: '9900',
    sequence: 77,
    valuedAtMs: 123456,
  };

  const first = await service.ingestValuation(valuation);
  const second = await service.ingestValuation(valuation);

  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(second.duplicate, true);
  assert.equal(events.length, 1);
  assert.equal(account.riskSequence, 1);
});

test('valuation calculated from an older financial revision is rejected before risk sequencing', async () => {
  const { service, account, events } = createFixture();
  account.riskDayKey = '2026-09-26';

  const result = await service.ingestValuation({
    accountId: String(account._id),
    complete: true,
    valuationStatus: 'LIVE',
    financialRevision: 6,
    equity: '93000',
    sequence: 99,
    valuedAtMs: 999,
  });

  assert.equal(result.accepted, false);
  assert.equal(result.stale, true);
  assert.equal(result.code, 'STALE_VALUATION_REVISION');
  assert.equal(events.length, 0);
  assert.equal(account.riskSequence, 0);
});

test('missing durable sequence marks account RISK_UNRESOLVED instead of skipping ahead', async () => {
  const { service, account } = createFixture();
  account.riskDayKey = '2026-09-26';
  account.riskSequence = 3;
  account.lastEvaluatedRiskSequence = 1;

  const next = await service.getNext(String(account._id));

  assert.equal(next.gap, true);
  assert.equal(next.expectedSequence, 2);
  assert.equal(account.riskProcessingState, 'RISK_UNRESOLVED');
  assert.equal(account.riskUnresolvedReason, 'RISK_SEQUENCE_GAP');
});
