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
    const platformEventsOperational = platformEvents.enabled === true
      && platformEvents.started === true
      && platformEvents.webhookConfigured === true
      && Number(platformEvents.deadEvents || 0) === 0
      && deliveryCurrentlyHealthy;

    const marketReadiness = evaluateMarketReadiness(market);
    const marketOperational = marketReadiness.operational;

    const tradingReady = trading.enabled === true
      && trading.started === true
      && reconciliationOperational
      && recoveryConsistent
      && platformEventsOperational
      && marketOperational;
    const ready = Boolean(database.connected && marketOperational && tradingReady);

    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      database,
      market,
      trading,
      checks: {
        databaseConnected: Boolean(database.connected),
        marketOperational,
        marketGatewayLive: marketReadiness.gatewayLive,
        marketSymbolsConfigured: marketReadiness.symbolsConfigured,
        marketSubscriptionErrors: marketReadiness.subscriptionErrorCount,
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

function evaluateMarketReadiness(market) {
  if (market?.enabled !== true) {
    return {
      operational: false,
      gatewayLive: false,
      symbolsConfigured: false,
      symbolCount: 0,
      subscriptionErrorCount: 0,
    };
  }

  const symbols = Array.isArray(market.symbols) ? market.symbols : [];
  const subscriptionErrorCount = symbols.filter(symbol => symbol?.state === 'SUBSCRIPTION_ERROR').length;
  const gatewayLive = market.state === 'LIVE';
  const symbolsConfigured = symbols.length > 0;
  const allSubscriptionsFailed = symbolsConfigured && subscriptionErrorCount === symbols.length;

  // Service readiness represents whether the centralized market gateway is
  // available, not whether every market is currently trading. A 300-symbol
  // universe spans different sessions, so WAITING/STALE symbols are expected
  // outside their trading hours. Per-symbol session and quote freshness remain
  // hard requirements in the execution planner.
  return {
    operational: gatewayLive && symbolsConfigured && !allSubscriptionsFailed,
    gatewayLive,
    symbolsConfigured,
    symbolCount: symbols.length,
    subscriptionErrorCount,
  };
}

module.exports = { createHealthRouter, evaluateMarketReadiness };
