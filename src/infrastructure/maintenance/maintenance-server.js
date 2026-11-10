'use strict';

const http = require('http');

function createMaintenanceHandler() {
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.url?.split('?')[0] === '/health/ready') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'maintenance', tradingEnabled: false, databaseWritesEnabled: false }));
      return;
    }
    res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '300' });
    res.end(JSON.stringify({ status: 'maintenance', message: 'Trading is temporarily unavailable during a database migration.' }));
  };
}

async function startMaintenanceServer({ port, logger }) {
  const server = http.createServer(createMaintenanceHandler());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => { server.off('error', reject); resolve(); });
  });
  logger.warn({ port }, 'ACG database migration maintenance mode active; MongoDB and trading engines are not started');
  const shutdown = signal => {
    logger.info({ signal }, 'ACG migration maintenance server shutting down');
    server.close(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  return server;
}

module.exports = { createMaintenanceHandler, startMaintenanceServer };
