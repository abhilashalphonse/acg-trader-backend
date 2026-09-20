'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountControlService, normalizeProvisionCommand, buildInitialState } = require('../../src/modules/trading/account-control.service');
const { dayKeyInTimezone } = require('../../src/modules/trading/risk-day-engine');

const TENANT_ID = '64b000000000000000000001';

function query(value) {
  return {
    session() { return this; },
    then(resolve, reject) { return Promise.resolve(value()).then(resolve, reject); },
  };
}

function createFakeModels() {
  const records = new Map();
  const ledgerRecords = [];
  const lifecycleRecords = [];
  let seq = 1;

  class FakeAccount {
    constructor(input) {
      Object.assign(this, input);
      this._id = input._id || String(seq++).padStart(24, '0');
      this.metadata = input.metadata instanceof Map ? input.metadata : new Map(Object.entries(input.metadata || {}));
    }
    async save() { records.set(String(this._id), this); return this; }
    static findOne(filter) {
      return query(() => [...records.values()].find(account => {
        if (filter._id && String(account._id) !== String(filter._id)) return false;
        if (filter.tenantId && String(account.tenantId) !== String(filter.tenantId)) return false;
        if (filter.externalRef && account.externalRef !== filter.externalRef) return false;
        return true;
      }) || null);
    }
    static findById(id) { return query(() => records.get(String(id)) || null); }
  }

  class FakeLedger {
    constructor(input) { Object.assign(this, input); }
    async save() { ledgerRecords.push(this); return this; }
  }

  class FakeLifecycle {
    constructor(input) { Object.assign(this, input); }
    async save() { lifecycleRecords.push(this); return this; }
  }

  const cancelled = [];
  const orderModel = {
    async updateMany(filter, update) {
      cancelled.push({ filter, update });
      return { modifiedCount: 2 };
    },
  };
  const positionModel = {
    find() { return { select() { return { async lean() { return []; } }; } }; },
    async countDocuments() { return 0; },
  };

  return {
    FakeAccount,
    FakeLedger,
    FakeLifecycle,
    orderModel,
    positionModel,
    records,
    ledgerRecords,
    lifecycleRecords,
    cancelled,
  };
}

function createService(models) {
  return new AccountControlService({
    accountModel: models.FakeAccount,
    ledgerModel: models.FakeLedger,
    lifecycleModel: models.FakeLifecycle,
    orderModel: models.orderModel,
    positionModel: models.positionModel,
    runTransaction: async work => work(null),
  });
}

test('provisioning rejects commands without tenantId', () => {
  assert.throws(
    () => normalizeProvisionCommand({ externalRef: 'challenge-123', ownerExternalRef: 'user-9', initialBalance: '100000' }),
    error => error.code === 'INVALID_ACCOUNT_CONTROL_COMMAND' && /tenantId/.test(error.message),
  );
});

test('normalizeProvisionCommand builds a tenant-scoped challenge account safely', () => {
  const command = normalizeProvisionCommand({
    tenantId: TENANT_ID,
    externalRef: 'challenge-123',
    ownerExternalRef: 'user-9',
    initialBalance: '100000',
    leverage: 100,
    riskPolicy: {
      dailyLoss: { limit: '3000' },
      maxLoss: { limit: '6000' },
      profitTarget: '10000',
      allowedSymbols: ['eur/usd', 'xauusd'],
    },
  });
  assert.equal(command.tenantId, TENANT_ID);
  assert.equal(command.accountType, 'CHALLENGE');
  assert.equal(command.initialBalance, '100000');
  assert.deepEqual(command.riskPolicy.allowedSymbols, ['EURUSD', 'XAUUSD']);
  assert.equal(buildInitialState('100000').freeMargin, '100000');
});

test('provision atomically creates opening ledger and lifecycle audit records', async () => {
  const models = createFakeModels();
  const service = createService(models);
  const result = await service.provision({
    tenantId: TENANT_ID,
    externalRef: 'challenge-opening',
    ownerExternalRef: 'user-opening',
    initialBalance: '100000',
  });

  assert.equal(result.idempotentReplay, false);
  assert.equal(models.ledgerRecords.length, 1);
  assert.equal(models.ledgerRecords[0].type, 'DEPOSIT');
  assert.equal(models.ledgerRecords[0].balanceBefore, '0');
  assert.equal(models.ledgerRecords[0].balanceAfter, '100000');
  assert.equal(models.lifecycleRecords.length, 1);
  assert.equal(models.lifecycleRecords[0].type, 'PROVISIONED');
  assert.equal(models.lifecycleRecords[0].toStatus, 'ACTIVE');
});

