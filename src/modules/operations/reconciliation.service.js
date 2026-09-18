'use strict';

const mongoose = require('mongoose');
const { addDecimal, compareDecimal, normalizeDecimal } = require('../../shared/decimal/decimal');
const { TradingAccount } = require('../accounts/trading-account.model');
const { AccountLedger } = require('../trading/account-ledger.model');
const { Order } = require('../trading/order.model');
const { Deal } = require('../trading/deal.model');
const { Position } = require('../trading/position.model');
const { ReconciliationReport } = require('./reconciliation-report.model');

class ReconciliationService {
  constructor({
    commandQueue,
    valuationEngine,
    pendingOrderEngine,
    protectionTriggerEngine,
    trailingStopEngine,
    logger,
    accountModel = TradingAccount,
    ledgerModel = AccountLedger,
    orderModel = Order,
    dealModel = Deal,
    positionModel = Position,
    reportModel = ReconciliationReport,
    now = () => new Date(),
  } = {}) {
    Object.assign(this, {
      commandQueue, valuationEngine, pendingOrderEngine, protectionTriggerEngine, trailingStopEngine, logger,
      accountModel, ledgerModel, orderModel, dealModel, positionModel, reportModel, now,
    });
    this.running = false;
    this.lastReport = null;
    this.lastRecovery = null;
    this.lastError = null;
    this.periodicTimer = null;
    this.periodicIntervalMs = null;
    this.periodicCursorId = null;
    this.periodicAccountBatchSize = 100;
  }

  health() {
    return {
      running: this.running,
      state: this.lastError ? 'DEGRADED' : (this.lastReport?.issueCount ? 'ISSUES' : 'HEALTHY'),
      periodic: { enabled: Boolean(this.periodicTimer), intervalMs: this.periodicIntervalMs },
      lastReport: this.lastReport ? summarizeReport(this.lastReport) : null,
      recovery: this.lastRecovery ? { ...this.lastRecovery } : null,
      lastError: this.lastError ? { message: this.lastError.message, code: this.lastError.code || null } : null,
    };
  }

  startPeriodic(intervalMs) {
    const resolved = Number(intervalMs);
    if (!Number.isFinite(resolved) || resolved < 1000) throw new Error('Reconciliation interval must be at least 1000ms');
    this.stopPeriodic();
    this.periodicIntervalMs = resolved;
    this.periodicTimer = setInterval(() => {
      if (this.running) return;
      this.run({ scope: 'PERIODIC', requestedBy: 'SYSTEM' }).catch(error => {
        if (error?.code !== 'RECONCILIATION_IN_PROGRESS') this.logger?.error({ err: error }, 'Periodic reconciliation failed');
      });
    }, resolved);
    this.periodicTimer.unref?.();
  }

  stopPeriodic() {
    if (this.periodicTimer) clearInterval(this.periodicTimer);
    this.periodicTimer = null;
    this.periodicIntervalMs = null;
  }

  async verifyRecovery({ persist = true } = {}) {
    const startedAt = this.now();
    try {
      const [openPositions, pendingCount, triggeredCount] = await Promise.all([
        this.positionModel.find({ status: 'OPEN' }).lean(),
        this.orderModel.countDocuments({ status: 'PENDING' }),
        this.orderModel.countDocuments({ status: 'TRIGGERED' }),
      ]);
      const databaseOpenPositions = openPositions.length;
      const databasePendingOrders = pendingCount + triggeredCount;
      const databaseProtectedPositions = openPositions.filter(position => position.stopLoss != null || position.takeProfit != null).length;
      const databaseTrailingPositions = openPositions.filter(position => position.trailing?.enabled === true).length;
      const recoveredOpenPositions = Number(this.valuationEngine?.health?.().openPositions ?? 0);
      const recoveredPendingOrders = Number(this.pendingOrderEngine?.health?.().pendingOrders ?? 0);
      const recoveredProtectedPositions = Number(this.protectionTriggerEngine?.health?.().protectedPositions ?? 0);
      const recoveredTrailingPositions = Number(this.trailingStopEngine?.health?.().trailingPositions ?? 0);
      const consistent = (
        databaseOpenPositions === recoveredOpenPositions &&
        databasePendingOrders === recoveredPendingOrders &&
        databaseProtectedPositions === recoveredProtectedPositions &&
        databaseTrailingPositions === recoveredTrailingPositions
      );
      const recovery = {
        databaseOpenPositions, recoveredOpenPositions,
        databasePendingOrders, recoveredPendingOrders,
        databaseProtectedPositions, recoveredProtectedPositions,
        databaseTrailingPositions, recoveredTrailingPositions,
        consistent,
        checkedAt: this.now().toISOString(),
      };
      this.lastRecovery = recovery;
      this.lastError = null;

      if (persist) {
        const issues = [];
        if (databaseOpenPositions !== recoveredOpenPositions) issues.push(issue('RECOVERY_POSITION_COUNT_MISMATCH', 'CRITICAL', null, 'Recovered open-position count does not match MongoDB', { databaseOpenPositions, recoveredOpenPositions }));
        if (databasePendingOrders !== recoveredPendingOrders) issues.push(issue('RECOVERY_PENDING_ORDER_COUNT_MISMATCH', 'CRITICAL', null, 'Recovered pending-order count does not match MongoDB', { databasePendingOrders, recoveredPendingOrders }));
        if (databaseProtectedPositions !== recoveredProtectedPositions) issues.push(issue('RECOVERY_PROTECTION_COUNT_MISMATCH', 'CRITICAL', null, 'Recovered SL/TP protection count does not match MongoDB', { databaseProtectedPositions, recoveredProtectedPositions }));
        if (databaseTrailingPositions !== recoveredTrailingPositions) issues.push(issue('RECOVERY_TRAILING_COUNT_MISMATCH', 'CRITICAL', null, 'Recovered trailing-stop count does not match MongoDB', { databaseTrailingPositions, recoveredTrailingPositions }));
        const report = await this.#persistReport({ scope: 'STARTUP_RECOVERY', tenantId: null, requestedBy: 'SYSTEM', checkedAccounts: 0, issues, recovery, startedAt });
        this.lastReport = report;
      }
      return recovery;
    } catch (error) {
      this.lastError = error;
      this.logger?.error({ err: error }, 'Runtime recovery verification failed');
      return { consistent: false, error: error.message, checkedAt: this.now().toISOString() };
    }
  }

