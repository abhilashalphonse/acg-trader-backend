'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/app-error');
const { normalizeDecimal, compareDecimal } = require('../../shared/decimal/decimal');
const { TradingAccount } = require('../accounts/trading-account.model');
const { AccountLifecycleEvent } = require('../accounts/account-lifecycle-event.model');
const { Order } = require('./order.model');
const { Position } = require('./position.model');
const { AccountLedger } = require('./account-ledger.model');
const { serializeAccount } = require('./trading.serializer');
const { AccountCommandQueue } = require('./account-command-queue');
const { runMongoTransaction } = require('./market-order.service');
const { dayKeyInTimezone } = require('./risk-day-engine');

const RESTRICTED_STATUSES = new Set(['BREACHED', 'DISABLED', 'CLOSED']);

class AccountControlService {
  constructor({
    eventBus = null,
    logger = null,
    marketOrderService = null,
    platformEventRelay = null,
    accountModel = TradingAccount,
    orderModel = Order,
    positionModel = Position,
    ledgerModel = AccountLedger,
    lifecycleModel = AccountLifecycleEvent,
    commandQueue = new AccountCommandQueue(),
    runTransaction = runMongoTransaction,
    now = () => new Date(),
  } = {}) {
    Object.assign(this, {
      eventBus,
      logger,
      marketOrderService,
      platformEventRelay,
      accountModel,
      orderModel,
      positionModel,
      ledgerModel,
      lifecycleModel,
      commandQueue,
      runTransaction,
      now,
    });
  }

