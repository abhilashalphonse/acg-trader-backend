'use strict';

const { env } = require('../../config/env');
const { logger } = require('../../infrastructure/logger/logger');
const { AccountCommandQueue } = require('./account-command-queue');
const { IdempotencyService } = require('./idempotency.service');
const { MarketOrderService } = require('./market-order.service');

function createTradingRuntime({ marketRuntime }) {
  const commandQueue = new AccountCommandQueue();
  const idempotencyService = new IdempotencyService();
  const marketOrderService = new MarketOrderService({
    quoteStore: marketRuntime.quoteStore,
    eventBus: marketRuntime.eventBus,
    commandQueue,
    idempotencyService,
    logger,
  });

  return {
    enabled: env.tradingApiEnabled,
    marketOrderService,
    commandQueue,
    health() {
      return {
        enabled: env.tradingApiEnabled,
        state: env.tradingApiEnabled ? 'DEVELOPMENT_EXECUTION_ENABLED' : 'API_DISABLED',
        pendingAccounts: commandQueue.pendingAccounts,
        capabilities: {
          marketOpen: true,
          marketClose: true,
          partialClose: true,
          pendingOrders: false,
          protectiveTriggers: false,
          trailing: false,
          riskEngine: false,
        },
      };
    },
    async stop() {
      await commandQueue.drainAll();
    },
  };
}

module.exports = { createTradingRuntime };
