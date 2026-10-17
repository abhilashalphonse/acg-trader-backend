'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { WebSocket } = require('ws');
const { createMarketWebSocketServer } = require('../../src/realtime/market-ws-server');

test('existing Supabase WebSocket loses revoked account subscriptions without reconnecting', async () => {
  const server = http.createServer();
  const eventBus = new EventEmitter();
  let allowed = true, authChecks = 0;
  const tenantId = '64b000000000000000000001';
  const accountId = '64b000000000000000000010';
  const sockets = createMarketWebSocketServer({
    server,
    runtime: { eventBus, health: () => ({}), symbols: [], timeframes: [] },
    tradingRuntime: { valuationEngine: {} },
    path: '/v1/ws', corsOrigins: [], pingIntervalMs: 10_000, maxBufferBytes: 1_000_000,
    logger: { error() {}, warn() {}, debug() {} },
    authService: { async authenticateSessionToken() {
      authChecks++;
      return { tenantId, sessionId: 'session-1', authMethod: 'SUPABASE',
        accountIds: allowed ? [accountId] : [], selectedAccountId: allowed ? accountId : null,
        expiresAt: new Date(Date.now() + 120_000).toISOString() };
    } },
    traderStateService: { async snapshotAccounts({ accountIds }) {
      return accountIds.map(id => ({ account: { id }, orders: [], positions: [], fills: [] }));
    } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/ws`,
    ['acg-trader', 'auth.acg_ts_test-token']);
  const messages = [];
  client.on('message', buffer => messages.push(JSON.parse(buffer)));
  const until = async predicate => {
    const deadline = Date.now() + 6500;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(predicate(), 'Timed out waiting for WebSocket grant reconciliation');
  };
  try {
    await until(() => messages.some(m => m.type === 'trading.state.snapshot'));
    allowed = false;
    await until(() => messages.some(m => m.type === 'trading.account.grants' && m.data.removed.includes(accountId)));
    assert.ok(authChecks >= 2, 'Grant checker must run again after connection');
    const before = messages.filter(m => m.type === 'trading.account').length;
    eventBus.emit('trading.account.updated', { accountId, status: 'ACTIVE' });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(messages.filter(m => m.type === 'trading.account').length, before);
    assert.equal(client.readyState, WebSocket.OPEN, 'Remaining session may continue without account access');
    client.send(JSON.stringify({ action: 'snapshot', params: { accounts: [accountId] } }));
    await until(() => messages.some(m => m.type === 'error' && m.data.code === 'ACCOUNT_ACCESS_FORBIDDEN'));
  } finally {
    client.terminate();
    await sockets.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('disabled Supabase session closes existing live socket', async () => {
  const server = http.createServer();
  const eventBus = new EventEmitter();
  let disabled = false;
  const sockets = createMarketWebSocketServer({
    server, runtime: { eventBus, health: () => ({}), symbols: [], timeframes: [] },
    tradingRuntime: { valuationEngine: {} }, path: '/v1/ws', corsOrigins: [],
    pingIntervalMs: 10_000, maxBufferBytes: 1_000_000,
    logger: { warn() {}, error() {}, debug() {} },
    authService: { async authenticateSessionToken() {
      if (disabled) throw Object.assign(new Error('Revoked'), { code: 'AUTH_INVALID' });
      return { tenantId: '64b000000000000000000001', authMethod: 'SUPABASE', accountIds: [],
        expiresAt: new Date(Date.now() + 120_000).toISOString() };
    } },
    traderStateService: { async snapshotAccounts() { return []; } },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/v1/ws`, ['acg-trader', 'auth.acg_ts_test-token']);
  try {
    await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    disabled = true;
    const code = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Revocation did not close socket')), 6500);
      client.once('close', code => { clearTimeout(timeout); resolve(code); });
    });
    assert.equal(code, 4003);
  } finally {
    client.terminate();
    await sockets.close();
    await new Promise(resolve => server.close(resolve));
  }
});
