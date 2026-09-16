'use strict';

const { env } = require('../../config/env');
const { logger } = require('../../infrastructure/logger/logger');
const { AccountCommandQueue } = require('./account-command-queue');
const { IdempotencyService } = require('./idempotency.service');
const { MarketOrderService } = require('./market-order.service');
const { ValuationEngine } = require('./valuation-engine');
const { ProtectionTriggerEngine } = require('./protection-trigger-engine');

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
  const protectionTriggerEngine = new ProtectionTriggerEngine({
    eventBus: marketRuntime.eventBus,
    marketOrderService,
    logger,
  });

  let started = false;

  return {
    enabled: env.tradingApiEnabled,
    marketOrderService,
    valuationEngine,
    protectionTriggerEngine,
    commandQueue,

    async start() {
      if (started) return;
      await valuationEngine.start();
      try {
        await protectionTriggerEngine.start();
        started = true;
      } catch (error) {
        await valuationEngine.stop();
        throw error;
      }
    },

    health() {
      return {
        enabled: env.tradingApiEnabled,
        state: env.tradingApiEnabled ? 'DEVELOPMENT_EXECUTION_ENABLED' : 'API_DISABLED',
        started,
        pendingAccounts: commandQueue.pendingAccounts,
        valuation: valuationEngine.health(),
        protection: protectionTriggerEngine.health(),
        capabilities: {
          marketOpen: true,
          marketClose: true,
          partialClose: true,
          realtimeValuation: true,
          accountEquity: true,
          pendingOrders: false,
          protectiveTriggers: true,
          stopLoss: true,
          takeProfit: true,
          trailing: false,
          riskEngine: false,
        },
      };
    },

    async stop() {
      await protectionTriggerEngine.stop();
      await commandQueue.drainAll();
      await valuationEngine.stop();
      started = false;
    },
  };
}

module.exports = { createTradingRuntime };
