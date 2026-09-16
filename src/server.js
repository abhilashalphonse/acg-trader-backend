'use strict';

const http = require('http');
const { env } = require('./config/env');
const { connectDatabase, disconnectDatabase } = require('./config/database');
const { logger } = require('./infrastructure/logger/logger');
const { createApp } = require('./app');

async function start() {
  await connectDatabase();

  const app = createApp();
  const server = http.createServer(app);

  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  server.listen(env.port, () => {
    logger.info({ port: env.port }, 'ACG Trader backend listening');
  });

  let shuttingDown = false;
  const shutdown = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown started');

    const forceTimer = setTimeout(() => {
      logger.fatal('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, env.shutdownTimeoutMs);
    forceTimer.unref();

    server.close(async error => {
      if (error) logger.error({ err: error }, 'HTTP server close failed');
      try {
        await disconnectDatabase();
        logger.info('Graceful shutdown complete');
        process.exit(error ? 1 : 0);
      } catch (disconnectError) {
        logger.error({ err: disconnectError }, 'MongoDB disconnect failed');
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(error => {
  logger.fatal({ err: error }, 'ACG Trader backend failed to start');
  process.exit(1);
});
