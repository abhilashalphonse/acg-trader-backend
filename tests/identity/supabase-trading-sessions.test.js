'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { AuthService, hashToken } = require('../../src/modules/auth/auth.service');
const { IdentityService } = require('../../src/modules/identity/identity.service');
const { requireAccountGrant } = require('../../src/modules/auth/auth.middleware');

const TENANT_A = '64b000000000000000000001';
const TENANT_B = '64b000000000000000000002';
const USER = '64b000000000000000000003';
const IDENTITY = '64b000000000000000000004';
const ACCOUNT_A = '64b000000000000000000010';
const ACCOUNT_B = '64b000000000000000000011';
const NOW = new Date('2026-10-16T15:00:00.000Z');

function fixture() {
  const state = { userActive: true, identityActive: true, tenantActive: true, grants: [
    { userId: USER, tenantId: TENANT_A, accountId: ACCOUNT_A, permissions: ['TRADE'], status: 'ACTIVE', revokedAt: null, expiresAt: null },
    { userId: USER, tenantId: TENANT_B, accountId: ACCOUNT_B, permissions: ['VIEW'], status: 'ACTIVE', revokedAt: null, expiresAt: null },
  ], accountAActive: true, session: null };
  const queryResult = value => ({ select() { return { lean: async () => value }; }, lean: async () => value });
  const userModel = { findOne: q => queryResult(q._id === USER && state.userActive ? { _id: USER } : null) };
  const identityModel = { findOne: q => queryResult(q.userId === USER && q._id === IDENTITY && state.identityActive ? { _id: IDENTITY, userId: USER } : null) };
  const tenantModel = { findOne: q => queryResult(state.tenantActive && [TENANT_A, TENANT_B].includes(q._id) ? { _id: q._id } : null) };
  const grantModel = { find: q => queryResult(state.grants.filter(g =>
    g.tenantId === q.tenantId && g.userId === q.userId && g.status === 'ACTIVE' &&
    g.revokedAt == null && g.permissions.includes('TRADE') &&
    (!g.expiresAt || g.expiresAt > NOW)).map(g => ({ accountId: g.accountId }))) };
  const accountModel = { find: q => queryResult([ACCOUNT_A, ACCOUNT_B].filter(id =>
    q._id.$in.map(String).includes(id) &&
    (id === ACCOUNT_A ? q.tenantId === TENANT_A : q.tenantId === TENANT_B) &&
    (id !== ACCOUNT_A || state.accountAActive)
  ).map(id => ({ _id: id, tenantId: id === ACCOUNT_A ? TENANT_A : TENANT_B }))) };
  const sessionModel = {
    async create(record) { state.session = { _id: new mongoose.Types.ObjectId(), revokedAt: null, ...record }; return state.session; },
    findOne(query) { return { lean: async () => {
      const record = state.session;
      if (!record || query.revokedAt !== null) return null;
      const matching = query.refreshTokenHash
        ? record.refreshTokenHash === query.refreshTokenHash
        : (query.$or || []).some(entry => Object.entries(entry).every(([key, value]) => record[key] === value));
      if (!matching) return null;
      return { ...record };
    } }; },
    async updateOne() { return { modifiedCount: 1 }; },
    async findOneAndUpdate(query, patch) {
      if (!state.session || state.session.refreshTokenHash !== query.refreshTokenHash) return null;
      Object.assign(state.session, patch.$set);
      return { ...state.session };
    },
  };
  const auth = new AuthService({ userModel, loginIdentityModel: identityModel,
    tenantModel, accountAccessGrantModel: grantModel, accountModel, sessionModel,
    now: () => new Date(NOW) });
  return { auth, state };
}

