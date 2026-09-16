'use strict';

const express = require('express');
const { databaseHealth } = require('../../config/database');

function createHealthRouter({ marketRuntime } = {}) {
  const router = express.Router();

  router.get('/live', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'acg-trader-backend',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/ready', (_req, res) => {
    const database = databaseHealth();
    const ready = database.connected;

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      database,
      market: marketRuntime?.health?.() || { enabled: false, state: 'NOT_INITIALIZED' },
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

module.exports = { createHealthRouter };
