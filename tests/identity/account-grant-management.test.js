'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AccountGrantManagementService } = require('../../src/modules/identity/account-grant-management.service');

const TENANT_A = '64b000000000000000000001';
const TENANT_B = '64b000000000000000000002';
const USER = '64b000000000000000000003';
const ACCOUNT = '64b000000000000000000010';
const NOW = new Date('2026-10-16T15:00:00.000Z');

function serviceFixture() {
  const state = { tenant: TENANT_A, accountTenant: TENANT_A, accountStatus: 'ACTIVE',
    userStatus: 'ACTIVE', source: null, grant: null, commands: [] };
  const lean = value => ({ select: () => ({ lean: async () => value }), lean: async () => value });
  const manager = new AccountGrantManagementService({
    now: () => new Date(NOW),
    tenantModel: { findOne: q => lean(q._id === state.tenant ? { _id: q._id, status: 'ACTIVE' } : null) },
    accountModel: { findOne: q => lean(q._id === ACCOUNT && q.tenantId === state.accountTenant ?
      { _id: ACCOUNT, tenantId: state.accountTenant, status: state.accountStatus } : null) },
    userModel: { findOne: q => lean(q._id === USER ? { _id: USER, status: state.userStatus } : null) },
    grantModel: {
      findOne: () => lean(state.source ? { source: state.source } : null),
      findOneAndUpdate(query, update) {
        state.commands.push({ operation: 'grant', query, update });
        if (state.source === 'PERSONAL') throw new Error('Should not mutate PERSONAL grant');
        state.source = 'PARTNER';
        state.grant = { permissions: update.$set.permissions, status: 'ACTIVE' };
        return { lean: async () => state.grant };
      },
      async updateOne(query, update) {
        state.commands.push({ operation: 'revoke', query, update });
        if (state.source !== 'PARTNER' || state.grant?.status !== 'ACTIVE') return { modifiedCount: 0 };
        state.grant.status = update.$set.status;
        return { modifiedCount: 1 };
      },
    },
  });
  return { manager, state };
}

test('a tenant service can grant and revoke only an explicit linked user/account pair', async () => {
  const { manager, state } = serviceFixture();
  const command = { tenantId: TENANT_A, accountId: ACCOUNT, userId: USER, clientId: 'firm-service' };
  const granted = await manager.grant({ ...command, permissions: ['TRADE', 'VIEW'] });
  assert.equal(granted.status, 'ACTIVE');
  assert.deepEqual(granted.permissions, ['TRADE', 'VIEW']);
  assert.deepEqual(state.commands[0].query.tenantId, TENANT_A);
  assert.equal(state.commands[0].query.accountId, ACCOUNT);
  assert.equal(state.commands[0].query.userId, USER);
  assert.equal(state.commands[0].update.$set.updatedByClientId, 'firm-service');
  const revoked = await manager.revoke(command);
  assert.equal(revoked.revoked, true);
  assert.equal(state.commands[1].query.source, 'PARTNER');
  assert.equal(state.grant.status, 'REVOKED');
});

test('cross-tenant target and personal ownership are forbidden', async () => {
  const { manager, state } = serviceFixture();
  const command = { tenantId: TENANT_B, accountId: ACCOUNT, userId: USER, clientId: 'firm-service' };
  await assert.rejects(manager.grant({ ...command, permissions: ['TRADE'] }), e => e.code === 'ACCOUNT_GRANT_FORBIDDEN');
  state.source = 'PERSONAL';
  await assert.rejects(manager.grant({ ...command, tenantId: TENANT_A, permissions: ['TRADE'] }),
    e => e.code === 'ACCOUNT_GRANT_FORBIDDEN');
  assert.equal(state.commands.length, 0);
});

test('inactive users cannot gain rights, but previously granted rights can be revoked', async () => {
  const { manager, state } = serviceFixture();
  const command = { tenantId: TENANT_A, accountId: ACCOUNT, userId: USER, clientId: 'firm-service' };
  await manager.grant({ ...command, permissions: ['TRADE'] });
  state.userStatus = 'DISABLED';
  await assert.rejects(manager.grant({ ...command, permissions: ['TRADE'] }),
    e => e.code === 'ACCOUNT_GRANT_FORBIDDEN');
  assert.equal((await manager.revoke(command)).revoked, true);
});