  async run({ tenantId = null, accountIds = null, scope = 'MANUAL', requestedBy = null } = {}) {
    if (this.running) {
      const error = new Error('A reconciliation run is already in progress');
      error.code = 'RECONCILIATION_IN_PROGRESS';
      throw error;
    }
    this.running = true;
    this.lastError = null;
    const startedAt = this.now();
    try {
      const filter = {};
      if (tenantId) filter.tenantId = tenantId;
      if (Array.isArray(accountIds) && accountIds.length) {
        filter._id = mongoose.trusted({ $in: [...new Set(accountIds.map(String))] });
      } else if (scope === 'PERIODIC' && this.periodicCursorId) {
        filter._id = mongoose.trusted({ $gt: this.periodicCursorId });
      }

      let accountQuery = this.accountModel.find(filter).sort({ _id: 1 });
      if (scope === 'PERIODIC') accountQuery = accountQuery.limit(this.periodicAccountBatchSize);
      let accounts = await accountQuery.lean();

      if (scope === 'PERIODIC' && !accounts.length && this.periodicCursorId) {
        this.periodicCursorId = null;
        accounts = await this.accountModel.find(tenantId ? { tenantId } : {})
          .sort({ _id: 1 })
          .limit(this.periodicAccountBatchSize)
          .lean();
      }
      if (scope === 'PERIODIC' && accounts.length) {
        this.periodicCursorId = String(accounts[accounts.length - 1]._id);
      }
      const issues = [];
      for (const account of accounts) {
        const accountIssues = this.commandQueue?.run
          ? await this.commandQueue.run(String(account._id), () => this.#checkAccount(account))
          : await this.#checkAccount(account);
        issues.push(...accountIssues);
      }
      const report = await this.#persistReport({ scope, tenantId, requestedBy, checkedAccounts: accounts.length, issues, recovery: null, startedAt });
      this.lastReport = report;
      this.lastError = null;
      return report;
    } catch (error) {
      this.lastError = error;
      this.logger?.error({ err: error, tenantId }, 'Reconciliation run failed');
      throw error;
    } finally {
      this.running = false;
    }
  }

  async listReports({ tenantId = null, limit = 50 } = {}) {
    const filter = {};
    if (tenantId) filter.tenantId = tenantId;
    return this.reportModel.find(filter).sort({ createdAt: -1, _id: -1 }).limit(Math.max(1, Math.min(Number(limit) || 50, 200))).lean();
  }

  async #checkAccount(account) {
    const tenantId = String(account.tenantId);
    const accountId = String(account._id);
    const [ledgers, positions, orders, deals] = await Promise.all([
      this.ledgerModel.find({ tenantId, accountId }).sort({ createdAt: 1, _id: 1 }).lean(),
      this.positionModel.find({ tenantId, accountId }).lean(),
      this.orderModel.find({ tenantId, accountId }).lean(),
      this.dealModel.find({ tenantId, accountId }).lean(),
    ]);
    const issues = [];

    if (!ledgers.length) {
      issues.push(issue('LEDGER_MISSING', 'CRITICAL', accountId, 'Trading account has no immutable ledger entries'));
    } else {
      let previousAfter = null;
      for (let index = 0; index < ledgers.length; index += 1) {
        const entry = ledgers[index];
        const before = decimal(entry.balanceBefore);
        const amount = decimal(entry.amount);
        const after = decimal(entry.balanceAfter);
        if (index === 0 && compareDecimal(before, '0') !== 0) issues.push(issue('LEDGER_OPENING_BALANCE_NONZERO', 'WARNING', accountId, 'First ledger entry does not begin at zero', { entryId: entry.entryId, balanceBefore: before }));
        if (previousAfter != null && compareDecimal(before, previousAfter) !== 0) issues.push(issue('LEDGER_CHAIN_BROKEN', 'CRITICAL', accountId, 'Ledger balance chain is discontinuous', { entryId: entry.entryId, expectedBalanceBefore: previousAfter, actualBalanceBefore: before }));
        const expectedAfter = addDecimal(before, amount);
        if (compareDecimal(expectedAfter, after) !== 0) issues.push(issue('LEDGER_MATH_MISMATCH', 'CRITICAL', accountId, 'Ledger entry arithmetic is inconsistent', { entryId: entry.entryId, expectedBalanceAfter: expectedAfter, actualBalanceAfter: after }));
        if (String(entry.currency || '').toUpperCase() !== String(account.currency || '').toUpperCase()) issues.push(issue('LEDGER_CURRENCY_MISMATCH', 'CRITICAL', accountId, 'Ledger currency differs from account currency', { entryId: entry.entryId, ledgerCurrency: entry.currency, accountCurrency: account.currency }));
        previousAfter = after;
      }
      const accountBalance = decimal(account.state?.balance);
      if (previousAfter != null && compareDecimal(previousAfter, accountBalance) !== 0) issues.push(issue('LEDGER_BALANCE_MISMATCH', 'CRITICAL', accountId, 'Final ledger balance does not equal account balance', { ledgerBalance: previousAfter, accountBalance }));
    }

    const openPositions = positions.filter(position => position.status === 'OPEN');
    let expectedUsedMargin = '0';
    for (const position of openPositions) expectedUsedMargin = addDecimal(expectedUsedMargin, decimal(position.margin));
    const actualUsedMargin = decimal(account.state?.usedMargin);
    if (compareDecimal(expectedUsedMargin, actualUsedMargin) !== 0) issues.push(issue('USED_MARGIN_MISMATCH', 'CRITICAL', accountId, 'Open-position margin total does not equal account used margin', { expectedUsedMargin, actualUsedMargin, openPositions: openPositions.length }));

    const ordersById = new Map(orders.map(order => [String(order._id), order]));
    const positionsById = new Map(positions.map(position => [String(position._id), position]));
    const dealOrderIds = new Set(deals.map(deal => String(deal.orderId)));
    for (const order of orders) if (order.status === 'FILLED' && !dealOrderIds.has(String(order._id))) issues.push(issue('FILLED_ORDER_WITHOUT_DEAL', 'CRITICAL', accountId, 'Filled order has no immutable deal record', { orderId: order.orderId || String(order._id) }));
    for (const deal of deals) {
      if (!ordersById.has(String(deal.orderId))) issues.push(issue('DEAL_ORDER_REFERENCE_MISSING', 'CRITICAL', accountId, 'Deal references an order outside the account record set', { dealId: deal.dealId, orderId: String(deal.orderId) }));
      if (deal.positionId && !positionsById.has(String(deal.positionId))) issues.push(issue('DEAL_POSITION_REFERENCE_MISSING', 'CRITICAL', accountId, 'Deal references a position outside the account record set', { dealId: deal.dealId, positionId: String(deal.positionId) }));
    }
    return issues;
  }

