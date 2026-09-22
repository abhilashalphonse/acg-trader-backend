'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { AuthService, hashPassword, verifyPassword, hashToken } = require('../../src/modules/auth/auth.service');
const { requireAccountGrant } = require('../../src/modules/auth/auth.middleware');

test('native trading passwords are salted and verifiable', async () => {
  const first = await hashPassword('StrongTradingPassword!123');
  const second = await hashPassword('StrongTradingPassword!123');
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.hash, second.hash);
  assert.equal(await verifyPassword('StrongTradingPassword!123', first.salt, first.hash), true);
  assert.equal(await verifyPassword('WrongTradingPassword!123', first.salt, first.hash), false);
});

test('opaque tokens are stored as deterministic hashes rather than plaintext', () => {
  const token = 'acg_ts_example-token-value';
  const digest = hashToken(token);
  assert.equal(digest.length, 64);
  assert.notEqual(digest, token);
  assert.equal(hashToken(token), digest);
});

test('account grants reject access outside the authenticated session', () => {
  const principal = { accountIds: ['64b000000000000000000001'] };
  assert.doesNotThrow(() => requireAccountGrant(principal, '64b000000000000000000001'));
  assert.throws(() => requireAccountGrant(principal, '64b000000000000000000002'), error => error.code === 'ACCOUNT_ACCESS_FORBIDDEN' && error.statusCode === 403);
});


function fakeSessionModel(seed) {
  let session = { ...seed };

  const matches = (query = {}, value = session) => Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some(item => matches(item, value));
    if (expected && typeof expected === 'object' && Object.prototype.hasOwnProperty.call(expected, '$exists')) {
      const exists = value[key] !== undefined;
      return exists === Boolean(expected.$exists);
    }
    if (expected === null) return value[key] == null;
    return value[key] === expected;
  });

  return {
    snapshot: () => ({ ...session }),
    findOne(query) {
      return {
        lean: async () => matches(query) ? { ...session } : null,
      };
    },
    async findOneAndUpdate(query, update) {
      if (!matches(query)) return null;
      session = { ...session, ...(update.$set || {}) };
      return { ...session };
    },
    async updateOne(query, update) {
      if (!matches(query)) return { modifiedCount: 0 };
      session = { ...session, ...(update.$set || {}) };
      return { modifiedCount: 1 };
    },
  };
}

test('refresh sessions rotate both access and refresh credentials', async () => {
  const now = new Date('2026-09-19T00:00:00.000Z');
  const oldRefresh = 'acg_tr_old-refresh-token';
  const oldAccess = 'acg_ts_old-access-token';
  const model = fakeSessionModel({
    _id: 'session-1',
    tenantId: 'tenant-1',
    tokenHash: hashToken(oldAccess),
    refreshTokenHash: hashToken(oldRefresh),
    authMethod: 'FEDERATED',
    ownerExternalRef: 'user-1',
    accountIds: ['account-1'],
    accessExpiresAt: new Date(now.getTime() + 60_000),
    idleExpiresAt: new Date(now.getTime() + 60 * 60_000),
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
    revokedAt: null,
  });
  const service = new AuthService({
    sessionModel: model,
    now: () => new Date(now),
    accessTokenTtlSeconds: 900,
    accessTokenGraceSeconds: 45,
    refreshSessionTtlSeconds: 2592000,
    idleTimeoutSeconds: 86400,
  });

  const result = await service.refreshSession({ refreshToken: oldRefresh });
  assert.match(result.accessToken, /^acg_ts_/);
  assert.match(result.refreshToken, /^acg_tr_/);
  assert.notEqual(result.refreshToken, oldRefresh);
  assert.equal(model.snapshot().tokenHash, hashToken(result.accessToken));
  assert.equal(model.snapshot().previousTokenHash, hashToken(oldAccess));
  assert.equal(model.snapshot().previousAccessExpiresAt.toISOString(), '2026-09-19T00:00:45.000Z');
  assert.equal(model.snapshot().refreshTokenHash, hashToken(result.refreshToken));
  assert.equal(result.expiresAt, '2026-09-19T00:15:00.000Z');

  const previousPrincipal = await service.authenticateSessionToken(oldAccess);
  assert.equal(previousPrincipal.sessionId, 'session-1');
});

test('legacy one-hour sessions can upgrade once into persistent refresh sessions', async () => {
  const now = new Date('2026-09-19T00:00:00.000Z');
  const oldAccess = 'acg_ts_legacy-access-token';
  const model = fakeSessionModel({
    _id: 'session-legacy',
    tenantId: 'tenant-1',
    tokenHash: hashToken(oldAccess),
    authMethod: 'FEDERATED',
    ownerExternalRef: 'user-1',
    accountIds: ['account-1'],
    expiresAt: new Date(now.getTime() + 30 * 60_000),
    revokedAt: null,
  });
  const service = new AuthService({
    sessionModel: model,
    now: () => new Date(now),
    accessTokenTtlSeconds: 900,
    accessTokenGraceSeconds: 45,
    refreshSessionTtlSeconds: 2592000,
    idleTimeoutSeconds: 86400,
  });

  const result = await service.refreshSession({ legacyAccessToken: oldAccess });
  assert.match(result.accessToken, /^acg_ts_/);
  assert.match(result.refreshToken, /^acg_tr_/);
  assert.equal(model.snapshot().expiresAt.toISOString(), '2026-10-19T00:00:00.000Z');
  assert.equal(model.snapshot().refreshTokenHash, hashToken(result.refreshToken));
});


test('rotated access tokens expire after the short overlap window', async () => {
  let nowMs = Date.parse('2026-09-19T00:00:00.000Z');
  const oldAccess = 'acg_ts_overlap-old-access';
  const oldRefresh = 'acg_tr_overlap-old-refresh';
  const model = fakeSessionModel({
    _id: 'session-overlap',
    tenantId: 'tenant-1',
    tokenHash: hashToken(oldAccess),
    refreshTokenHash: hashToken(oldRefresh),
    authMethod: 'FEDERATED',
    ownerExternalRef: 'user-1',
    accountIds: ['account-1'],
    accessExpiresAt: new Date(nowMs + 15 * 60_000),
    idleExpiresAt: new Date(nowMs + 60 * 60_000),
    expiresAt: new Date(nowMs + 30 * 24 * 60 * 60_000),
    revokedAt: null,
  });
  const service = new AuthService({
    sessionModel: model,
    now: () => new Date(nowMs),
    accessTokenTtlSeconds: 900,
    accessTokenGraceSeconds: 45,
    refreshSessionTtlSeconds: 2592000,
    idleTimeoutSeconds: 86400,
  });

  await service.refreshSession({ refreshToken: oldRefresh });
  assert.equal((await service.authenticateSessionToken(oldAccess)).sessionId, 'session-overlap');

  nowMs += 46_000;
  await assert.rejects(
    () => service.authenticateSessionToken(oldAccess),
    error => error.code === 'TRADER_SESSION_INVALID' && error.statusCode === 401,
  );
});