  async provision(command) {
    const input = normalizeProvisionCommand(command);
    const queueKey = `provision:${input.tenantId}:${input.externalRef}`;

    return this.commandQueue.run(queueKey, async () => {
      const scope = { tenantId: input.tenantId, externalRef: input.externalRef };
      const existing = await this.accountModel.findOne(scope);
      if (existing) return provisionResult(assertProvisionReplay(existing, input), true);

      try {
        const account = await this.runTransaction(async session => {
          const raced = await this.accountModel.findOne(scope).session(session);
          if (raced) return assertProvisionReplay(raced, input);

          const created = new this.accountModel({
            tenantId: input.tenantId,
            accountCode: input.accountCode || generateAccountCode(),
            userId: input.userId,
            ownerExternalRef: input.ownerExternalRef,
            externalRef: input.externalRef,
            accountType: input.accountType,
            currency: input.currency,
            leverage: input.leverage,
            status: 'ACTIVE',
            tradingEnabled: true,
            state: buildInitialState(input.initialBalance),
            riskPolicy: input.riskPolicy,
            riskDayKey: input.riskDayKey,
            riskTimezone: input.riskTimezone,
            metadata: input.metadata,
          });

          await created.save({ session });

          const openingLedger = new this.ledgerModel({
            tenantId: created.tenantId,
            accountId: created._id,
            type: 'DEPOSIT',
            amount: input.initialBalance,
            balanceBefore: '0',
            balanceAfter: input.initialBalance,
            currency: created.currency,
            referenceType: 'SYSTEM',
            referenceId: `provision:${input.externalRef}`,
            idempotencyKey: `provision:${input.externalRef}`,
            reason: 'Initial account funding',
            metadata: { source: 'ACCOUNT_PROVISIONING' },
          });
          await openingLedger.save({ session });

          await this.#recordLifecycle(created, {
            type: 'PROVISIONED',
            fromStatus: null,
            toStatus: 'ACTIVE',
            tradingEnabledBefore: null,
            tradingEnabledAfter: true,
            reason: 'ACCOUNT_PROVISIONED',
          }, session);

          return created;
        });

        this.#emit('trading.account.provisioned', serializeControlledAccount(account));
        return provisionResult(account, false);
      } catch (error) {
        if (error?.code !== 11000) throw error;
        const raced = await this.accountModel.findOne(scope);
        if (!raced) throw error;
        return provisionResult(assertProvisionReplay(raced, input), true);
      }
    });
  }

  async getById(accountId) {
    const account = await this.accountModel.findById(String(accountId));
    if (!account) throw accountNotFound();
    return serializeControlledAccount(account);
  }

  async pause(accountId, { reason = 'MANUAL_PAUSE', cancelPending = false } = {}) {
    return this.#restrict(accountId, {
      status: 'PAUSED',
      reason,
      cancelPending,
      event: 'trading.account.paused',
      lifecycleType: 'PAUSED',
    });
  }

  async resume(accountId, { reason = 'MANUAL_RESUME' } = {}) {
    return this.commandQueue.run(String(accountId), async () => {
      const result = await this.runTransaction(async session => {
        const account = await this.accountModel.findById(String(accountId)).session(session);
        if (!account) throw accountNotFound();
        if (account.status === 'ACTIVE' && account.tradingEnabled === true) {
          return { account, changed: false };
        }
        if (RESTRICTED_STATUSES.has(account.status)) {
          throw new AppError('Restricted trading account cannot be resumed', {
            statusCode: 409,
            code: 'ACCOUNT_RESUME_FORBIDDEN',
            details: { status: account.status },
          });
        }

        const fromStatus = account.status;
        const tradingEnabledBefore = account.tradingEnabled;
        account.status = 'ACTIVE';
        account.tradingEnabled = true;
        setControlMetadata(account, reason, this.now());
        await account.save({ session });
        await this.#recordLifecycle(account, {
          type: 'RESUMED',
          fromStatus,
          toStatus: 'ACTIVE',
          tradingEnabledBefore,
          tradingEnabledAfter: true,
          reason,
        }, session);
        await this.platformEventRelay?.enqueueControl({ account, sourceEvent: 'trading.account.resumed', session });
        return { account, changed: true };
      });

      if (result.changed) this.#emit('trading.account.resumed', serializeControlledAccount(result.account));
      return controlResult(result.account, { changed: result.changed });
    });
  }

  async disable(accountId, { reason = 'ACCOUNT_DISABLED', cancelPending = true, liquidate = false } = {}) {
    const restricted = await this.#restrict(accountId, {
      status: 'DISABLED',
      reason,
      cancelPending,
      event: 'trading.account.disabled',
      lifecycleType: 'DISABLED',
    });
    const liquidation = liquidate ? await this.#liquidate(accountId) : [];
    return { ...restricted, liquidation };
  }

  async breach(accountId, { reason = 'RISK_BREACH', action = null } = {}) {
    const account = await this.accountModel.findById(String(accountId));
    if (!account) throw accountNotFound();
    const breachAction = action || account.riskPolicy?.breachAction || 'LIQUIDATE_AND_LOCK';
    if (!['LOCK_ONLY', 'CANCEL_ORDERS_AND_LOCK', 'LIQUIDATE_AND_LOCK'].includes(breachAction)) {
      throw new AppError('Invalid breach action', { statusCode: 400, code: 'INVALID_BREACH_ACTION' });
    }

    const restricted = await this.#restrict(accountId, {
      status: 'BREACHED',
      reason,
      cancelPending: breachAction !== 'LOCK_ONLY',
      breach: true,
      event: 'trading.account.breached',
      lifecycleType: 'BREACHED',
    });
    const liquidation = breachAction === 'LIQUIDATE_AND_LOCK' ? await this.#liquidate(accountId) : [];
    return { ...restricted, breachAction, liquidation };
  }

  async close(accountId, { reason = 'ACCOUNT_CLOSED', liquidate = true } = {}) {
    const account = await this.accountModel.findById(String(accountId));
    if (!account) throw accountNotFound();
    if (account.status === 'CLOSED') {
      return { ...controlResult(account, { changed: false }), liquidation: [] };
    }

    if (!liquidate) {
      const openCount = await this.positionModel.countDocuments({ accountId: String(accountId), status: 'OPEN' });
      if (openCount > 0) {
        throw new AppError('Account has open positions and cannot be closed without liquidation', {
          statusCode: 409,
          code: 'ACCOUNT_HAS_OPEN_POSITIONS',
          details: { openPositions: openCount },
        });
      }
    }

    await this.#restrict(accountId, {
      status: 'DISABLED',
      reason: `${reason}:PRE_CLOSE`,
      cancelPending: true,
      event: 'trading.account.closing',
      lifecycleType: 'CLOSING',
    });

    const liquidation = liquidate ? await this.#liquidate(accountId) : [];

    return this.commandQueue.run(String(accountId), async () => {
      const result = await this.runTransaction(async session => {
        const current = await this.accountModel.findById(String(accountId)).session(session);
        if (!current) throw accountNotFound();
        if (current.status === 'CLOSED') return { account: current, changed: false };

        const fromStatus = current.status;
        const tradingEnabledBefore = current.tradingEnabled;
        current.status = 'CLOSED';
        current.tradingEnabled = false;
        current.closedAt = this.now();
        setControlMetadata(current, reason, this.now());
        await current.save({ session });
        await this.#recordLifecycle(current, {
          type: 'CLOSED',
          fromStatus,
          toStatus: 'CLOSED',
          tradingEnabledBefore,
          tradingEnabledAfter: false,
          reason,
        }, session);
        await this.platformEventRelay?.enqueueControl({ account: current, sourceEvent: 'trading.account.closed', session });
        return { account: current, changed: true };
      });

      if (result.changed) this.#emit('trading.account.closed', serializeControlledAccount(result.account));
      return { ...controlResult(result.account, { changed: result.changed }), liquidation };
    });
  }

  async #restrict(accountId, { status, reason, cancelPending, breach = false, event, lifecycleType }) {
    return this.commandQueue.run(String(accountId), async () => {
      const result = await this.runTransaction(async session => {
        const account = await this.accountModel.findById(String(accountId)).session(session);
        if (!account) throw accountNotFound();
        if (account.status === 'CLOSED' && status !== 'CLOSED') {
          throw new AppError('Closed trading account cannot change lifecycle state', {
            statusCode: 409,
            code: 'ACCOUNT_CLOSED',
          });
        }

        const now = this.now();
        const alreadyApplied = account.status === status && account.tradingEnabled === false;
        const fromStatus = account.status;
        const tradingEnabledBefore = account.tradingEnabled;

        account.status = status;
        account.tradingEnabled = false;
        if (breach && !account.breachedAt) account.breachedAt = now;
        setControlMetadata(account, reason, now);
        await account.save({ session });

        let cancelledPending = 0;
        if (cancelPending) cancelledPending = await this.#cancelPending(account._id, reason, now, session);

        if (!alreadyApplied) {
          await this.#recordLifecycle(account, {
            type: lifecycleType,
            fromStatus,
            toStatus: status,
            tradingEnabledBefore,
            tradingEnabledAfter: false,
            reason,
          }, session);
          await this.platformEventRelay?.enqueueControl({ account, sourceEvent: event, session });
        }

        return { account, changed: !alreadyApplied, cancelledPending };
      });

      if (result.changed) this.#emit(event, serializeControlledAccount(result.account));
      return controlResult(result.account, {
        changed: result.changed,
        cancelledPending: result.cancelledPending,
      });
    });
  }

  async #cancelPending(accountId, reason, now, session) {
    const result = await this.orderModel.updateMany(
      { accountId, status: mongoose.trusted({ $in: ['PENDING', 'TRIGGERED'] }) },
      {
        $set: {
          status: 'CANCELLED',
          cancelledAt: now,
          rejectCode: null,
          rejectMessage: null,
          'metadata.controlCancellationReason': String(reason),
        },
      },
      { session },
    );
    return result.modifiedCount ?? result.nModified ?? 0;
  }

  async #recordLifecycle(account, event, session) {
    const record = new this.lifecycleModel({
      tenantId: account.tenantId,
      accountId: account._id,
      type: event.type,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      tradingEnabledBefore: event.tradingEnabledBefore,
      tradingEnabledAfter: event.tradingEnabledAfter,
      reason: String(event.reason),
      actorType: 'SERVICE',
    });
    await record.save({ session });
    return record;
  }

  async #liquidate(accountId) {
    if (!this.marketOrderService) {
      throw new AppError('Account liquidation service is unavailable', {
        statusCode: 503,
        code: 'ACCOUNT_LIQUIDATION_UNAVAILABLE',
      });
    }

    const positions = await this.positionModel.find({ accountId: String(accountId), status: 'OPEN' }).select('_id').lean();
    const results = [];
    for (const position of positions) {
      const positionId = String(position._id);
      try {
        const result = await this.marketOrderService.closeMarketPosition({
          accountId: String(accountId),
          positionId,
          clientOrderId: `control-liquidation:${positionId}`,
          source: 'SYSTEM',
        });
        results.push({ positionId, status: 'CLOSED', result });
      } catch (error) {
        this.logger?.error({ err: error, accountId: String(accountId), positionId }, 'Account liquidation failed');
        results.push({
          positionId,
          status: 'FAILED',
          error: {
            code: error?.code || 'COMMAND_FAILED',
            message: error?.message || 'Position liquidation failed',
            statusCode: Number(error?.statusCode) || 500,
          },
        });
      }
    }

    const failed = results.filter(item => item.status === 'FAILED');
    if (failed.length) {
      throw new AppError('Failed to liquidate all open positions', {
        statusCode: 409,
        code: 'ACCOUNT_LIQUIDATION_FAILED',
        details: {
          requestedPositions: positions.length,
          closedPositions: results.length - failed.length,
          failedPositions: failed.map(item => ({
            positionId: item.positionId,
            causeCode: item.error.code,
          })),
        },
      });
    }
    return results;
  }

  #emit(name, payload) {
    try {
      this.eventBus?.emit(name, payload);
    } catch (error) {
      this.logger?.error({ err: error, event: name }, 'Account control event listener failed');
    }
  }
}

