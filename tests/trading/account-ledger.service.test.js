'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountLedgerService } = require('../../src/modules/accounts/account-ledger.service');

const TENANT_ID = '64b000000000000000000001';
const ACCOUNT_ID = '64c000000000000000000001';

function query(value) {
  return {
    session() { return this; },
    then(resolve, reject) { return Promise.resolve(value()).then(resolve, reject); },
  };
}

function createFixture({ balance = '1000', equity = '1000', usedMargin = '0', freeMargin = '1000', status = 'ACTIVE' } = {}) {
  const ledgers = [];
  const account = {
    _id: ACCOUNT_ID,
    tenantId: TENANT_ID,
    accountCode: 'ACG-TEST',
    externalRef: 'challenge-ledger',
    currency: 'USD',
    status,
    tradingEnabled: status === 'ACTIVE',
    state: { balance, equity, floatingPnl: '0', usedMargin, freeMargin },
    async save() { return this; },
  };

  const accountModel = {
    findOne(filter) {
      return query(() => String(filter._id) === ACCOUNT_ID && String(filter.tenantId) === TENANT_ID ? account : null);
    },
  };

  class LedgerModel {
    constructor(input) {
      Object.assign(this, input);
      this._id = String(ledgers.length + 1).padStart(24, '0');
      this.entryId = `entry-${ledgers.length + 1}`;
      this.createdAt = new Date('2026-09-17T12:00:00.000Z');
    }
    async save() { ledgers.push(this); return this; }
    static async findOne(filter) {
      return ledgers.find(entry => String(entry.tenantId) === String(filter.tenantId)
        && String(entry.accountId) === String(filter.accountId)
        && entry.idempotencyKey === filter.idempotencyKey) || null;
    }
  }

  const service = new AccountLedgerService({
    accountModel,
    ledgerModel: LedgerModel,
    runTransaction: async work => work(null),
    commandQueue: { async run(_key, work) { return work(); } },
  });

  return { service, account, ledgers };
}

function command(overrides = {}) {
  return {
    tenantId: TENANT_ID,
    type: 'DEPOSIT',
    amount: '250',
    idempotencyKey: 'balance-command-1',
    referenceId: 'crm-adjustment-1',
    reason: 'CRM balance adjustment',
    ...overrides,
  };
}

test('deposit updates balance, equity and free margin with one immutable ledger entry', async () => {
  const { service, account, ledgers } = createFixture();
  const result = await service.mutate(ACCOUNT_ID, command());

  assert.equal(result.idempotentReplay, false);
  assert.equal(account.state.balance, '1250');
  assert.equal(account.state.equity, '1250');
  assert.equal(account.state.freeMargin, '1250');
  assert.equal(ledgers.length, 1);
  assert.equal(ledgers[0].amount, '250');
  assert.equal(ledgers[0].balanceBefore, '1000');
  assert.equal(ledgers[0].balanceAfter, '1250');
});

test('withdrawal is recorded as a negative ledger amount', async () => {
  const { service, account, ledgers } = createFixture();
  await service.mutate(ACCOUNT_ID, command({ type: 'WITHDRAWAL', amount: '200' }));

  assert.equal(account.state.balance, '800');
  assert.equal(account.state.equity, '800');
  assert.equal(ledgers[0].amount, '-200');
});

test('ledger mutation replay is idempotent', async () => {
  const { service, ledgers } = createFixture();
  const first = await service.mutate(ACCOUNT_ID, command());
  const second = await service.mutate(ACCOUNT_ID, command());

  assert.equal(first.idempotentReplay, false);
  assert.equal(second.idempotentReplay, true);
  assert.equal(ledgers.length, 1);
});

test('reusing an idempotency key with different mutation semantics is rejected', async () => {
  const { service } = createFixture();
  await service.mutate(ACCOUNT_ID, command());
  await assert.rejects(
    () => service.mutate(ACCOUNT_ID, command({ amount: '500' })),
    error => error.code === 'LEDGER_IDEMPOTENCY_CONFLICT',
  );
});

test('withdrawal cannot consume margin collateral', async () => {
  const { service } = createFixture({ balance: '1000', equity: '700', usedMargin: '600', freeMargin: '100' });
  await assert.rejects(
    () => service.mutate(ACCOUNT_ID, command({ type: 'WITHDRAWAL', amount: '200' })),
    error => error.code === 'INSUFFICIENT_FREE_MARGIN',
  );
});

test('closed accounts reject balance mutations', async () => {
  const { service } = createFixture({ status: 'CLOSED' });
  await assert.rejects(
    () => service.mutate(ACCOUNT_ID, command()),
    error => error.code === 'ACCOUNT_CLOSED',
  );
});
