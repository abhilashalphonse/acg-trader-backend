'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountControlService, normalizeProvisionCommand, buildInitialState } = require('../../src/modules/trading/account-control.service');

const TENANT_ID = '64b000000000000000000001';

function createFakeModels() {
  const records = new Map(); let seq = 1;
  class FakeAccount {
    constructor(input) { Object.assign(this, input); this._id = input._id || String(seq++).padStart(24, '0'); this.metadata = input.metadata instanceof Map ? input.metadata : new Map(Object.entries(input.metadata || {})); }
    async save() { records.set(String(this._id), this); return this; }
    static async findOne(query) { return [...records.values()].find(account => String(account.tenantId) === String(query.tenantId) && account.externalRef === query.externalRef) || null; }
    static async findById(id) { return records.get(String(id)) || null; }
  }
  const cancelled = [];
  const orderModel = { async updateMany(filter, update) { cancelled.push({ filter, update }); return { modifiedCount: 2 }; } };
  const positionModel = { find() { return { select() { return { async lean() { return []; } }; } }; }, async countDocuments() { return 0; } };
  return { FakeAccount, orderModel, positionModel, records, cancelled };
}

test('provisioning rejects commands without tenantId', () => {
  assert.throws(
    () => normalizeProvisionCommand({ externalRef: 'challenge-123', ownerExternalRef: 'user-9', initialBalance: '100000' }),
    error => error.code === 'INVALID_ACCOUNT_CONTROL_COMMAND' && /tenantId/.test(error.message),
  );
});

test('normalizeProvisionCommand builds a tenant-scoped challenge account safely', () => {
  const command = normalizeProvisionCommand({ tenantId: TENANT_ID, externalRef: 'challenge-123', ownerExternalRef: 'user-9', initialBalance: '100000', leverage: 100, riskPolicy: { dailyLoss: { limit: '3000' }, maxLoss: { limit: '6000' }, profitTarget: '10000', allowedSymbols: ['eur/usd', 'xauusd'] } });
  assert.equal(command.tenantId, TENANT_ID); assert.equal(command.accountType, 'CHALLENGE'); assert.equal(command.initialBalance, '100000'); assert.deepEqual(command.riskPolicy.allowedSymbols, ['EURUSD', 'XAUUSD']); assert.equal(buildInitialState('100000').freeMargin, '100000');
});

test('provision is idempotent within a tenant', async () => {
  const { FakeAccount, orderModel, positionModel } = createFakeModels(); const service = new AccountControlService({ accountModel: FakeAccount, orderModel, positionModel });
  const payload = { tenantId: TENANT_ID, externalRef: 'challenge-123', ownerExternalRef: 'user-9', initialBalance: '100000', leverage: 100 };
  const first = await service.provision(payload); const second = await service.provision(payload);
  assert.equal(first.idempotentReplay, false); assert.equal(second.idempotentReplay, true); assert.equal(first.account.id, second.account.id); assert.equal(second.account.externalRef, 'challenge-123'); assert.equal(second.account.tenantId, TENANT_ID);
});

test('same externalRef can exist in different tenants', async () => {
  const { FakeAccount, orderModel, positionModel } = createFakeModels(); const service = new AccountControlService({ accountModel: FakeAccount, orderModel, positionModel });
  const first = await service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-shared', ownerExternalRef: 'user-a', initialBalance: '10000' });
  const second = await service.provision({ tenantId: '64b000000000000000000002', externalRef: 'challenge-shared', ownerExternalRef: 'user-b', initialBalance: '10000' });
  assert.notEqual(first.account.id, second.account.id);
});

test('reusing an externalRef with different account parameters in the same tenant is rejected', async () => {
  const { FakeAccount, orderModel, positionModel } = createFakeModels(); const service = new AccountControlService({ accountModel: FakeAccount, orderModel, positionModel });
  await service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-123', ownerExternalRef: 'user-9', initialBalance: '100000', leverage: 100 });
  await assert.rejects(() => service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-123', ownerExternalRef: 'user-9', initialBalance: '200000', leverage: 100 }), error => error.code === 'ACCOUNT_PROVISIONING_CONFLICT');
});

test('disable locks trading and cancels pending orders by default', async () => {
  const { FakeAccount, orderModel, positionModel, cancelled } = createFakeModels(); const service = new AccountControlService({ accountModel: FakeAccount, orderModel, positionModel });
  const created = await service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-456', ownerExternalRef: 'user-10', initialBalance: '50000' });
  const result = await service.disable(created.account.id, { reason: 'ADMIN_LOCK' });
  assert.equal(result.account.status, 'DISABLED'); assert.equal(result.account.tradingEnabled, false); assert.equal(result.cancelledPending, 2); assert.equal(cancelled.length, 1);
});

test('breached and disabled accounts cannot be resumed', async () => {
  const { FakeAccount, orderModel, positionModel } = createFakeModels(); const service = new AccountControlService({ accountModel: FakeAccount, orderModel, positionModel });
  const created = await service.provision({ tenantId: TENANT_ID, externalRef: 'challenge-789', ownerExternalRef: 'user-11', initialBalance: '25000' }); await service.disable(created.account.id, { reason: 'ADMIN_LOCK' });
  await assert.rejects(() => service.resume(created.account.id), error => error.code === 'ACCOUNT_RESUME_FORBIDDEN');
});
