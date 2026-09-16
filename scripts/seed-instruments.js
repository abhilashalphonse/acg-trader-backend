'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { logger } = require('../src/infrastructure/logger/logger');
const { syncInstrumentCatalog } = require('../src/modules/instruments/instrument-catalog.service');

async function run() {
  await connectDatabase();
  const result = await syncInstrumentCatalog({ logger });
  logger.info({ result }, 'Instrument catalog seed complete');
  await disconnectDatabase();
}

run().catch(async error => {
  logger.fatal({ err: error }, 'Instrument catalog seed failed');
  try { await disconnectDatabase(); } catch {}
  process.exit(1);
});