function normalizeProvisionCommand(command) {
  const tenantId = requiredString(command?.tenantId, 'tenantId');
  const externalRef = requiredString(command?.externalRef, 'externalRef');
  const ownerExternalRef = command?.ownerExternalRef == null
    ? null
    : requiredString(command.ownerExternalRef, 'ownerExternalRef');
  const userId = command?.userId == null ? null : String(command.userId).trim();

  if (!ownerExternalRef && !userId) {
    throw new AppError('Either ownerExternalRef or userId is required', {
      statusCode: 400,
      code: 'ACCOUNT_OWNER_REQUIRED',
    });
  }

  const initialBalance = normalizeDecimal(command?.initialBalance ?? '0');
  if (compareDecimal(initialBalance, '0') <= 0) {
    throw new AppError('initialBalance must be greater than zero', {
      statusCode: 400,
      code: 'INVALID_INITIAL_BALANCE',
    });
  }

  const leverage = Number(command?.leverage ?? 100);
  if (!Number.isInteger(leverage) || leverage < 1) {
    throw new AppError('leverage must be a positive integer', {
      statusCode: 400,
      code: 'INVALID_LEVERAGE',
    });
  }

  const accountType = String(command?.accountType || 'CHALLENGE').toUpperCase();
  if (!['DEMO', 'CHALLENGE', 'FUNDED'].includes(accountType)) {
    throw new AppError('Invalid accountType', { statusCode: 400, code: 'INVALID_ACCOUNT_TYPE' });
  }

  const riskTimezone = String(command?.riskTimezone || 'UTC').trim() || 'UTC';
  const provisionDayKey = dayKeyInTimezone(new Date(), riskTimezone);

  return {
    tenantId,
    externalRef,
    ownerExternalRef,
    userId: userId || null,
    accountCode: command?.accountCode ? requiredString(command.accountCode, 'accountCode').toUpperCase() : null,
    accountType,
    currency: String(command?.currency || 'USD').toUpperCase(),
    leverage,
    initialBalance,
    riskPolicy: normalizeRiskPolicy(command?.riskPolicy),
    riskDayKey: String(command?.riskDayKey || provisionDayKey).trim(),
    riskTimezone,
    metadata: normalizeMetadata(command?.metadata),
  };
}

