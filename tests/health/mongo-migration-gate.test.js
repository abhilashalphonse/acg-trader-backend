'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { createMaintenanceHandler } = require('../../src/infrastructure/maintenance/maintenance-server');

test('maintenance healthcheck stays reachable while all trading endpoints return 503', async () => {
  const server = http.createServer(createMaintenanceHandler());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const health = await fetch(`http://127.0.0.1:${port}/health/ready`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).tradingEnabled, false);
    const trading = await fetch(`http://127.0.0.1:${port}/v1/trading/orders`, {method: 'POST'});
    assert.equal(trading.status, 503);
    assert.equal(trading.headers.get('retry-after'), '300');
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});

function envTarget(extra = {}) {
  return execFileSync(process.execPath, ['-e', 'process.stdout.write(require("./src/config/env").env.mongoTarget)'], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test', MONGODB_URI: 'mongodb://atlas.local/acg_trader',
      MARKET_GATEWAY_ENABLED: 'false', TRADING_API_ENABLED: 'false', PLATFORM_EVENTS_ENABLED: 'false',
      SUPABASE_IDENTITY_BOOTSTRAP_ENABLED: 'false', SUPABASE_TRADING_SESSIONS_ENABLED: 'false',
      ACG_PERSONAL_DEMO_ENABLED: 'false', ...extra },
  });
}
test('database target defaults to Atlas and can switch to Railway without overwriting Atlas URI', () => {
  assert.equal(envTarget({ ACG_MONGO_RAILWAY_CUTOVER: 'false' }), 'atlas');
  assert.equal(envTarget({ ACG_MONGO_RAILWAY_CUTOVER: 'true', RAILWAY_MONGODB_URI: 'mongodb://railway.local/acg_trader' }), 'railway');
});
test('cutover rejects missing Railway connection', () => {
  assert.throws(() => envTarget({ ACG_MONGO_RAILWAY_CUTOVER: 'true', RAILWAY_MONGODB_URI: '' }));
});
