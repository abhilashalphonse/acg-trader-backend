'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { accountIdFromPayload, websocketAccessToken, accountGrantDiff } = require('../../src/realtime/market-ws-server');

const ACCOUNT_ID = '64b000000000000000000010';

test('accountIdFromPayload resolves every realtime trading envelope shape', () => {
  assert.equal(accountIdFromPayload({ accountId: ACCOUNT_ID }), ACCOUNT_ID);
  assert.equal(accountIdFromPayload({ order: { accountId: ACCOUNT_ID } }), ACCOUNT_ID);
  assert.equal(accountIdFromPayload({ fill: { accountId: ACCOUNT_ID } }), ACCOUNT_ID);
  assert.equal(accountIdFromPayload({ position: { accountId: ACCOUNT_ID } }), ACCOUNT_ID);
  assert.equal(accountIdFromPayload({ account: { id: ACCOUNT_ID } }), ACCOUNT_ID);
  assert.equal(accountIdFromPayload({ id: ACCOUNT_ID }), ACCOUNT_ID);
  assert.equal(accountIdFromPayload({}), null);
});

test('websocketAccessToken reads only the auth subprotocol token', () => {
  const token = websocketAccessToken({ headers: { 'sec-websocket-protocol': 'acg-trader, auth.acg_ts_secret123' } });
  assert.equal(token, 'acg_ts_secret123');
  assert.equal(websocketAccessToken({ headers: { 'sec-websocket-protocol': 'acg-trader' } }), null);
});


test('accountGrantDiff identifies newly granted and revoked account ids', () => {
  const result = accountGrantDiff(
    new Set(['account-1', 'account-old']),
    new Set(['account-1', 'account-2', 'account-3']),
  );
  assert.deepEqual(result.added, ['account-2', 'account-3']);
  assert.deepEqual(result.removed, ['account-old']);
});
