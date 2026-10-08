'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { Order } = require('../../src/modules/trading/order.model');
const { PlatformEventRelay } = require('../../src/modules/integration/platform-event-relay');

test('Mongoose sanitizeFilter accepts a trusted server-constructed active-order filter', () => {
  const filter = {
    status: mongoose.trusted({
      $in: ['RECEIVED', 'VALIDATING', 'ACCEPTED', 'PENDING', 'TRIGGERED', 'PARTIALLY_FILLED'],
    }),
  };
  const sanitized = mongoose.sanitizeFilter(filter);
  assert.ok(Array.isArray(sanitized.status.$in));
  assert.ok(!Object.hasOwn(sanitized.status, '$eq'));
  assert.doesNotThrow(() => Order.find(sanitized).cast(Order));
});

test('untrusted active-order filter would be rewritten into an invalid equality cast', () => {
  const raw = { status: { $in: ['RECEIVED', 'PENDING'] } };
  const sanitized = mongoose.sanitizeFilter(raw);
  assert.ok(Object.hasOwn(sanitized.status, '$eq'));
  assert.throws(() => Order.find(sanitized).cast(Order), /Cast to string failed/);
});

test('payout settlement snapshot is transactionally durable and contains exact USD revision', async () => {
  const inserted = [];
  const session = { transactionId: 'settlement-txn' };
  const outboxModel = {
    async create(docs, options) {
      assert.equal(options.session, session);
      inserted.push(...docs);
      return docs;
    },
  };
  const relay = new PlatformEventRelay({
    enabled: true, outboxModel,
    now: () => new Date('2026-10-08T10:00:00.000Z'),
  });
  const account = {
    _id: new mongoose.Types.ObjectId('507f1f77bcf86cd799439011'),
    tenantId: new mongoose.Types.ObjectId('507f1f77bcf86cd799439012'),
    accountCode: 'STAGING-MASTER',
    currency: 'USD', financialRevision: 6,
    metadata: { fundedAccountId: 'MASTER-001' },
    tradingPermissionsVersion: 1,
    riskDayKey: '2026-10-08',
    state: {
      initialBalance: '10000', balance: '10100', equity: '10100',
      usedMargin: '0', freeMargin: '10100', floatingPnl: '0',
      realizedPnlToday: '500', dailyStartEquity: '10000',
    },
  };
  await relay.enqueuePayoutSettlement({
    account, payoutId: 'PAYOUT-ABC', ledgerEntryId: 'ledger-abc', session,
  });
  assert.equal(inserted.length, 1);
  const fact = inserted[0];
  assert.equal(fact.eventType, 'ACCOUNT_SNAPSHOT');
  assert.equal(fact.aggregateId, 'MASTER-001');
  assert.equal(fact.payload.financialRevision, 6);
  assert.equal(fact.payload.balance, '10100');
  assert.equal(fact.payload.equity, '10100');
  assert.equal(fact.payload.initialBalance, '10000');
  assert.equal(fact.payload.settlementLedgerEntryId, 'ledger-abc');
  assert.equal(fact.payload.payoutId, 'PAYOUT-ABC');
  assert.equal(fact.payload.instrumentValuationQuality, 'APPROVED_CLOSE');
  assert.equal(fact.payload.fxValuationQuality, 'NOT_REQUIRED');
  assert.equal(fact.payload.accountValuationCompleteness, 'COMPLETE');
  assert.equal(fact.payload.complete, true);
});
