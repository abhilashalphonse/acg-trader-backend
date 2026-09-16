'use strict';

const { env } = require('../../config/env');
const { logger } = require('../../infrastructure/logger/logger');
const { AccountCommandQueue } = require('./account-command-queue');
const { IdempotencyService } = require('./idempotency.service');
const { MarketOrderService } = require('./market-order.service');
const { ValuationEngine } = require('./valuation-engine');

function createTradingRuntime({ marketRuntime }) {
  const commandQueue = new AccountCommandQueue();
  const idempotencyService = new IdempotencyService();
  const valuationEngine = new ValuationEngine({
    quoteStore: marketRuntime.quoteStore,
    eventBus: marketRuntime.eventBus,
    logger,
  });
  const marketOrderService = new MarketOrderService({
    quoteStore: marketRuntime.quoteStore,
    eventBus: marketRuntime.eventBus,
    commandQueue,
    idempotencyService,
    valuationEngine,
    logger,
  });

  let started = false;

  return {
    enabled: env.tradingApiEnabled,
    marketOrderService,
    valuationEngine,
    commandQueue,

    async start() {
      if (started) return;
      await valuationEngine.start();
      started = true;
    },

    health() {
      return {
        enabled: env.tradingApiEnabled,
        state: env.tradingApiEnabled ? 'DEVELOPMENT_EXECUTION_ENABLED' : 'API_DISABLED',
        started,
        pendingAccounts: commandQueue.pendingAccounts,
        valuation: valuationEngine.health(),
        capabilities: {
          marketOpen: true,
          marketClose: true,
          partialClose: true,
          realtimeValuation: true,
          accountEquity: true,
          pendingOrders: false,
          protectiveTriggers: false,
          trailing: false,
          riskEngine: false,
        },
      };
    },

    async stop() {
      await commandQueue.drainAll();
      await valuationEngine.stop();
      started = false;
    },
  };
}

module.exports = { createTradingRuntime };
