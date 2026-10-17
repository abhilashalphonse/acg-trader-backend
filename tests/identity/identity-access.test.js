'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { IdentityService } = require('../../src/modules/identity/identity.service');
const { AccountAccessService } = require('../../src/modules/identity/account-access.service');
const { userSchema } = require('../../src/modules/identity/user.model');
const { loginIdentitySchema } = require('../../src/modules/identity/login-identity.model');
const { organizationMembershipSchema } = require('../../src/modules/identity/organization-membership.model');
const { accountAccessGrantSchema } = require('../../src/modules/identity/account-access-grant.model');

function fakeIdentityStore() {
  const identities = new Map();
  const users = new Map();
  const identityModel = {
    findOneAndUpdate(q, update) {
      const key = `${q.provider}:${q.issuer}:${q.subject}`;
      if (!identities.has(key)) identities.set(key, { ...q, ...update.$setOnInsert });
      return { lean: async () => identities.get(key) };
    },
    findOne(q) { return { lean: async () => identities.get(`${q.provider}:${q.issuer}:${q.subject}`) }; },
  };
  const userModel = {
    findOneAndUpdate(q, update) {
      const key = String(q._id);
      if (!users.has(key)) users.set(key, { _id: q._id, ...update.$setOnInsert });
      return { lean: async () => users.get(key) };
    },
    findOne(q) { return { lean: async () => users.get(String(q._id)) }; },
  };
  return { identities, users, identityModel, userModel };
}

const issuer = 'https://mwkwvchaqjqtyfgmialk.supabase.co/auth/v1';
test('same issuer+subject produces one user even on concurrent retries', async () => {
  const store = fakeIdentityStore();
  const service = new IdentityService({ ...store, verifier: { verify: async () => ({
    issuer, subject: 'a66d08af-5b39-4e41-8522-57581ef6081b',
  }) } });
  const results = await Promise.all(Array.from({ length: 30 }, () => service.bootstrap('signed-token')));
  assert.equal(new Set(results.map(item => item.userId)).size, 1);
  assert.equal(store.users.size, 1);
  assert.equal(store.identities.size, 1);
  assert.equal(results[0].status, 'SETUP_REQUIRED');
});

test('identity matching never uses email to merge two subjects', async () => {
  const store = fakeIdentityStore();
  const service = new IdentityService({ ...store, verifier: { verify: async token => ({
    issuer, subject: token,
  }) } });
  const first = await service.bootstrap('b66d08af-5b39-4e41-8522-57581ef6081b');
  const second = await service.bootstrap('c66d08af-5b39-4e41-8522-57581ef6081b');
  assert.notEqual(first.userId, second.userId);
  assert.equal(store.users.size, 2);
});

test('disabled person and disabled login identity cannot be bootstrapped', async () => {
  const store = fakeIdentityStore();
  const service = new IdentityService({ ...store, verifier: { verify: async () => ({
    issuer, subject: 'd66d08af-5b39-4e41-8522-57581ef6081b',
  }) } });
  const first = await service.bootstrap('signed');
  store.users.get(first.userId).status = 'DISABLED';
  await assert.rejects(service.bootstrap('signed'), error => error.code === 'IDENTITY_DISABLED');
  store.users.get(first.userId).status = 'ACTIVE';
  [...store.identities.values()][0].status = 'DISABLED';
  await assert.rejects(service.bootstrap('signed'), error => error.code === 'IDENTITY_DISABLED');
});

test('grant evaluation requires active user, tenant, matching account and exact permission', async () => {
  let userActive = true, tenantActive = true, matchingTenant = true, grantActive = true, expired = false;
  const q = [];
  const service = new AccountAccessService({
    now: () => new Date('2026-10-16T10:00:00.000Z'),
    userModel: { findOne(query) {
      q.push(['user', query]); return { lean: async () => userActive ? { _id: 'u1' } : null };
    } },
    tenantModel: { findOne(query) {
      q.push(['tenant', query]); return { lean: async () => tenantActive ? { _id: 't1' } : null };
    } },
    accountModel: { findOne(query) {
      q.push(['account', query]);
      return { select() { return { lean: async () => matchingTenant ? { _id: 'a1', tenantId: 't1', status: 'ACTIVE' } : null }; } };
    } },
    grantModel: { findOne(query) {
      q.push(['grant', query]);
      return { lean: async () => (grantActive && !expired && query.permissions === 'TRADE') ? { status: 'ACTIVE' } : null };
    } },
  });
  const command = { userId: 'u1', tenantId: 't1', accountId: 'a1', permission: 'TRADE' };
  assert.equal((await service.requireGrant(command)).accountId, 'a1');
  const grantQuery = q.find(item => item[0] === 'grant')[1];
  assert.deepEqual({ tenantId: grantQuery.tenantId, accountId: grantQuery.accountId, userId: grantQuery.userId,
    status: grantQuery.status, revokedAt: grantQuery.revokedAt, permissions: grantQuery.permissions },
    { tenantId: 't1', accountId: 'a1', userId: 'u1', status: 'ACTIVE', revokedAt: null, permissions: 'TRADE' });
  assert.ok(grantQuery.$or, 'expiry must be checked');
  grantActive = false;
  await assert.rejects(service.requireGrant(command), error => error.code === 'ACCOUNT_ACCESS_FORBIDDEN');
  grantActive = true; expired = true;
  await assert.rejects(service.requireGrant(command), error => error.code === 'ACCOUNT_ACCESS_FORBIDDEN');
  expired = false; matchingTenant = false;
  await assert.rejects(service.requireGrant(command), error => error.code === 'ACCOUNT_ACCESS_FORBIDDEN');
  matchingTenant = true; tenantActive = false;
  await assert.rejects(service.requireGrant(command), error => error.code === 'ACCOUNT_ACCESS_FORBIDDEN');
  tenantActive = true; userActive = false;
  await assert.rejects(service.requireGrant(command), error => error.code === 'ACCOUNT_ACCESS_FORBIDDEN');
  await assert.rejects(service.requireGrant({ ...command, permission: 'UNKNOWN' }), error => error.code === 'ACCOUNT_ACCESS_FORBIDDEN');
});

test('identity schema has unique provider subject; membership alone never implies an account grant', () => {
  assert.ok(loginIdentitySchema.indexes().some(([keys,opts]) => opts.unique && keys.provider === 1 && keys.issuer === 1 && keys.subject === 1));
  assert.ok(accountAccessGrantSchema.indexes().some(([keys,opts]) => opts.unique && keys.tenantId === 1 && keys.accountId === 1 && keys.userId === 1));
  assert.ok(organizationMembershipSchema.indexes().some(([keys,opts]) => opts.unique && keys.tenantId === 1 && keys.userId === 1));
  assert.equal(userSchema.path('status').options.default, 'ACTIVE');
});
