'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { RiskDayEngine, dayKeyInTimezone } = require('../../src/modules/trading/risk-day-engine');

function document() {
  return {
    _id: '64b000000000000000000001',
    riskDayKey: '2026-09-17',
    state: { dailyStartEquity: '100000', realizedPnlToday: '-500' },
    async save() { this.saved = true; },
    toObject() {
      return {
        _id: this._id,
        accountCode: 'ACG-TEST',
        accountType: 'CHALLENGE',
        currency: 'USD',
        leverage: 100,
        status: 'ACTIVE',
        tradingEnabled: true,
        riskDayKey: this.riskDayKey,
        riskTimezone: 'UTC',
        state: {
          initialBalance: '100000',
          balance: '99500',
          equity: this.state.dailyStartEquity,
          floatingPnl: '0',
          realizedPnlToday: this.state.realizedPnlToday,
          usedMargin: '0',
          freeMargin: '99500',
          dailyStartEquity: this.state.dailyStartEquity,
        },
        riskPolicy: {},
        metadata: {},
      };
    },
  };
}

test('first live valuation of a new UTC day resets daily risk baseline', async () => {
  const eventBus = new EventEmitter();
  const doc = document();
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
    equity: '98750',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.riskDayKey, '2026-09-18');
  assert.equal(String(doc.state.dailyStartEquity), '98750');
  assert.equal(String(doc.state.realizedPnlToday), '0');
  assert.equal(doc.saved, true);
  engine.stop();
});

test('stale valuation cannot reset the risk day', async () => {
  const eventBus = new EventEmitter();
  const doc = document();
  const engine = new RiskDayEngine({
    eventBus,
    accountModel: { findById: async () => doc },
    now: () => new Date('2026-09-18T00:00:01Z'),
  });
  engine.start();
  eventBus.emit('valuation.account.updated', {
    accountId: doc._id,
    complete: true,
    valuationStatus: 'STALE',
    equity: '98750',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.riskDayKey, '2026-09-17');
  engine.stop();
});


test('risk day key follows the configured account timezone', () => {
  assert.equal(
    dayKeyInTimezone(new Date('2026-09-18T23:30:00.000Z'), 'Europe/Lisbon'),
    '2026-09-19',
  );
});
