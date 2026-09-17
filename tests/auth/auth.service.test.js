'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword, hashToken } = require('../../src/modules/auth/auth.service');
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
