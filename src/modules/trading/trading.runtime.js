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
const { AccountStateSynchronizer } = require('./account-state-synchronizer');
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
const { RiskStreamService } = require('./risk-stream.service');
const { PostFillRiskService } = require('./post-fill-risk.service');
const { BreachCleanupEngine } = require('./breach-cleanup-engine');
const { MarginStopOutEngine } = require('./margin-stop-out-engine');
const { TradingPermissionPolicyService } = require('./trading-permission-policy.service');
const { NewsCalendarSnapshotService } = require('./news-calendar-snapshot.service');
const { normalizeCalendarEvent } = require('./trading-permission-policy.service');
const { WeekendHoldingEngine } = require('./weekend-holding.engine');
const { WeekendActionService } = require('./weekend-action.service');
const { PolicyControlService } = require('./policy-control.service');
const { PolicyMetricsService } = require('./policy-metrics.service');

function createTradingRuntime({ marketRuntime }) {
  const eventBus = marketRuntime.eventBus;
  const commandQueue = new AccountCommandQueue();
  const idempotencyService = new IdempotencyService();
  const currencyConversionEngine = new CurrencyConversionEngine({ quoteStore: marketRuntime.quoteStore, symbols: marketRuntime.symbols, maxQuoteAgeMs: env.market.defaultMaxQuoteAgeMs });
  setDefaultCurrencyConversionEngine(currencyConversionEngine);

  const marketPriority = { retain: marketRuntime.retainPriority, release: marketRuntime.releasePriority };
  const valuationEngine = new ValuationEngine({
    quoteStore: marketRuntime.quoteStore,
    eventBus,
    currencyConverter: currencyConversionEngine,
    marketPriority,
    instrumentResolver: symbol => marketRuntime.instrumentRegistry.get(symbol),
    logger,
  });
  const platformEventRelay = new PlatformEventRelay({
    eventBus,
    enabled: env.platformEvents.enabled,
    webhookUrl: env.platformEvents.webhookUrl,
    webhookSecret: env.platformEvents.webhookSecret,
    pollIntervalMs: env.platformEvents.pollIntervalMs,
    timeoutMs: env.platformEvents.timeoutMs,
    batchSize: env.platformEvents.batchSize,
    maxAttempts: env.platformEvents.maxAttempts,
    snapshotCoalesceMs: env.platformEvents.snapshotCoalesceMs,
    logger,
  });
  const postFillRiskService = new PostFillRiskService({ platformEventRelay });
  const calendarSnapshots = new NewsCalendarSnapshotService({ config: env.tradingPermissions, normalizeEvent: normalizeCalendarEvent, logger });
  const policyControlService = new PolicyControlService();
  const policyMetricsService = new PolicyMetricsService({ logger });
  const tradingPermissionPolicyService = new TradingPermissionPolicyService({ logger, calendarSnapshots, controlService: policyControlService, metricsService: policyMetricsService });
  const marketOrderService = new MarketOrderService({ quoteStore: marketRuntime.quoteStore, eventBus, commandQueue, idempotencyService, valuationEngine, platformEventRelay, postFillRiskService, tradingPermissionPolicyService, quoteRecovery: marketRuntime.ensureFreshQuote, logger });
  const atomicReverseService = new AtomicReverseService({ quoteStore: marketRuntime.quoteStore, eventBus, commandQueue, idempotencyService, valuationEngine, platformEventRelay, postFillRiskService, tradingPermissionPolicyService, quoteRecovery: marketRuntime.ensureFreshQuote, logger });
  const tradingCommandService = new TradingCommandService({ marketOrderService, atomicReverseService, logger });
  const accountControlService = new AccountControlService({ eventBus, commandQueue, marketOrderService, platformEventRelay, logger });
  const breachCleanupEngine = new BreachCleanupEngine({ accountControlService, logger });
  const marginStopOutEngine = new MarginStopOutEngine({
    eventBus,
    valuationEngine,
    quoteStore: marketRuntime.quoteStore,
    currencyConverter: currencyConversionEngine,
    marketOrderService,
    accountControlService,
    logger,
  });
  const accountLedgerService = new AccountLedgerService({ eventBus, commandQueue, logger });
  const protectionTriggerEngine = new ProtectionTriggerEngine({ eventBus, marketOrderService, logger });
  const pendingOrderService = new PendingOrderService({ quoteStore: marketRuntime.quoteStore, eventBus, commandQueue, idempotencyService, valuationEngine, platformEventRelay, postFillRiskService, tradingPermissionPolicyService, logger });
  const pendingOrderAmendService = new PendingOrderAmendService({ quoteStore: marketRuntime.quoteStore, eventBus, commandQueue, idempotencyService, valuationEngine, tradingPermissionPolicyService, logger });
  const tradingHistoryService = new TradingHistoryService();
  const pendingOrderEngine = new PendingOrderEngine({ eventBus, pendingOrderService, marketPriority, logger });
  const weekendActionService = new WeekendActionService({ policyService: tradingPermissionPolicyService, marketOrderService, pendingOrderService, logger });
  marketOrderService.weekendActionService = weekendActionService;
  pendingOrderService.weekendActionService = weekendActionService;
  const weekendHoldingEngine = new WeekendHoldingEngine({
    actionService: weekendActionService,
    policyService: tradingPermissionPolicyService,
    marketOrderService,
    pendingOrderService,
    intervalMs: env.tradingPermissions.weekendScanIntervalMs,
    enforcementEnabled: env.tradingPermissions.weekendEnforcementEnabled,
    logger,
  });
  const positionProtectionService = new PositionProtectionService({ quoteStore: marketRuntime.quoteStore, eventBus, commandQueue, idempotencyService, valuationEngine, logger });
  const trailingStopService = new TrailingStopService({ quoteStore: marketRuntime.quoteStore, eventBus, commandQueue, idempotencyService, logger });
  const trailingStopEngine = new TrailingStopEngine({ eventBus, trailingStopService, logger });
  const stateSynchronizer = new AccountStateSynchronizer({ eventBus, valuationEngine, consumers: [pendingOrderEngine, protectionTriggerEngine, trailingStopEngine], logger });
  const riskStreamService = new RiskStreamService();
  const riskDayEngine = new RiskDayEngine({ eventBus, commandQueue, logger, externalOrdering: true });
  const challengeRiskEngine = new ChallengeRiskEngine({ eventBus, accountControlService, riskStreamService, logger });
  const reconciliationService = new ReconciliationService({ commandQueue, valuationEngine, pendingOrderEngine, protectionTriggerEngine, trailingStopEngine, logger });
  let started = false;

  async function start() {
    if (started) return;
    try {
      policyMetricsService.start();
      await calendarSnapshots.start();
      await valuationEngine.start();
      riskDayEngine.start();
      await challengeRiskEngine.start();
      await platformEventRelay.start();
      await breachCleanupEngine.start();
      await marginStopOutEngine.start();
      await protectionTriggerEngine.start();
      await pendingOrderEngine.start();
      weekendHoldingEngine.start();
      if (env.tradingPermissions.weekendWorkerEnabled) weekendActionService.start();
      await trailingStopEngine.start();
      await stateSynchronizer.start();

      started = true;
      await reconciliationService.verifyRecovery({ persist: true });
      if (env.reconciliation.enabled) reconciliationService.startPeriodic(env.reconciliation.intervalMs);
    } catch (error) {
      await stateSynchronizer.stop();
      await calendarSnapshots.stop();
      reconciliationService.stopPeriodic();
      await trailingStopEngine.stop().catch(() => undefined);
      weekendHoldingEngine.stop();
      await weekendActionService.stop();
      await pendingOrderEngine.stop().catch(() => undefined);
      await protectionTriggerEngine.stop().catch(() => undefined);
      await marginStopOutEngine.stop().catch(() => undefined);
      await breachCleanupEngine.stop().catch(() => undefined);
      await challengeRiskEngine.stop().catch(() => undefined);
      await riskDayEngine.stop().catch(() => undefined);
      await platformEventRelay.stop().catch(() => undefined);
      await valuationEngine.stop().catch(() => undefined);
      await policyMetricsService.stop();
      setDefaultCurrencyConversionEngine(null);
      started = false;
      throw error;
    }
  }

  async function stop() {
    await stateSynchronizer.stop();
    await calendarSnapshots.stop();
    reconciliationService.stopPeriodic();

    // Stop event-driven producers first and wait for their current work.
    await trailingStopEngine.stop();
    weekendHoldingEngine.stop();
    await weekendActionService.stop();
    await pendingOrderEngine.stop();
    await protectionTriggerEngine.stop();
    await marginStopOutEngine.stop();
    await breachCleanupEngine.stop();
    await challengeRiskEngine.stop();
    await riskDayEngine.stop();

    // Complete all accepted account commands while the platform relay remains
    // attached, so committed deals/account events cannot be lost on SIGTERM.
    await commandQueue.drainAll();
    await policyMetricsService.stop();
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
      state: !env.tradingApiEnabled ? 'API_DISABLED' : (!started ? 'STARTING' : (recoveryConsistent && integrityHealthy && stateSynchronizer.health().ready ? 'READY' : 'DEGRADED')),
      started,
      pendingAccounts: commandQueue.pendingAccounts,
      valuation: valuationEngine.health(),
      stateSynchronization: stateSynchronizer.health(),
      riskDay: riskDayEngine.health(),
      riskEngine: challengeRiskEngine.health(),
      breachCleanup: breachCleanupEngine.health(),
      marginStopOut: marginStopOutEngine.health(),
      platformEvents: platformEventRelay.health(),
      protection: protectionTriggerEngine.health(),
      pendingOrders: pendingOrderEngine.health(),
      tradingPermissions: {
        shadowEnabled: env.tradingPermissions.shadowEnabled,
        newsEnforcementEnabled: env.tradingPermissions.newsEnforcementEnabled,
        weekendEnforcementEnabled: env.tradingPermissions.weekendEnforcementEnabled,
        weekendWorkerEnabled: env.tradingPermissions.weekendWorkerEnabled,
        weekendScannerRunning: Boolean(weekendHoldingEngine.timer),
        weekendWorkerRunning: Boolean(weekendActionService.timer),
        weekendWorker: weekendActionService.health(),
        calendarStatus: calendarSnapshots.read().dataStatus,
        calendarSnapshotVersion: calendarSnapshots.read().snapshotVersion,
        calendarLastError: calendarSnapshots.lastError,
        pendingTelemetry: tradingPermissionPolicyService.pendingTelemetry,
        droppedTelemetry: tradingPermissionPolicyService.droppedTelemetry,
        metrics: policyMetricsService.health(),
      },
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
        marginStopOut: true,
        smartPartialStopOut: true,
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
        tradingPermissionShadowMode: env.tradingPermissions.shadowEnabled,
        newsTradingPolicy: true,
        weekendHoldingPolicy: true,
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
    postFillRiskService,
    breachCleanupEngine,
    marginStopOutEngine,
    accountLedgerService,
    platformEventRelay,
    pendingOrderService,
    pendingOrderAmendService,
    tradingPermissionPolicyService,
    policyControlService,
    policyMetricsService,
    weekendHoldingEngine,
    weekendActionService,
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
    riskStreamService,
    reconciliationService,
    commandQueue,
    start,
    stop,
    health,
  };
}

module.exports = { createTradingRuntime };
