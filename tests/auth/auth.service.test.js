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
  return {
    snapshot: () => ({ ...session }),
    findOne(query) {
      return {
        lean: async () => {
          if (query.refreshTokenHash && query.refreshTokenHash !== session.refreshTokenHash) return null;
          if (query.tokenHash && query.tokenHash !== session.tokenHash) return null;
          if (query.revokedAt === null && session.revokedAt != null) return null;
          if (query.$or && session.refreshTokenHash != null) return null;
          return { ...session };
        },
      };
    },
    async findOneAndUpdate(query, update) {
      if (query.refreshTokenHash && query.refreshTokenHash !== session.refreshTokenHash) return null;
      if (query.tokenHash && query.tokenHash !== session.tokenHash) return null;
      if (query.$or && session.refreshTokenHash != null) return null;
      session = { ...session, ...(update.$set || {}) };
      return { ...session };
    },
    async updateOne(_query, update) {
      session = { ...session, ...(update.$set || {}) };
      return { modifiedCount: 1 };
    },
  };
}

test('refresh sessions rotate both access and refresh credentials', async () => {
  const now = new Date('2026-09-19T00:00:00.000Z');
  const oldRefresh = 'acg_tr_old-refresh-token';
  const model = fakeSessionModel({
    _id: 'session-1',
    tenantId: 'tenant-1',
    tokenHash: hashToken('acg_ts_old-access-token'),
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
    refreshSessionTtlSeconds: 2592000,
    idleTimeoutSeconds: 86400,
  });

  const result = await service.refreshSession({ refreshToken: oldRefresh });
  assert.match(result.accessToken, /^acg_ts_/);
  assert.match(result.refreshToken, /^acg_tr_/);
  assert.notEqual(result.refreshToken, oldRefresh);
  assert.equal(model.snapshot().tokenHash, hashToken(result.accessToken));
  assert.equal(model.snapshot().refreshTokenHash, hashToken(result.refreshToken));
  assert.equal(result.expiresAt, '2026-09-19T00:15:00.000Z');
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
    refreshSessionTtlSeconds: 2592000,
    idleTimeoutSeconds: 86400,
  });

  const result = await service.refreshSession({ legacyAccessToken: oldAccess });
  assert.match(result.accessToken, /^acg_ts_/);
  assert.match(result.refreshToken, /^acg_tr_/);
  assert.equal(model.snapshot().expiresAt.toISOString(), '2026-10-19T00:00:00.000Z');
  assert.equal(model.snapshot().refreshTokenHash, hashToken(result.refreshToken));
});
