'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountControlService } = require('../../src/modules/trading/account-control.service');

function fixture() {
  const account = {
    _id: '507f1f77bcf86cd799439011',
    tenantId: '507f1f77bcf86cd799439012',
    currency: 'USD', status: 'PAUSED', tradingEnabled: false,
    federationEnabled: false, riskProcessingState: 'RESOLVED',
    marginStopOutState: 'NONE', riskSequence: 10,
    lastEvaluatedRiskSequence: 10, financialRevision: 5,
    state: {
      initialBalance: '10000', balance: '10500',
      equity: '10500', floatingPnl: '0', usedMargin: '0',
      freeMargin: '10500',
    },
    async save() { return this; },
  };
  const reservations = new Map();
  const cancellations = new Map();
  const ledgerRows = [{
    entryId: 'opening', balanceAfter: '10500',
  }];
  const sessionValue = fn => ({ session: async () => fn() });
  const accountModel = {
    findById: () => sessionValue(() => account),
  };
  class Reservation {
    constructor(data) { Object.assign(this, data); }
    async save() { reservations.set(this.payoutId, this); }
  }
  Reservation.findOne = ({ payoutId }) => sessionValue(() => reservations.get(payoutId) || null);
  class Cancellation {
    constructor(data) { Object.assign(this, data); }
    async save() { cancellations.set(this.payoutId, this); }
  }
  Cancellation.findOne = ({ payoutId }) => sessionValue(() => cancellations.get(payoutId) || null);
  class Ledger {
    constructor(data) {
      Object.assign(this, data);
      this.entryId = `payout-ledger-${data.referenceId}`;
    }
    async save() { ledgerRows.push(this); }
  }
  Ledger.findOne = () => ({
    sort() { return this; },
    session() { return this; },
    async lean() { return ledgerRows.at(-1); },
  });
  const count = () => sessionValue(() => 0);
  const svc = new AccountControlService({
    accountModel,
    payoutReservationModel: Reservation,
    payoutCancellationModel: Cancellation,
    ledgerModel: Ledger,
    positionModel: { countDocuments: count },
    orderModel: { countDocuments: count },
    commandQueue: { run: (_key, fn) => fn() },
    runTransaction: fn => fn({}),
    platformEventRelay: { enqueueControl: async () => {} },
    now: () => new Date('2026-10-08T10:00:00.000Z'),
  });
  return { svc, account, ledgerRows, reservations, cancellations };
}

test('reservation is idempotent, and settling debits USD ledger exactly once', async () => {
  const { svc, account, ledgerRows } = fixture();
  const checkpoint = await svc.getPayoutSettlementCheckpoint(account._id);
  assert.equal(checkpoint.settled, true);
  const request = {
    payoutId: 'PAYOUT-TEST-1', amountUsd: '400.00',
    financialRevision: checkpoint.financialRevision,
    checkpointHash: checkpoint.evidenceHash,
  };
  const first = await svc.reservePayout(account._id, request);
  assert.equal(first.reservation.status, 'RESERVED');
  assert.equal(first.idempotentReplay, false);
  assert.equal(account.activePayoutReservationId, 'PAYOUT-TEST-1');
  const replay = await svc.reservePayout(account._id, request);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(ledgerRows.length, 1);

  const settled = await svc.settlePayout(account._id, { payoutId: 'PAYOUT-TEST-1' });
  assert.equal(settled.reservation.status, 'SETTLED');
  assert.equal(account.state.balance, '10100');
  assert.equal(account.financialRevision, 6);
  assert.equal(account.payoutRiskBaselineReviewRequired, true);
  assert.equal(account.activePayoutReservationId, null);
  assert.equal(ledgerRows.length, 2);
  assert.equal(ledgerRows[1].amount, '-400');
  const repeated = await svc.settlePayout(account._id, { payoutId: 'PAYOUT-TEST-1' });
  assert.equal(repeated.idempotentReplay, true);
  assert.equal(ledgerRows.length, 2);
  assert.equal(account.state.balance, '10100');

  await assert.rejects(
    svc.releasePayout(account._id, { payoutId: 'PAYOUT-TEST-1', reason: 'TRY_REFUND' }),
    error => error.code === 'PAYOUT_ALREADY_SETTLED',
  );
});