test('exchange issues one tenant-scoped trading session from explicit TRADE grants', async () => {
  const { auth } = fixture();
  const created = await auth.createSupabaseTraderSession({ userId: USER, loginIdentityId: IDENTITY, tenantId: TENANT_A });
  assert.equal(created.session.tenantId, TENANT_A);
  assert.equal(created.session.authMethod, 'SUPABASE');
  assert.equal(created.session.userId, USER);
  assert.deepEqual(created.session.accountIds, [ACCOUNT_A]);
  assert.equal(created.session.selectedAccountId, ACCOUNT_A);
  const principal = await auth.authenticateSessionToken(created.accessToken);
  assert.deepEqual(principal.accountIds, [ACCOUNT_A]);
  assert.equal(principal.userId, USER);
  assert.doesNotThrow(() => requireAccountGrant(principal, ACCOUNT_A));
  assert.throws(() => requireAccountGrant(principal, ACCOUNT_B), e => e.code === 'ACCOUNT_ACCESS_FORBIDDEN');
});

test('tenant membership, email and VIEW-only access never authorize trading', async () => {
  const { auth } = fixture();
  await assert.rejects(auth.createSupabaseTraderSession({ userId: USER, loginIdentityId: IDENTITY, tenantId: TENANT_B }),
    e => e.code === 'ACCOUNT_ACCESS_FORBIDDEN');
  await assert.rejects(auth.createSupabaseTraderSession({ userId: USER, loginIdentityId: IDENTITY, tenantId: 'invalid' }),
    e => e.code === 'IDENTITY_CONTEXT_INVALID');
});

test('revoking a grant takes effect on the next HTTP auth, listing and refresh without logout', async () => {
  const { auth, state } = fixture();
  const created = await auth.createSupabaseTraderSession({ userId: USER, loginIdentityId: IDENTITY, tenantId: TENANT_A });
  state.grants[0].status = 'REVOKED';
  const principal = await auth.authenticateSessionToken(created.accessToken);
  assert.deepEqual(principal.accountIds, []);
  assert.deepEqual((await auth.listGrantedAccounts(principal)).accounts, []);
  assert.throws(() => requireAccountGrant(principal, ACCOUNT_A), e => e.code === 'ACCOUNT_ACCESS_FORBIDDEN');
  const refreshed = await auth.refreshSession({ refreshToken: created.refreshToken });
  assert.deepEqual(refreshed.session.accountIds, []);
  state.grants[0].status = 'ACTIVE';
  state.grants[0].expiresAt = new Date(NOW.getTime() - 1);
  assert.deepEqual((await auth.authenticateSessionToken(refreshed.accessToken)).accountIds, []);
});

test('disabling user, identity, tenant or account denies sessions immediately', async t => {
  for (const key of ['userActive', 'identityActive', 'tenantActive', 'accountAActive']) {
    await t.test(key, async () => {
      const { auth, state } = fixture();
      const created = await auth.createSupabaseTraderSession({ userId: USER, loginIdentityId: IDENTITY, tenantId: TENANT_A });
      state[key] = false;
      if (key === 'accountAActive') {
        const principal = await auth.authenticateSessionToken(created.accessToken);
        assert.deepEqual(principal.accountIds, []);
      } else {
        await assert.rejects(auth.authenticateSessionToken(created.accessToken), e => e.code === 'TRADER_SESSION_INVALID');
      }
    });
  }
});

test('identity exchange never implicitly creates or merges a Supabase person', async () => {
  const model = { findOne(query) { return { lean: async () => query.subject === 'known' ? { _id: IDENTITY, userId: USER } : null }; } };
  const users = { findOne() { return { lean: async () => ({ _id: USER, status: 'ACTIVE' }) }; } };
  const service = new IdentityService({ verifier: { verify: async token => ({ issuer: 'https://example.supabase.co/auth/v1', subject: token }) },
    identityModel: model, userModel: users });
  assert.deepEqual(await service.resolve('known'), { userId: USER, loginIdentityId: IDENTITY });
  await assert.rejects(service.resolve('unknown'), e => e.code === 'IDENTITY_DISABLED');
});