  async #persistReport({ scope, tenantId, requestedBy, checkedAccounts, issues, recovery, startedAt }) {
    const completedAt = this.now();
    const document = await this.reportModel.create({
      scope, tenantId: tenantId || null, requestedBy: requestedBy || null, checkedAccounts,
      issueCount: issues.length, status: issues.length ? 'ISSUES' : 'PASSED', issues,
      recovery: recovery ? {
        databaseOpenPositions: recovery.databaseOpenPositions ?? null,
        recoveredOpenPositions: recovery.recoveredOpenPositions ?? null,
        databasePendingOrders: recovery.databasePendingOrders ?? null,
        recoveredPendingOrders: recovery.recoveredPendingOrders ?? null,
        databaseProtectedPositions: recovery.databaseProtectedPositions ?? null,
        recoveredProtectedPositions: recovery.recoveredProtectedPositions ?? null,
        databaseTrailingPositions: recovery.databaseTrailingPositions ?? null,
        recoveredTrailingPositions: recovery.recoveredTrailingPositions ?? null,
        consistent: Boolean(recovery.consistent),
      } : null,
      startedAt, completedAt,
    });
    const report = typeof document.toObject === 'function' ? document.toObject() : document;
    this.logger?.[issues.length ? 'warn' : 'info']?.({ reportId: report.reportId, scope, tenantId, checkedAccounts, issueCount: issues.length }, 'Reconciliation completed');
    return report;
  }
}

function issue(code, severity, accountId, message, details = {}) { return { code, severity, accountId: accountId || null, message, details }; }
function decimal(value) { return normalizeDecimal(value == null ? '0' : value.toString()); }
function summarizeReport(report) {
  return {
    reportId: report.reportId || null,
    scope: report.scope,
    status: report.status,
    checkedAccounts: Number(report.checkedAccounts || 0),
    issueCount: Number(report.issueCount || 0),
    completedAt: report.completedAt ? new Date(report.completedAt).toISOString() : null,
  };
}

module.exports = { ReconciliationService, issue, summarizeReport };