test('release does not debit ledger; one active payout at a time', async () => {
  const { svc, account, ledgerRows } = fixture();
  const checkpoint = await svc.getPayoutSettlementCheckpoint(account._id);
  const request = { payoutId: 'PAYOUT-TEST-2', amountUsd: '100',
    financialRevision: checkpoint.financialRevision,
    checkpointHash: checkpoint.evidenceHash,
  };
  await svc.reservePayout(account._id, request);
  await assert.rejects(svc.reservePayout(account._id, {
    ...request, payoutId: 'PAYOUT-TEST-3',
  }), error => error.code === 'PAYOUT_RESERVATION_ACTIVE');
  const released = await svc.releasePayout(account._id, {
    payoutId: request.payoutId, reason: 'VERIFIED_PROVIDER_FAILED',
  });
  assert.equal(released.reservation.status, 'RELEASED');
  assert.equal(account.activePayoutReservationId, null);
  assert.equal(ledgerRows.length, 1);
  assert.equal(account.state.balance, '10500');
  const replay = await svc.releasePayout(account._id, {
    payoutId: request.payoutId, reason: 'VERIFIED_PROVIDER_FAILED',
  });
  assert.equal(replay.idempotentReplay, true);
  await assert.rejects(svc.reservePayout(account._id, request),
    error => error.code === 'PAYOUT_RESERVATION_RELEASED');
});

test('changed checkpoint or insufficient profit cannot be reserved', async () => {
  const { svc, account } = fixture();
  const c = await svc.getPayoutSettlementCheckpoint(account._id);
  await assert.rejects(svc.reservePayout(account._id, {
    payoutId: 'PAYOUT-TEST-4', amountUsd: '400',
    financialRevision: c.financialRevision, checkpointHash: 'f'.repeat(64),
  }), error => error.code === 'PAYOUT_CHECKPOINT_CHANGED');
  await assert.rejects(svc.reservePayout(account._id, {
    payoutId: 'PAYOUT-TEST-5', amountUsd: '600',
    financialRevision: c.financialRevision, checkpointHash: c.evidenceHash,
  }), error => error.code === 'PAYOUT_AMOUNT_EXCEEDS_REALIZED_PROFIT');
  assert.equal(account.activePayoutReservationId, undefined);
});


test('rejection before approval leaves a durable tombstone and forbids a late reservation', async () => {
  const { svc, account, cancellations, ledgerRows } = fixture();
  const checkpoint = await svc.getPayoutSettlementCheckpoint(account._id);
  const cancelled = await svc.releasePayout(account._id, {
    payoutId: 'PAYOUT-CANCEL-1', reason: 'ADMIN_REJECTED',
  });
  assert.equal(cancelled.reservation.status, 'CANCELLED');
  assert.equal(cancellations.has('PAYOUT-CANCEL-1'), true);
  assert.equal(account.payoutCancellationRevision, 1);
  const repeated = await svc.releasePayout(account._id, {
    payoutId: 'PAYOUT-CANCEL-1', reason: 'ADMIN_REJECTED',
  });
  assert.equal(repeated.idempotentReplay, true);
  await assert.rejects(svc.reservePayout(account._id, {
    payoutId: 'PAYOUT-CANCEL-1', amountUsd: '100',
    financialRevision: checkpoint.financialRevision,
    checkpointHash: checkpoint.evidenceHash,
  }), error => error.code === 'PAYOUT_CANCELLED');
  assert.equal(ledgerRows.length, 1);
});


test('verified provider success settles exactly once after account disable or closure', async () => {
  for (const terminal of ['DISABLED', 'BREACHED', 'CLOSED']) {
    const { svc, account, ledgerRows } = fixture();
    const before = await svc.getPayoutSettlementCheckpoint(account._id);
    const payoutId = `PAYOUT-${terminal}`;
    await svc.reservePayout(account._id, {
      payoutId, amountUsd: '400',
      financialRevision: before.financialRevision,
      checkpointHash: before.evidenceHash,
    });
    // Simulate the existing control service restricting trading without
    // changing the reserved financial terms or ledger.
    account.status = terminal;
    account.tradingEnabled = false;
    const paid = await svc.settlePayout(account._id, { payoutId });
    assert.equal(paid.reservation.status, 'SETTLED');
    assert.equal(account.status, terminal, 'settlement must not reactivate restricted account');
    assert.equal(account.state.balance, '10100');
    assert.equal(ledgerRows.filter(x => x.referenceId === payoutId).length, 1);
    const replay = await svc.settlePayout(account._id, { payoutId });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(ledgerRows.filter(x => x.referenceId === payoutId).length, 1);
  }
});

test('restricted account with changed balance still cannot settle', async () => {
  const { svc, account, ledgerRows } = fixture();
  const before = await svc.getPayoutSettlementCheckpoint(account._id);
  await svc.reservePayout(account._id, {
    payoutId: 'PAYOUT-MISMATCH', amountUsd: '400',
    financialRevision: before.financialRevision,
    checkpointHash: before.evidenceHash,
  });
  account.status = 'DISABLED';
  account.state.balance = '10499';
  await assert.rejects(svc.settlePayout(account._id, {
    payoutId: 'PAYOUT-MISMATCH',
  }), error => error.code === 'PAYOUT_RESERVATION_FENCE_CHANGED');
  assert.equal(ledgerRows.length, 1);
});
