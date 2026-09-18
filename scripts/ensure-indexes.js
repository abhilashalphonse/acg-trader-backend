'use strict';

process.env.MARKET_GATEWAY_ENABLED = 'false';

const { connectDatabase, disconnectDatabase, verifyTransactionSupport } = require('../src/config/database');
const { ensureCriticalIndexes } = require('../src/config/indexes');
const { logger } = require('../src/infrastructure/logger/logger');

async function run() {
  await connectDatabase();
  await verifyTransactionSupport();
  const models = await ensureCriticalIndexes({ logger });
  logger.info({ models }, 'MongoDB index migration complete');
  await disconnectDatabase();
}

run().catch(async error => {
  logger.fatal({ err: error }, 'MongoDB index migration failed');
  try { await disconnectDatabase(); } catch {}
  process.exit(1);
});