function normalizeRiskPolicy(policy = {}) {
  const dailyLimit = normalizeDecimal(policy?.dailyLoss?.limit ?? '0');
  const maxLimit = normalizeDecimal(policy?.maxLoss?.limit ?? '0');
  const profitTarget = normalizeDecimal(policy?.profitTarget ?? '0');
  const maxPositionVolume = policy?.maxPositionVolume == null ? null : normalizeDecimal(policy.maxPositionVolume);
  const maxSymbolVolume = policy?.maxSymbolVolume == null ? null : normalizeDecimal(policy.maxSymbolVolume);
  const maxTotalVolume = policy?.maxTotalVolume == null ? null : normalizeDecimal(policy.maxTotalVolume);
  const maxRiskPerTradePercent = policy?.maxRiskPerTradePercent == null ? null : normalizeDecimal(policy.maxRiskPerTradePercent);
  const maxAggregateRiskPercent = policy?.maxAggregateRiskPercent == null ? null : normalizeDecimal(policy.maxAggregateRiskPercent);

  for (const [field, value] of [
    ['dailyLoss.limit', dailyLimit],
    ['maxLoss.limit', maxLimit],
    ['profitTarget', profitTarget],
    ['maxPositionVolume', maxPositionVolume],
    ['maxSymbolVolume', maxSymbolVolume],
    ['maxTotalVolume', maxTotalVolume],
    ['maxRiskPerTradePercent', maxRiskPerTradePercent],
    ['maxAggregateRiskPercent', maxAggregateRiskPercent],
  ]) {
    if (value != null && compareDecimal(value, '0') < 0) {
      throw new AppError(`${field} cannot be negative`, {
        statusCode: 400,
        code: 'INVALID_RISK_POLICY',
      });
    }
  }

  return {
    dailyLoss: {
      limit: dailyLimit,
      reference: String(policy?.dailyLoss?.reference || 'DAILY_START_EQUITY'),
    },
    maxLoss: {
      limit: maxLimit,
      reference: String(policy?.maxLoss?.reference || 'INITIAL_BALANCE'),
    },
    profitTarget,
    breachAction: String(policy?.breachAction || 'LIQUIDATE_AND_LOCK').toUpperCase(),
    maxOpenPositions: policy?.maxOpenPositions ?? null,
    maxPendingOrders: policy?.maxPendingOrders ?? null,
    maxPositionVolume,
    maxSymbolVolume,
    maxTotalVolume,
    requireStopLoss: policy?.requireStopLoss === true,
    maxRiskPerTradePercent,
    maxAggregateRiskPercent,
    allowedSymbols: Array.isArray(policy?.allowedSymbols)
      ? policy.allowedSymbols.map(value => String(value).replace('/', '').toUpperCase())
      : [],
  };
}

