'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { accountIdFromPayload, websocketAccessToken, accountGrantDiff } = require('../../src/realtime/market-ws-server');
const { createMarketWebSocketServer } = require('../../src/realtime/market-ws-server');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');

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

test('remote reconciliation coalesces bursts into authoritative snapshots for subscribed tenant accounts', async () => {
  const eventBus = new EventEmitter();
  const server = http.createServer();
  let flat = false;
  const reads = [];
  const sockets = createMarketWebSocketServer({ server, runtime: { eventBus, health: () => ({}), symbols: [], timeframes: [] },
    tradingRuntime: { valuationEngine: {} }, path: '/v1/ws', corsOrigins: [], pingIntervalMs: 10000, maxBufferBytes: 1024 * 1024,
    logger: { error() {} },
    authService: { authenticateSessionToken: async token => ({ tenantId: `tenant-${token}`, accountIds: [`account-${token}`] }) },
    traderStateService: { async snapshotAccounts({ tenantId, accountIds }) {
      reads.push({ tenantId, accountIds });
      return accountIds.map(id => ({ account: { id }, positions: flat ? [] : [{ id: `position-${id}`, accountId: id, status: 'OPEN' }], orders: [], fills: flat ? [{ id: 'closed-deal', type: 'CLOSE' }] : [] }));
    } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const clients = ['a', 'b'].map(token => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/ws`, ['acg-trader', `auth.${token}`]);
    const messages = [];
    socket.on('message', buffer => messages.push(JSON.parse(buffer)));
    return { socket, messages };
  });
  async function until(check) {
    const deadline = Date.now() + 3000;
    while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(check(), 'expected WebSocket state was not received');
  }
  try {
    await until(() => clients.every(client => client.messages.some(message => message.type === 'trading.state.snapshot')));
    eventBus.emit('trading.account.reconciled', { accountId: 'account-a', tenantId: 'tenant-b' });
    flat = true;
    for (let i = 0; i < 100; i++) eventBus.emit('trading.account.reconciled', { accountId: 'account-a', tenantId: 'tenant-a' });
    await until(() => clients[0].messages.some(message => message.data?.reason === 'remote-reconciliation'));
    const snapshot = clients[0].messages.find(message => message.data?.reason === 'remote-reconciliation').data.accounts[0];
    assert.deepEqual(snapshot.positions, []);
    assert.equal(snapshot.fills[0].type, 'CLOSE');
    assert.equal(reads.length, 3, 'two initial snapshots plus one coalesced account refresh');
    assert.equal(clients[1].messages.filter(message => message.type === 'trading.state.snapshot').length, 1);
  } finally {
    for (const { socket } of clients) socket.terminate();
    await sockets.close(); await new Promise(resolve => server.close(resolve));
  }
  assert.equal(eventBus.listenerCount('trading.account.reconciled'), 0);
});
