'use strict';

const express = require('express');
const { databaseHealth } = require('../../config/database');

function createHealthRouter({ marketRuntime, tradingRuntime } = {}) {
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
    const market = marketRuntime?.health?.() || { enabled: false, state: 'NOT_INITIALIZED' };
    const trading = tradingRuntime?.health?.() || { enabled: false, started: false, state: 'NOT_INITIALIZED' };
    const reconciliationOperational = trading.reconciliation?.state !== 'DEGRADED';
    const recoveryConsistent = trading.reconciliation?.recovery?.consistent !== false;
    const platformEventsOperational = trading.platformEvents?.enabled !== true
      || (trading.platformEvents?.started === true && trading.platformEvents?.webhookConfigured === true);
    const tradingReady = trading.enabled === false || (
      trading.started === true
      && reconciliationOperational
      && recoveryConsistent
      && platformEventsOperational
    );
    const ready = Boolean(database.connected && tradingReady);

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      database,
      market,
      trading,
      checks: {
        databaseConnected: Boolean(database.connected),
        tradingRuntimeReady: tradingReady,
        reconciliationOperational,
        recoveryConsistent: trading.reconciliation?.recovery?.consistent ?? null,
        platformEventsOperational,
      },
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}

module.exports = { createHealthRouter };
