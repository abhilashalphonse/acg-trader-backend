'use strict';

const { env } = require('../../config/env');
const { logger } = require('../../infrastructure/logger/logger');
const { AccountCommandQueue } = require('./account-command-queue');
const { IdempotencyService } = require('./idempotency.service');
const { MarketOrderService } = require('./market-order.service');
const { AtomicReverseService } = require('./atomic-reverse.service');
const { TradingCommandService } = require('./trading-command.service');
const { PendingOrderAmendService } = require('./pending-order-amend.service');
const { TradingHistoryService } = require('./trading-history.service');
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
const { RiskDayEngine } = require('./risk-day-engine');
const { ChallengeRiskEngine } = require('./challenge-risk-engine');

function createTradingRuntime({ marketRuntime }) {
  const eventBus = marketRuntime.eventBus;
  const commandQueue = new AccountCommandQueue();
  const idempotencyService = new IdempotencyService();
  const currencyConversionEngine = new CurrencyConversionEngine({ quoteStore: marketRuntime.quoteStore, symbols: marketRuntime.symbols, maxQuoteAgeMs: env.market.defaultMaxQuoteAgeMs });
  setDefaultCurrencyConversionEngine(currencyConversionEngine);

  const marketPriority = { retain: marketRuntime.retainPriority, release: marketRuntime.releasePriority };
  const valuationEngine = new ValuationEngine({ quoteStore: marketRuntime.quoteStore, eventBus, currencyConverter: currencyConversionEngine, marketPriority, logger });
  const platformEventRelay = new PlatformEventRelay({
    eventBus,
    enabled: env.platformEvents.enabled,
    webhookUrl: env.platformEvents.webhookUrl,
    webhookSecret: env.platformEvents.webhookSecret,
    pollIntervalMs: env.platformEvents.pollIntervalMs,
    timeoutMs: env.platformEvents.timeoutMs,
    batchSize: env.platformEvents.batchSize,
    maxAttempts: env.platformEvents.maxAttempts,
    logger,
  });
  const marketOrderService = new MarketOrderService({ quoteStore: marketRuntime.quoteStore, eventBus, commandQueue, idempotencyService, valuationEngine, platformEventRelay, quoteRecovery: marketRuntime.ensureFreshQuote, logger });
  const atomicReverseService = new AtomicReverseService({ quoteStore: marketRuntime.quoteStore, eventBus, commandQueue, idempotencyService, valuationEngine, platformEventRelay, quoteRecovery: marketRuntime.ensureFreshQuote, logger });
  const tradingCommandService = new TradingCommandService({ marketOrderService, atomicReverseService, logger });
  const accountControlService = new AccountControlService({ eventBus, commandQueue, marketOrderService, platformEventRelay, logger });
  const accountLedgerService = new AccountLedgerService({ eventBus, commandQueue, logger });
  const protectionTriggerEngine = new ProtectionTriggerEngine({ eventBus, marketOrderService, logger });
  const pendingOrderService = new PendingOrderService({ quoteStore: marketRuntime.quoteStore, eventBus, commandQueue, idempotencyService, valuationEngine, platformEventRelay, logger });
  const pendingOrderAmendService = new PendingOrderAmendService({ quoteStore: marketRuntime.quoteStore, eventBus, commandQueue, idempotencyService, logger });
  const tradingHistoryService = new TradingHistoryService();
  const pendingOrderEngine = new PendingOrderEngine({ eventBus, pendingOrderService, marketPriority, logger });
  const positionProtectionService = new PositionProtectionService({ quoteStore: marketRuntime.quoteStore, eventBus, commandQueue, idempotencyService, logger });
  const trailingStopService = new TrailingStopService({ quoteStore: marketRuntime.quoteStore, eventBus, commandQueue, idempotencyService, logger });
  const trailingStopEngine = new TrailingStopEngine({ eventBus, trailingStopService, logger });
  const riskDayEngine = new RiskDayEngine({ eventBus, commandQueue, logger });
  const challengeRiskEngine = new ChallengeRiskEngine({ eventBus, accountControlService, logger });
  const reconciliationService = new ReconciliationService({ commandQueue, valuationEngine, pendingOrderEngine, protectionTriggerEngine, trailingStopEngine, logger });
  let started = false;

  async function start() {
    if (started) return;
    try {
      await valuationEngine.start();
      riskDayEngine.start();
      challengeRiskEngine.start();
      await platformEventRelay.start();
      await protectionTriggerEngine.start();
      await pendingOrderEngine.start();
      await trailingStopEngine.start();

      started = true;
      await reconciliationService.verifyRecovery({ persist: true });
      if (env.reconciliation.enabled) reconciliationService.startPeriodic(env.reconciliation.intervalMs);
    } catch (error) {
      reconciliationService.stopPeriodic();
      await trailingStopEngine.stop().catch(() => undefined);
      await pendingOrderEngine.stop().catch(() => undefined);
      await protectionTriggerEngine.stop().catch(() => undefined);
      await challengeRiskEngine.stop().catch(() => undefined);
      await riskDayEngine.stop().catch(() => undefined);
      await platformEventRelay.stop().catch(() => undefined);
      await valuationEngine.stop().catch(() => undefined);
      setDefaultCurrencyConversionEngine(null);
      started = false;
      throw error;
    }
  }

  async function stop() {
    reconciliationService.stopPeriodic();

    // Stop event-driven producers first and wait for their current work.
    await trailingStopEngine.stop();
    await pendingOrderEngine.stop();
    await protectionTriggerEngine.stop();
    await challengeRiskEngine.stop();
    await riskDayEngine.stop();

    // Complete all accepted account commands while the platform relay remains
    // attached, so committed deals/account events cannot be lost on SIGTERM.
    await commandQueue.drainAll();
    await platformEventRelay.stop();
    await valuationEngine.stop();
    setDefaultCurrencyConversionEngine(null);
    started = false;
  }

  function health() {
    const reconciliation = reconciliationService.health();
    const recoveryConsistent = reconciliation.recovery == null || reconciliation.recovery.consistent !== false;
    const integrityHealthy = !['DEGRADED', 'ISSUES'].includes(reconciliation.state);
    return {
      enabled: env.tradingApiEnabled,
      state: !env.tradingApiEnabled ? 'API_DISABLED' : (!started ? 'STARTING' : (recoveryConsistent && integrityHealthy ? 'READY' : 'DEGRADED')),
      started,
      pendingAccounts: commandQueue.pendingAccounts,
      valuation: valuationEngine.health(),
      riskDay: riskDayEngine.health(),
      riskEngine: challengeRiskEngine.health(),
      platformEvents: platformEventRelay.health(),
      protection: protectionTriggerEngine.health(),
      pendingOrders: pendingOrderEngine.health(),
      trailing: trailingStopEngine.health(),
      reconciliation,
      capabilities: {
        accountProvisioning: true,
        accountLifecycleAudit: true,
        accountLedger: true,
        accountBalanceAdjustments: true,
        accountPauseResume: true,
        accountDisable: true,
        accountBreach: true,
        accountClose: true,
        accountLiquidation: true,
        platformEventRelay: true,
        signedPlatformWebhooks: true,
        instrumentMaster: true,
        tradingSessions: true,
        tradingHolidays: true,
        accountCurrencyConversion: true,
        crossCurrencyMargin: true,
        crossCurrencyPnl: true,
        marketOpen: true,
        marketClose: true,
        partialClose: true,
        serverReverse: true,
        atomicReverse: true,
        serverCloseAll: true,
        realtimeValuation: true,
        accountEquity: true,
        pendingOrders: true,
        limitOrders: true,
        stopOrders: true,
        stopLimitOrders: true,
        pendingOrderExpiry: true,
        pendingOrderCancel: true,
        pendingOrderAmend: true,
        durableHistory: true,
        paginatedOrders: true,
        paginatedDeals: true,
        paginatedPositions: true,
        executionRiskPolicy: true,
        protectiveTriggers: true,
        stopLoss: true,
        takeProfit: true,
        protectionManagement: true,
        breakEven: true,
        trailing: true,
        reconciliation: true,
        periodicReconciliation: env.reconciliation.enabled,
        immutableReconciliationReports: true,
        recoveryVerification: true,
        propChallengeRiskEngine: true,
        riskEngine: true,
      },
    };
  }

  return {
    enabled: env.tradingApiEnabled,
    eventBus,
    marketOrderService,
    atomicReverseService,
    tradingCommandService,
    accountControlService,
    accountLedgerService,
    platformEventRelay,
    pendingOrderService,
    pendingOrderAmendService,
    tradingHistoryService,
    positionProtectionService,
    trailingStopService,
    valuationEngine,
    currencyConversionEngine,
    protectionTriggerEngine,
    pendingOrderEngine,
    trailingStopEngine,
    riskDayEngine,
    challengeRiskEngine,
    reconciliationService,
    commandQueue,
    start,
    stop,
    health,
  };
}

module.exports = { createTradingRuntime };
