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

    const platformEvents = trading.platformEvents || {};
    const lastSuccess = Date.parse(platformEvents.lastSuccessfulDeliveryAt || '');
    const lastFailure = Date.parse(platformEvents.lastDeliveryFailureAt || '');
    const deliveryCurrentlyHealthy = !Number.isFinite(lastFailure)
      || (Number.isFinite(lastSuccess) && lastSuccess >= lastFailure);
    const platformEventsOperational = platformEvents.enabled !== true
      || (
        platformEvents.started === true
        && platformEvents.webhookConfigured === true
        && Number(platformEvents.deadEvents || 0) === 0
        && deliveryCurrentlyHealthy
      );

    const symbols = Array.isArray(market.symbols) ? market.symbols : [];
    const marketOperational = market.enabled !== true
      || (
        market.state === 'LIVE'
        && symbols.length > 0
        && symbols.every(symbol => symbol?.state === 'LIVE' && symbol?.isStale !== true)
      );

    const tradingReady = trading.enabled === false || (
      trading.started === true
      && reconciliationOperational
      && recoveryConsistent
      && platformEventsOperational
      && marketOperational
    );
    const ready = Boolean(database.connected && marketOperational && tradingReady);

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      database,
      market,
      trading,
      checks: {
        databaseConnected: Boolean(database.connected),
        marketOperational,
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
