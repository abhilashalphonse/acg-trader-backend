'use strict';

const { env } = require('../../config/env');
const { logger } = require('../../infrastructure/logger/logger');
const { AccountCommandQueue } = require('./account-command-queue');
const { IdempotencyService } = require('./idempotency.service');
const { MarketOrderService } = require('./market-order.service');
const { ValuationEngine } = require('./valuation-engine');
const { ProtectionTriggerEngine } = require('./protection-trigger-engine');
const { PendingOrderService } = require('./pending-order.service');
const { PendingOrderEngine } = require('./pending-order-engine');
const { PositionProtectionService } = require('./position-protection.service');

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
  const pendingOrderService = new PendingOrderService({
    quoteStore: marketRuntime.quoteStore,
    eventBus: marketRuntime.eventBus,
    commandQueue,
    idempotencyService,
    valuationEngine,
    logger,
  });
  const pendingOrderEngine = new PendingOrderEngine({
    eventBus: marketRuntime.eventBus,
    pendingOrderService,
    logger,
  });
  const positionProtectionService = new PositionProtectionService({
    quoteStore: marketRuntime.quoteStore,
    eventBus: marketRuntime.eventBus,
    commandQueue,
    idempotencyService,
    logger,
  });

  let started = false;

  return {
    enabled: env.tradingApiEnabled,
    marketOrderService,
    pendingOrderService,
    positionProtectionService,
    valuationEngine,
    protectionTriggerEngine,
    pendingOrderEngine,
    commandQueue,

    async start() {
      if (started) return;
      await valuationEngine.start();
      try {
        await protectionTriggerEngine.start();
        try {
          await pendingOrderEngine.start();
          started = true;
        } catch (error) {
          await protectionTriggerEngine.stop();
          throw error;
        }
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
        pendingOrders: pendingOrderEngine.health(),
        capabilities: {
          marketOpen: true,
          marketClose: true,
          partialClose: true,
          realtimeValuation: true,
          accountEquity: true,
          pendingOrders: true,
          limitOrders: true,
          stopOrders: true,
          stopLimitOrders: true,
          pendingOrderExpiry: true,
          pendingOrderCancel: true,
          protectiveTriggers: true,
          stopLoss: true,
          takeProfit: true,
          protectionManagement: true,
          breakEven: true,
          trailing: false,
          riskEngine: false,
        },
      };
    },

    async stop() {
      await pendingOrderEngine.stop();
      await protectionTriggerEngine.stop();
      await commandQueue.drainAll();
      await valuationEngine.stop();
      started = false;
    },
  };
}

module.exports = { createTradingRuntime };
