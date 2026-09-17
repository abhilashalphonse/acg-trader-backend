'use strict';

const { env } = require('../../config/env');
const { logger } = require('../../infrastructure/logger/logger');
const { AccountCommandQueue } = require('./account-command-queue');
const { IdempotencyService } = require('./idempotency.service');
const { MarketOrderService } = require('./market-order.service');
const { TradingCommandService } = require('./trading-command.service');
const { AccountControlService } = require('./account-control.service');
const { AccountLedgerService } = require('../accounts/account-ledger.service');
const { PlatformEventRelay } = require('../integration/platform-event-relay');
const { ReconciliationService } = require('../operations/reconciliation.service');
const { ValuationEngine } = require('./valuation-engine');
const { CurrencyConversionEngine, setDefaultCurrencyConversionEngine } = require('./currency-conversion-engine');
const { ProtectionTriggerEngine } = require('./protection-trigger-engine');
const { PendingOrderService } = require('./pending-order.service');
const { PendingOrderEngine } = require('./pending-order-engine');
const { PositionProtectionService } = require('./position-protection.service');
const { TrailingStopService } = require('./trailing-stop.service');
const { TrailingStopEngine } = require('./trailing-stop-engine');

function createTradingRuntime({ marketRuntime }) {
  const commandQueue = new AccountCommandQueue();
  const idempotencyService = new IdempotencyService();
  const currencyConversionEngine = new CurrencyConversionEngine({
    quoteStore: marketRuntime.quoteStore,
    symbols: marketRuntime.symbols,
    maxQuoteAgeMs: env.market.defaultMaxQuoteAgeMs,
  });
  setDefaultCurrencyConversionEngine(currencyConversionEngine);

  const valuationEngine = new ValuationEngine({
    quoteStore: marketRuntime.quoteStore,
    eventBus: marketRuntime.eventBus,
    currencyConverter: currencyConversionEngine,
    logger,
  });
  const marketOrderService = new MarketOrderService({ quoteStore: marketRuntime.quoteStore, eventBus: marketRuntime.eventBus, commandQueue, idempotencyService, valuationEngine, logger });
  const tradingCommandService = new TradingCommandService({ marketOrderService, logger });
  const accountControlService = new AccountControlService({ eventBus: marketRuntime.eventBus, commandQueue, marketOrderService, logger });
  const accountLedgerService = new AccountLedgerService({ eventBus: marketRuntime.eventBus, commandQueue, logger });
  const platformEventRelay = new PlatformEventRelay({
    eventBus: marketRuntime.eventBus,
    enabled: env.platformEvents.enabled,
    webhookUrl: env.platformEvents.webhookUrl,
    webhookSecret: env.platformEvents.webhookSecret,
    pollIntervalMs: env.platformEvents.pollIntervalMs,
    timeoutMs: env.platformEvents.timeoutMs,
    batchSize: env.platformEvents.batchSize,
    maxAttempts: env.platformEvents.maxAttempts,
    logger,
  });
  const protectionTriggerEngine = new ProtectionTriggerEngine({ eventBus: marketRuntime.eventBus, marketOrderService, logger });
  const pendingOrderService = new PendingOrderService({ quoteStore: marketRuntime.quoteStore, eventBus: marketRuntime.eventBus, commandQueue, idempotencyService, valuationEngine, logger });
  const pendingOrderEngine = new PendingOrderEngine({ eventBus: marketRuntime.eventBus, pendingOrderService, logger });
  const positionProtectionService = new PositionProtectionService({ quoteStore: marketRuntime.quoteStore, eventBus: marketRuntime.eventBus, commandQueue, idempotencyService, logger });
  const trailingStopService = new TrailingStopService({ quoteStore: marketRuntime.quoteStore, eventBus: marketRuntime.eventBus, commandQueue, idempotencyService, logger });
  const trailingStopEngine = new TrailingStopEngine({ eventBus: marketRuntime.eventBus, trailingStopService, logger });
  const reconciliationService = new ReconciliationService({
    commandQueue,
    valuationEngine,
    pendingOrderEngine,
    protectionTriggerEngine,
    trailingStopEngine,
    logger,
  });
  let started = false;

  return {
    enabled: env.tradingApiEnabled,
    marketOrderService,
    tradingCommandService,
    accountControlService,
    accountLedgerService,
    platformEventRelay,
    pendingOrderService,
    positionProtectionService,
    trailingStopService,
    valuationEngine,
    currencyConversionEngine,
    protectionTriggerEngine,
    pendingOrderEngine,
    trailingStopEngine,
    reconciliationService,
    commandQueue,
    async start() {
      if (started) return;
      await valuationEngine.start();
      try {
        await platformEventRelay.start();
        try {
          await protectionTriggerEngine.start();
          try {
            await pendingOrderEngine.start();
            try {
              await trailingStopEngine.start();
              started = true;
              await reconciliationService.verifyRecovery({ persist: true });
              if (env.reconciliation.enabled) reconciliationService.startPeriodic(env.reconciliation.intervalMs);
            } catch (error) { await pendingOrderEngine.stop(); throw error; }
          } catch (error) { await protectionTriggerEngine.stop(); throw error; }
        } catch (error) { await platformEventRelay.stop(); throw error; }
      } catch (error) { await valuationEngine.stop(); throw error; }
    },
    health() {
      const reconciliation = reconciliationService.health();
      const recoveryConsistent = reconciliation.recovery == null || reconciliation.recovery.consistent !== false;
      const integrityHealthy = !['DEGRADED', 'ISSUES'].includes(reconciliation.state);
      return {
        enabled: env.tradingApiEnabled,
        state: !env.tradingApiEnabled ? 'API_DISABLED' : (!started ? 'STARTING' : (recoveryConsistent && integrityHealthy ? 'READY' : 'DEGRADED')),
        started,
        pendingAccounts: commandQueue.pendingAccounts,
        valuation: valuationEngine.health(),
        platformEvents: platformEventRelay.health(),
        protection: protectionTriggerEngine.health(),
        pendingOrders: pendingOrderEngine.health(),
        trailing: trailingStopEngine.health(),
        reconciliation,
        capabilities: {
          accountProvisioning: true, accountLifecycleAudit: true, accountLedger: true, accountBalanceAdjustments: true,
          accountPauseResume: true, accountDisable: true, accountBreach: true, accountClose: true, accountLiquidation: true,
          platformEventRelay: true, signedPlatformWebhooks: true,
          instrumentMaster: true, tradingSessions: true, tradingHolidays: true,
          accountCurrencyConversion: true, crossCurrencyMargin: true, crossCurrencyPnl: true,
          marketOpen: true, marketClose: true, partialClose: true, serverReverse: true, serverCloseAll: true, realtimeValuation: true, accountEquity: true,
          pendingOrders: true, limitOrders: true, stopOrders: true, stopLimitOrders: true, pendingOrderExpiry: true, pendingOrderCancel: true,
          protectiveTriggers: true, stopLoss: true, takeProfit: true, protectionManagement: true, breakEven: true, trailing: true,
          reconciliation: true, periodicReconciliation: env.reconciliation.enabled, immutableReconciliationReports: true, recoveryVerification: true,
          riskEngine: false,
        },
      };
    },
    async stop() {
      reconciliationService.stopPeriodic();
      await trailingStopEngine.stop();
      await pendingOrderEngine.stop();
      await protectionTriggerEngine.stop();
      await platformEventRelay.stop();
      await commandQueue.drainAll();
      await valuationEngine.stop();
      setDefaultCurrencyConversionEngine(null);
      started = false;
    },
  };
}

module.exports = { createTradingRuntime };
