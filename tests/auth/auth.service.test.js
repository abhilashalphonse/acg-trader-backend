'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { AuthService, hashPassword, verifyPassword, hashToken } = require('../../src/modules/auth/auth.service');
const { requireAccountGrant } = require('../../src/modules/auth/auth.middleware');
const { TradingAccount } = require('../../src/modules/accounts/trading-account.model');
const { TraderSession } = require('../../src/modules/auth/trader-session.model');

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


function fakeAccountModel(initialRows = []) {
  let rows = initialRows.map(row => ({ status: 'ACTIVE', tenantId: 'tenant-1', ownerExternalRef: 'user-1', ...row }));

  const matches = (row, query = {}) => Object.entries(query).every(([key, expected]) => {
    if (key === '$or') return expected.some(item => matches(row, item));
    if (expected && typeof expected === 'object' && Object.prototype.hasOwnProperty.call(expected, '$in')) {
      return expected.$in.map(String).includes(String(row[key]));
    }
    if (expected && typeof expected === 'object' && Object.prototype.hasOwnProperty.call(expected, '$ne')) {
      return String(row[key]) !== String(expected.$ne);
    }
    return String(row[key]) === String(expected);
  });

  return {
    setRows(nextRows) {
      rows = nextRows.map(row => ({ status: 'ACTIVE', tenantId: 'tenant-1', ownerExternalRef: 'user-1', ...row }));
    },
    find(query) {
      const result = rows.filter(row => matches(row, query));
      return {
        select() {
          return { lean: async () => result.map(row => ({ ...row })) };
        },
      };
    },
  };
}

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
    accountModel: fakeAccountModel([{ _id: 'account-1' }]),
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
    accountModel: fakeAccountModel([{ _id: 'account-1' }]),
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
    accountModel: fakeAccountModel([{ _id: 'account-1' }]),
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


test('session authentication throttles last-seen writes inside the touch interval', async () => {
  const now = new Date('2026-09-19T12:00:00.000Z');
  const access = 'acg_ts_touch-throttle';
  let updateCalls = 0;
  const session = {
    _id: 'session-touch',
    tenantId: 'tenant-1',
    tokenHash: hashToken(access),
    authMethod: 'FEDERATED',
    ownerExternalRef: 'user-1',
    accountIds: ['account-1'],
    accessExpiresAt: new Date(now.getTime() + 15 * 60_000),
    idleExpiresAt: new Date(now.getTime() + 23 * 60 * 60_000),
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
    lastSeenAt: new Date(now.getTime() - 15_000),
    revokedAt: null,
  };
  const model = {
    findOne() { return { lean: async () => ({ ...session }) }; },
    async updateOne() { updateCalls += 1; return { modifiedCount: 1 }; },
  };
  const service = new AuthService({
    sessionModel: model,
    accountModel: fakeAccountModel([{ _id: 'account-1' }]),
    now: () => new Date(now),
    sessionTouchIntervalSeconds: 60,
  });

  const principal = await service.authenticateSessionToken(access);
  assert.equal(principal.sessionId, 'session-touch');
  assert.equal(updateCalls, 0);
});

test('federated sessions dynamically add current owner accounts and drop disabled superseded accounts', async () => {
  const now = new Date('2026-09-19T12:00:00.000Z');
  const access = 'acg_ts_dynamic-grants';
  const session = {
    _id: 'session-dynamic',
    tenantId: 'tenant-1',
    tokenHash: hashToken(access),
    authMethod: 'FEDERATED',
    ownerExternalRef: 'user-1',
    ownerExternalRefs: ['user-1', 'legacy-user-1'],
    accountIds: ['account-1'],
    selectedAccountId: 'account-1',
    accessExpiresAt: new Date(now.getTime() + 15 * 60_000),
    idleExpiresAt: new Date(now.getTime() + 23 * 60 * 60_000),
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
    lastSeenAt: new Date(now.getTime() - 15_000),
    revokedAt: null,
  };
  const accountModel = fakeAccountModel([
    { _id: 'account-1', ownerExternalRef: 'legacy-user-1', status: 'ACTIVE' },
    { _id: 'account-2', ownerExternalRef: 'user-1', status: 'ACTIVE' },
    { _id: 'account-staged', ownerExternalRef: 'user-1', status: 'ACTIVE', federationEnabled: false },
    { _id: 'account-old-phase', ownerExternalRef: 'user-1', status: 'DISABLED' },
    { _id: 'account-other-user', ownerExternalRef: 'other-user', status: 'ACTIVE' },
  ]);
  const service = new AuthService({
    sessionModel: {
      findOne() { return { lean: async () => ({ ...session }) }; },
      async updateOne() { return { modifiedCount: 1 }; },
    },
    accountModel,
    now: () => new Date(now),
  });

  const first = await service.authenticateSessionToken(access);
  assert.deepEqual(first.accountIds, ['account-1', 'account-2']);
  assert.equal(first.selectedAccountId, 'account-1');

  accountModel.setRows([
    { _id: 'account-1', ownerExternalRef: 'legacy-user-1', status: 'DISABLED' },
    { _id: 'account-2', ownerExternalRef: 'user-1', status: 'ACTIVE' },
    { _id: 'account-3', ownerExternalRef: 'user-1', status: 'PAUSED' },
    { _id: 'account-staged', ownerExternalRef: 'user-1', status: 'ACTIVE', federationEnabled: false },
  ]);

  const second = await service.authenticateSessionToken(access);
  assert.deepEqual(second.accountIds, ['account-2']);
  assert.equal(second.selectedAccountId, 'account-2');
});

