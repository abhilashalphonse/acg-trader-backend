'use strict';

const http = require('http');
const { env } = require('./config/env');
const { connectDatabase, verifyTransactionSupport, disconnectDatabase } = require('./config/database');
const { ensureCriticalIndexes } = require('./config/indexes');
const { logger } = require('./infrastructure/logger/logger');
const { createApp } = require('./app');
const { createMarketRuntime } = require('./modules/market-data/market.runtime');
const { createTradingRuntime } = require('./modules/trading/trading.runtime');
const { createAuthRuntime } = require('./modules/auth/auth.runtime');
const { syncInstrumentCatalog, provisionCatalogExecution } = require('./modules/instruments/instrument-catalog.service');

async function start() {
  await connectDatabase();
  if (env.tradingApiEnabled) {
    await verifyTransactionSupport();
    await ensureCriticalIndexes({ logger });
  }
  if (env.instrumentCatalogAutoSeed) await syncInstrumentCatalog({ logger });
  if (env.tradingApiEnabled) await provisionCatalogExecution({ logger });

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

  let shuttingDown = false;
  const shutdown = async signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown started');
    const forceTimer = setTimeout(() => {
      logger.fatal('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, env.shutdownTimeoutMs);
    forceTimer.unref();

    let exitCode = 0;
    try {
      const httpClosed = closeHttpServer(server);
      server.closeIdleConnections?.();

      // Stop new realtime/market work first. QuoteStore remains available to
      // HTTP commands that were already accepted before server.close().
      await marketRuntime.stop();
      await httpClosed;

      // No new commands can enter after HTTP/WS are drained, so trading can
      // safely wait for command queues and durable event delivery.
      await tradingRuntime.stop();
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

  server.on('error', error => {
    logger.error({ err: error }, 'HTTP server error');
    if (!shuttingDown) void shutdown('HTTP_SERVER_ERROR');
  });

  await listenHttpServer(server, env.port);
  logger.info({ port: env.port, market: marketRuntime.health(), trading: tradingRuntime.health() }, 'ACG Trader backend listening');

  process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
  process.on('SIGINT', () => { void shutdown('SIGINT'); });
  process.on('unhandledRejection', error => {
    logger.fatal({ err: error }, 'Unhandled promise rejection');
    void shutdown('UNHANDLED_REJECTION');
  });
  process.on('uncaughtException', error => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('UNCAUGHT_EXCEPTION');
  });
}

function listenHttpServer(server, port) {
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}

function closeHttpServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) return resolve();
    server.close(error => error ? reject(error) : resolve());
  });
}

start().catch(async error => {
  logger.fatal({ err: error }, 'ACG Trader backend failed to start');
  try { await disconnectDatabase(); } catch {}
  process.exit(1);
});