test('provision is idempotent within a tenant without duplicating opening records', async () => {
  const models = createFakeModels();
  const service = createService(models);
  const payload = { tenantId: TENANT_ID, externalRef: 'challenge-123', ownerExternalRef: 'user-9', initialBalance: '100000', leverage: 100 };
  const first = await service.provision(payload);
  const second = await service.provision(payload);
  assert.equal(first.idempotentReplay, false);
  assert.equal(second.idempotentReplay, true);
  assert.equal(first.account.id, second.account.id);
  assert.equal(second.account.externalRef, 'challenge-123');
  assert.equal(second.account.tenantId, TENANT_ID);
  assert.equal(models.ledgerRecords.length, 1);
  assert.equal(models.lifecycleRecords.length, 1);
});

test('same externalRef can exist in different tenants', async () => {
  const models = createFakeModels();
  const service = createService(models);
  const first = await service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-shared', ownerExternalRef: 'user-a', initialBalance: '10000' });
  const second = await service.provision({ tenantId: '64b000000000000000000002', externalRef: 'challenge-shared', ownerExternalRef: 'user-b', initialBalance: '10000' });
  assert.notEqual(first.account.id, second.account.id);
});

test('reusing an externalRef with different account parameters in the same tenant is rejected', async () => {
  const models = createFakeModels();
  const service = createService(models);
  await service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-123', ownerExternalRef: 'user-9', initialBalance: '100000', leverage: 100 });
  await assert.rejects(
    () => service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-123', ownerExternalRef: 'user-9', initialBalance: '200000', leverage: 100 }),
    error => error.code === 'ACCOUNT_PROVISIONING_CONFLICT',
  );
});

test('disable locks trading, cancels pending orders, and records lifecycle transition', async () => {
  const models = createFakeModels();
  const service = createService(models);
  const created = await service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-456', ownerExternalRef: 'user-10', initialBalance: '50000' });
  const result = await service.disable(created.account.id, { reason: 'ADMIN_LOCK' });
  assert.equal(result.account.status, 'DISABLED');
  assert.equal(result.account.tradingEnabled, false);
  assert.equal(result.cancelledPending, 2);
  assert.equal(models.cancelled.length, 1);
  assert.equal(models.lifecycleRecords.at(-1).type, 'DISABLED');
  assert.equal(models.lifecycleRecords.at(-1).reason, 'ADMIN_LOCK');
});

test('replaying the same lifecycle state is idempotent and does not duplicate lifecycle audit', async () => {
  const models = createFakeModels();
  const service = createService(models);
  const created = await service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-idempotent-disable', ownerExternalRef: 'user-10', initialBalance: '50000' });
  await service.disable(created.account.id, { reason: 'ADMIN_LOCK' });
  const afterFirst = models.lifecycleRecords.length;
  const second = await service.disable(created.account.id, { reason: 'ADMIN_LOCK' });
  assert.equal(second.changed, false);
  assert.equal(models.lifecycleRecords.length, afterFirst);
});

test('breached and disabled accounts cannot be resumed', async () => {
  const models = createFakeModels();
  const service = createService(models);
  const created = await service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-789', ownerExternalRef: 'user-11', initialBalance: '25000' });
  await service.disable(created.account.id, { reason: 'ADMIN_LOCK' });
  await assert.rejects(() => service.resume(created.account.id), error => error.code === 'ACCOUNT_RESUME_FORBIDDEN');
});


test('provisioning initializes risk day in the configured account timezone', () => {
  const before = new Date();
  const command = normalizeProvisionCommand({
    tenantId: TENANT_ID,
    externalRef: 'challenge-timezone',
    ownerExternalRef: 'user-timezone',
    initialBalance: '100000',
    riskTimezone: 'America/New_York',
  });
  const after = new Date();

  const validKeys = new Set([
    dayKeyInTimezone(before, 'America/New_York'),
    dayKeyInTimezone(after, 'America/New_York'),
  ]);
  assert.equal(command.riskTimezone, 'America/New_York');
  assert.ok(validKeys.has(command.riskDayKey));
});
