'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');

const {
  validateChallengeRiskForOpen,
  validateAccountForOpen,
} = require('../../src/modules/trading/execution-planner');
const {
  assertProvisionReplay,
  buildInitialState,
} = require('../../src/modules/trading/account-control.service');
const { RiskDayEngine } = require('../../src/modules/trading/risk-day-engine');

function account(overrides = {}) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    status: 'ACTIVE',
    tradingEnabled: true,
    riskDayKey: today,
    state: {
      initialBalance: '100000',
      balance: '100000',
      equity: '100000',
      dailyStartEquity: '100000',
      realizedPnlToday: '0',
      freeMargin: '100000',
      ...overrides.state,
    },
    riskPolicy: {
      dailyLoss: { limit: '3000', reference: 'DAILY_START_EQUITY' },
      maxLoss: { limit: '6000', reference: 'INITIAL_BALANCE' },
      profitTarget: '10000',
      allowedSymbols: [],
      ...overrides.riskPolicy,
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['state', 'riskPolicy'].includes(key))),
  };
}

test('01 below daily loss limit accepts new exposure', () => {
  assert.doesNotThrow(() => validateChallengeRiskForOpen(
    account({ state: { equity: '97001', balance: '97001' } }),
  ));
});

test('02 crossing daily loss rejects new exposure immediately', () => {
  assert.throws(
    () => validateChallengeRiskForOpen(account({ state: { equity: '97000', balance: '97000' } })),
    error => error.code === 'DAILY_LOSS_LIMIT_REACHED',
  );
});

test('03 crossing maximum loss rejects new exposure immediately', () => {
  assert.throws(
    () => validateChallengeRiskForOpen(account({
      state: { dailyStartEquity: '95000', equity: '94000', balance: '94000' },
    })),
    error => error.code === 'MAX_LOSS_LIMIT_REACHED',
  );
});

test('04 profit target before Funded minimum-days completion does not strand the trader', () => {
  assert.doesNotThrow(
    () => validateChallengeRiskForOpen(account({ state: { balance: '110000', equity: '110000' } })),
  );
});

test('05 Phase 1 account disabled by Funded cannot open new exposure', () => {
  assert.throws(
    () => validateAccountForOpen(account({ status: 'DISABLED', tradingEnabled: false }), 'EURUSD'),
    error => error.code === 'ACCOUNT_NOT_ACTIVE',
  );
});

test('06 newly provisioned Phase 2 state starts clean', () => {
  const state = buildInitialState('100000');
  assert.equal(state.initialBalance, '100000');
  assert.equal(state.balance, '100000');
  assert.equal(state.equity, '100000');
  assert.equal(state.floatingPnl, '0');
  assert.equal(state.realizedPnlToday, '0');
  assert.equal(state.usedMargin, '0');
  assert.equal(state.freeMargin, '100000');
  assert.equal(state.dailyStartEquity, '100000');
});

test('07 funded-review disable prevents further exposure', () => {
  assert.throws(
    () => validateAccountForOpen(account({ status: 'DISABLED', tradingEnabled: false }), 'XAUUSD'),
    error => ['ACCOUNT_NOT_ACTIVE', 'ACCOUNT_TRADING_DISABLED'].includes(error.code),
  );
});

test('08 restart replay accepts identical account provisioning parameters', () => {
  const existing = {
    tenantId: '64b0000000000000000000aa',
    ownerExternalRef: 'user-123',
    userId: null,
    accountType: 'CHALLENGE',
    currency: 'USD',
    leverage: 100,
    accountCode: 'ACG-E2E',
    state: { initialBalance: '100000' },
  };
  const input = {
    tenantId: '64b0000000000000000000aa',
    ownerExternalRef: 'user-123',
    userId: null,
    accountType: 'CHALLENGE',
    currency: 'USD',
    leverage: 100,
    accountCode: 'ACG-E2E',
    initialBalance: '100000',
  };
  assert.equal(assertProvisionReplay(existing, input), existing);
});

test('09 duplicate provisioning with changed parameters is rejected instead of creating divergent state', () => {
  const existing = {
    tenantId: '64b0000000000000000000aa',
    ownerExternalRef: 'user-123',
    userId: null,
    accountType: 'CHALLENGE',
    currency: 'USD',
    leverage: 100,
    accountCode: 'ACG-E2E',
    state: { initialBalance: '100000' },
  };
  assert.throws(
    () => assertProvisionReplay(existing, {
      tenantId: '64b0000000000000000000aa',
      ownerExternalRef: 'user-123',
      userId: null,
      accountType: 'CHALLENGE',
      currency: 'USD',
      leverage: 200,
      accountCode: 'ACG-E2E',
      initialBalance: '100000',
    }),
    error => error.code === 'ACCOUNT_PROVISIONING_CONFLICT',
  );
});

test('10 first LIVE valuation after UTC midnight resets daily baseline', async () => {
  const eventBus = new EventEmitter();
  const doc = {
    _id: '64b000000000000000000001',
    riskDayKey: '2026-09-17',
    state: {
      initialBalance: '100000',
      balance: '99000',
      equity: '99000',
      floatingPnl: '0',
      realizedPnlToday: '-1000',
      usedMargin: '0',
      freeMargin: '99000',
      dailyStartEquity: '100000',
    },
    riskPolicy: {},
    metadata: {},
    accountCode: 'ACG-E2E',
    accountType: 'CHALLENGE',
    currency: 'USD',
    leverage: 100,
    status: 'ACTIVE',
    tradingEnabled: true,
    async save() { this.saved = true; },
    toObject() {
      return {
        _id: this._id,
        riskDayKey: this.riskDayKey,
        state: this.state,
        riskPolicy: this.riskPolicy,
        metadata: this.metadata,
        accountCode: this.accountCode,
        accountType: this.accountType,
        currency: this.currency,
        leverage: this.leverage,
        status: this.status,
        tradingEnabled: this.tradingEnabled,
      };
    },
  };

  const engine = new RiskDayEngine({
    eventBus,
    accountModel: { findById: async () => doc },
    now: () => new Date('2026-09-18T00:00:01Z'),
  });
  engine.start();
  eventBus.emit('valuation.account.updated', {
    accountId: doc._id,
    complete: true,
    valuationStatus: 'LIVE',
    equity: '99000',
  });
  await new Promise(resolve => setImmediate(resolve));
  engine.stop();

  assert.equal(doc.riskDayKey, '2026-09-18');
  assert.equal(String(doc.state.dailyStartEquity), '99000');
  assert.equal(String(doc.state.realizedPnlToday), '0');
  assert.equal(doc.saved, true);
});
