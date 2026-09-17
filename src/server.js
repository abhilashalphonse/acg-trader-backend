'use strict';

const http = require('http');
const { env } = require('./config/env');
const { connectDatabase, disconnectDatabase } = require('./config/database');
const { logger } = require('./infrastructure/logger/logger');
const { createApp } = require('./app');
const { createMarketRuntime } = require('./modules/market-data/market.runtime');
const { createTradingRuntime } = require('./modules/trading/trading.runtime');
const { createAuthRuntime } = require('./modules/auth/auth.runtime');
const { ensureInstrumentCatalog } = require('./modules/instruments/instrument-catalog.service');

async function start() {
  await connectDatabase();
  if (env.instrumentCatalogAutoSeed) await ensureInstrumentCatalog({ logger });

  const marketRuntime = createMarketRuntime();
  const tradingRuntime = createTradingRuntime({ marketRuntime });
  const authRuntime = createAuthRuntime();

  await tradingRuntime.start();
  await marketRuntime.start();

  const app = createApp({ marketRuntime, tradingRuntime, authRuntime });
  const server = http.createServer(app);
  marketRuntime.attachWebSocket(server, authRuntime.authService, tradingRuntime);

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.listen(env.port, () => logger.info({ port: env.port, market: marketRuntime.health(), trading: tradingRuntime.health() }, 'ACG Trader backend listening'));

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown started');
    const forceTimer = setTimeout(() => { logger.fatal('Graceful shutdown timed out; forcing exit'); process.exit(1); }, env.shutdownTimeoutMs);
    forceTimer.unref();
    let exitCode = 0;
    try {
      await tradingRuntime.stop();
      await marketRuntime.stop();
      await closeHttpServer(server);
      await disconnectDatabase();
      logger.info('Graceful shutdown complete');
    } catch (error) {
      exitCode = 1;
      logger.error({ err: error }, 'Graceful shutdown failed');
    } finally {
      clearTimeout(forceTimer);
      process.exit(exitCode);
    }
  };
  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
}

function closeHttpServer(server) { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }

start().catch(error => { logger.fatal({ err: error }, 'ACG Trader backend failed to start'); process.exit(1); });