function buildInitialState(initialBalance) {
  return {
    initialBalance,
    balance: initialBalance,
    equity: initialBalance,
    floatingPnl: '0',
    realizedPnlToday: '0',
    usedMargin: '0',
    freeMargin: initialBalance,
    dailyStartEquity: initialBalance,
  };
}

function assertProvisionReplay(account, input) {
  const mismatches = [];
  if (String(account.tenantId || '') !== String(input.tenantId || '')) mismatches.push('tenantId');
  if (String(account.ownerExternalRef || '') !== String(input.ownerExternalRef || '')) mismatches.push('ownerExternalRef');
  if (String(account.userId || '') !== String(input.userId || '')) mismatches.push('userId');
  if (String(account.accountType || '') !== input.accountType) mismatches.push('accountType');
  if (String(account.currency || '') !== input.currency) mismatches.push('currency');
  if (Number(account.leverage) !== input.leverage) mismatches.push('leverage');
  if (normalizeDecimal(account.state?.initialBalance ?? '0') !== input.initialBalance) mismatches.push('initialBalance');
  if (input.accountCode && String(account.accountCode || '') !== input.accountCode) mismatches.push('accountCode');

  if (mismatches.length) {
    throw new AppError('externalRef is already provisioned with different account parameters', {
      statusCode: 409,
      code: 'ACCOUNT_PROVISIONING_CONFLICT',
      details: { externalRef: input.externalRef, mismatches },
    });
  }
  return account;
}

function setControlMetadata(account, reason, at) {
  if (!(account.metadata instanceof Map)) account.metadata = new Map(Object.entries(account.metadata || {}));
  account.metadata.set('lastControlReason', String(reason));
  account.metadata.set('lastControlAt', at.toISOString());
}

function serializeControlledAccount(account) {
  return {
    ...serializeAccount(account),
    tenantId: account.tenantId ? String(account.tenantId) : null,
    ownerExternalRef: account.ownerExternalRef || null,
    externalRef: account.externalRef || null,
    riskDayKey: account.riskDayKey || null,
    riskTimezone: account.riskTimezone || 'UTC',
    breachedAt: account.breachedAt ? new Date(account.breachedAt).toISOString() : null,
    closedAt: account.closedAt ? new Date(account.closedAt).toISOString() : null,
  };
}

function provisionResult(account, idempotentReplay) {
  return { account: serializeControlledAccount(account), idempotentReplay };
}

function controlResult(account, extra = {}) {
  return { account: serializeControlledAccount(account), ...extra };
}

function requiredString(value, field) {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new AppError(`${field} is required`, {
      statusCode: 400,
      code: 'INVALID_ACCOUNT_CONTROL_COMMAND',
    });
  }
  return text;
}

function normalizeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  return Object.fromEntries(Object.entries(metadata).map(([key, value]) => [String(key), String(value)]));
}

function generateAccountCode() {
  return `ACG-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function accountNotFound() {
  return new AppError('Trading account was not found', {
    statusCode: 404,
    code: 'ACCOUNT_NOT_FOUND',
  });
}

module.exports = {
  AccountControlService,
  normalizeProvisionCommand,
  buildInitialState,
  assertProvisionReplay,
};