test('session authentication refreshes last-seen after the touch interval', async () => {
  const now = new Date('2026-09-19T12:00:00.000Z');
  const access = 'acg_ts_touch-due';
  let updateCalls = 0;
  const session = {
    _id: 'session-touch-due',
    tenantId: 'tenant-1',
    tokenHash: hashToken(access),
    authMethod: 'FEDERATED',
    ownerExternalRef: 'user-1',
    accountIds: ['account-1'],
    accessExpiresAt: new Date(now.getTime() + 15 * 60_000),
    idleExpiresAt: new Date(now.getTime() + 23 * 60 * 60_000),
    expiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000),
    lastSeenAt: new Date(now.getTime() - 61_000),
    revokedAt: null,
  };
  const model = {
    findOne() { return { lean: async () => ({ ...session }) }; },
    async updateOne() { updateCalls += 1; return { modifiedCount: 1 }; },
  };
  const service = new AuthService({
    sessionModel: model,
    accountModel: fakeAccountModel([{ _id: 'account-1' }]),
    now: () => new Date(now),
    sessionTouchIntervalSeconds: 60,
  });

  await service.authenticateSessionToken(access);
  assert.equal(updateCalls, 1);
});


function castWithSanitize(model, query) {
  mongoose.sanitizeFilter(query);
  model.find(query).cast(model);
}

test('trusted auth filters survive sanitizeFilter and cast cleanly', async () => {
  const previous = mongoose.get('sanitizeFilter');
  mongoose.set('sanitizeFilter', true);
  const tenantId = new mongoose.Types.ObjectId();
  const accountId = new mongoose.Types.ObjectId();

  const accountModel = {
    findOne(query) {
      castWithSanitize(TradingAccount, query);
      return {
        select() {
          return {
            lean: async () => ({
              _id: accountId,
              tenantId,
              ownerExternalRef: 'user-1',
              status: 'ACTIVE',
              tradingEnabled: true,
              federationEnabled: true,
            }),
          };
        },
      };
    },
  };
  const federationTicketModel = {
    async create(document) {
      return { ...document, _id: new mongoose.Types.ObjectId() };
    },
  };

  try {
    const service = new AuthService({ accountModel, federationTicketModel });
    const result = await service.createFederationTicket({
      tenantId: String(tenantId),
      ownerExternalRef: 'user-1',
      ownerExternalRefs: ['legacy-user-1'],
      accountIds: [String(accountId)],
      selectedAccountId: String(accountId),
    });
    assert.equal(result.selectedAccountId, String(accountId));
    assert.match(result.ticket, /^[A-Za-z0-9_-]+$/);
  } finally {
    mongoose.set('sanitizeFilter', previous);
  }
});

test('trusted federated session filters remain castable with sanitizeFilter enabled', async () => {
  const previous = mongoose.get('sanitizeFilter');
  mongoose.set('sanitizeFilter', true);
  const tenantId = new mongoose.Types.ObjectId();
  const accountId = new mongoose.Types.ObjectId();
  const now = new Date('2026-09-23T12:00:00.000Z');
  const legacyAccess = 'acg_ts_sanitize-filter-legacy';
  let session = {
    _id: new mongoose.Types.ObjectId(),
    tenantId,
    tokenHash: hashToken(legacyAccess),
    authMethod: 'FEDERATED',
    ownerExternalRef: 'user-1',
    ownerExternalRefs: ['user-1'],
    accountIds: [accountId],
    selectedAccountId: accountId,
    accessExpiresAt: new Date(now.getTime() + 15 * 60_000),
    idleExpiresAt: new Date(now.getTime() + 60 * 60_000),
    expiresAt: new Date(now.getTime() + 60 * 60_000),
    revokedAt: null,
    lastSeenAt: now,
  };

  const sessionModel = {
    findOne(query) {
      mongoose.sanitizeFilter(query);
      TraderSession.find(query).cast(TraderSession);
      return { lean: async () => ({ ...session }) };
    },
    async findOneAndUpdate(query, update) {
      mongoose.sanitizeFilter(query);
      TraderSession.find(query).cast(TraderSession);
      session = { ...session, ...(update.$set || {}) };
      return { ...session };
    },
    async updateOne() {
      return { modifiedCount: 1 };
    },
  };

  const accountRow = {
    _id: accountId,
    tenantId,
    accountCode: 'ACGTEST',
    accountType: 'CHALLENGE',
    ownerExternalRef: 'user-1',
    currency: 'USD',
    leverage: 100,
    status: 'ACTIVE',
    tradingEnabled: true,
    federationEnabled: true,
    state: { initialBalance: '10000', balance: '10000', equity: '10000' },
    riskPolicy: {},
    metadata: new Map([['fundedAccountId', 'ACG-TEST']]),
  };
  const accountModel = {
    find(query) {
      castWithSanitize(TradingAccount, query);
      return {
        select() {
          return { lean: async () => [{ ...accountRow }] };
        },
      };
    },
  };

  try {
    const service = new AuthService({
      sessionModel,
      accountModel,
      now: () => new Date(now),
      accessTokenTtlSeconds: 900,
      refreshSessionTtlSeconds: 2592000,
      idleTimeoutSeconds: 86400,
    });

    const refreshed = await service.refreshSession({ legacyAccessToken: legacyAccess });
    assert.match(refreshed.accessToken, /^acg_ts_/);
    assert.deepEqual(refreshed.session.accountIds, [String(accountId)]);

    const principal = await service.authenticateSessionToken(refreshed.accessToken);
    assert.deepEqual(principal.accountIds, [String(accountId)]);

    const granted = await service.listGrantedAccounts(principal);
    assert.equal(granted.accounts.length, 1);
    assert.equal(granted.accounts[0].id, String(accountId));
  } finally {
    mongoose.set('sanitizeFilter', previous);
  }
});
