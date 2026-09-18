'use strict';

process.env.MARKET_GATEWAY_ENABLED = 'false';
process.env.PLATFORM_EVENTS_ENABLED = 'false';

const { connectDatabase, disconnectDatabase, verifyTransactionSupport } = require('../src/config/database');
const { ensureCriticalIndexes } = require('../src/config/indexes');
const { createMarketRuntime } = require('../src/modules/market-data/market.runtime');
const { createTradingRuntime } = require('../src/modules/trading/trading.runtime');

async function run() {
  await connectDatabase();
  await verifyTransactionSupport();
  await ensureCriticalIndexes();

  const marketRuntime = createMarketRuntime();
  const tradingRuntime = createTradingRuntime({ marketRuntime });

  await tradingRuntime.start();
  const health = tradingRuntime.health();
  if (!health.started) throw new Error('Trading runtime did not start');

  await tradingRuntime.stop();
  await marketRuntime.stop();
  await disconnectDatabase();
  process.stdout.write('Runtime smoke test passed\n');
}

run().catch(async error => {
  console.error(error);
  try { await disconnectDatabase(); } catch {}
  process.exit(1);
});
