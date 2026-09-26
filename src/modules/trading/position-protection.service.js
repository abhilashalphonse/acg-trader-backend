'use strict';

const { AppError } = require('../../shared/errors/app-error');
const { Position } = require('./position.model');
const { Instrument } = require('../instruments/instrument.model');
const { TradingAccount } = require('../accounts/trading-account.model');
const { AccountCommandQueue } = require('./account-command-queue');
const { IdempotencyService } = require('./idempotency.service');
const { runMongoTransaction, loadOpenExposure } = require('./market-order.service');
const {
  validatePerOrderRiskPolicy,
  validateAggregateRiskPolicy,
} = require('./firm-risk-policy');
const { serializePosition } = require('./trading.serializer');
const { planPositionProtection } = require('./position-protection-planner');
const { calculateCommission } = require('./execution-planner');

class PositionProtectionService {
  constructor({
    quoteStore,
    eventBus,
    logger,
    positionModel = Position,
    instrumentModel = Instrument,
    accountModel = TradingAccount,
    valuationEngine = null,
    commandQueue = new AccountCommandQueue(),
    idempotencyService = new IdempotencyService(),
    runTransaction = runMongoTransaction,
  }) {
    Object.assign(this, {
      quoteStore,
      eventBus,
      logger,
      positionModel,
      instrumentModel,
      accountModel,
      valuationEngine,
      commandQueue,
      idempotencyService,
      runTransaction,
    });
  }

  async updateProtection(command) {
    const normalized = normalizeUpdateCommand(command);
    return this.#executeMutation({
      normalized,
      scope: 'POSITION_PROTECTION',
      breakEven: false,
      operation: 'PROTECTION_UPDATE',
    });
  }

  async moveStopToBreakEven(command) {
    const normalized = normalizeBreakEvenCommand(command);
    return this.#executeMutation({
      normalized,
      scope: 'POSITION_BREAK_EVEN',
      breakEven: true,
      operation: 'BREAK_EVEN',
    });
  }

  async #executeMutation({ normalized, scope, breakEven, operation }) {
    const reservation = await this.idempotencyService.reserve({
      accountId: normalized.accountId,
      scope,
      key: normalized.clientRequestId,
      payload: normalized,
    });
    const replay = resolveReservation(reservation);
    if (replay) return replay;

    try {
      const result = await this.commandQueue.run(normalized.accountId, async () => {
        const snapshot = await loadLean(this.positionModel.findById(normalized.positionId));
        validateOwnership(snapshot, normalized.accountId);

        const quoteSnapshot = this.quoteStore.get(snapshot.symbol);
        const nowMs = Date.now();

        return this.runTransaction(async session => {
          const position = await this.positionModel.findById(normalized.positionId).session(session);
          validateOwnership(position, normalized.accountId);

          const account = await this.accountModel.findById(normalized.accountId).session(session);
          if (!account) {
            throw new AppError('Trading account was not found', {
              statusCode: 404,
              code: 'ACCOUNT_NOT_FOUND',
            });
          }
          if (this.valuationEngine) this.valuationEngine.overlayAccountDocument(account, { requireLive: false });

          const instrument = await this.instrumentModel.findOne({ symbol: String(position.symbol).toUpperCase() }).session(session);
          const plan = planPositionProtection({
            position,
            instrument,
            quote: quoteSnapshot,
            stopLoss: normalized.stopLoss,
            takeProfit: normalized.takeProfit,
            breakEven,
            nowMs,
          });

          const closingCommission = plan.stopLoss == null
            ? '0'
            : calculateCommission(instrument, position.openVolume, {
              account,
              fillPrice: plan.stopLoss,
              nowMs,
            });
          const firmRisk = validatePerOrderRiskPolicy({
            account,
            instrument,
            side: position.side,
            entryPrice: position.entryPrice,
            volume: position.openVolume,
            stopLoss: plan.stopLoss,
            openingCommission: '0',
            closingCommission,
            nowMs,
            checkPositionVolume: false,
          });
          const aggregateLimit = Number(account.riskPolicy?.maxAggregateRiskPercent?.toString?.() ?? account.riskPolicy?.maxAggregateRiskPercent);
          if (Number.isFinite(aggregateLimit) && aggregateLimit > 0) {
            const exposure = await loadOpenExposure(this.positionModel, normalized.accountId, session, {
              account,
              symbol: position.symbol,
              nowMs,
              excludePositionId: position._id,
              instrumentModel: this.instrumentModel,
            });
            validateAggregateRiskPolicy({
              account,
              tradeRiskAmount: firmRisk.tradeRiskAmount,
              exposure,
            });
          }

          if (plan.changed) {
            position.stopLoss = plan.stopLoss;
            position.takeProfit = plan.takeProfit;
            if ((breakEven || normalized.stopLoss !== undefined) && normalized.source !== 'SYSTEM' && position.trailing?.enabled) {
              position.trailing.enabled = false;
              position.trailing.distancePoints = null;
              position.trailing.bestPrice = null;
              position.trailing.activatedAt = null;
            }
            await position.save({ session });
          }

          const response = {
            operation,
            changed: plan.changed,
            breakEven: plan.breakEven,
            quote: {
              executablePrice: plan.executablePrice,
              sequence: plan.quoteSequence,
              receivedAtMs: plan.quoteReceivedAtMs,
              source: plan.quoteSource,
            },
            previousProtection: {
              stopLoss: plan.previousStopLoss,
              takeProfit: plan.previousTakeProfit,
            },
            position: serializePosition(position),
          };

          const completed = await this.idempotencyService.complete(
            reservation.record._id,
            { resourceType: 'POSITION', resourceId: position.positionId, response },
            { session },
          );
          if (!completed) {
            throw new AppError('Idempotency record could not be completed', {
              statusCode: 409,
              code: 'IDEMPOTENCY_STATE_CONFLICT',
            });
          }
          return response;
        });
      });

      if (result.changed) {
        this.#emit('trading.position.updated', result.position);
        this.#emit('trading.position.protection.updated', {
          operation,
          accountId: normalized.accountId,
          position: result.position,
          previousProtection: result.previousProtection,
          quote: result.quote,
        });
      }
      return { ...result, idempotentReplay: false };
    } catch (error) {
      await this.#recordFailure(reservation.record._id, error);
      throw error;
    }
  }

  #emit(name, payload) {
    try {
      this.eventBus?.emit(name, payload);
    } catch (error) {
      this.logger?.error({ err: error, event: name }, 'Position protection event listener failed');
    }
  }

  async #recordFailure(recordId, error) {
    try {
      await this.idempotencyService.fail(recordId, {
        failureCode: error?.code || 'PROTECTION_UPDATE_FAILED',
        response: {
          error: {
            statusCode: error?.statusCode || 500,
            code: error?.code || 'INTERNAL_ERROR',
            message: error?.statusCode < 500 || error?.expose === true ? error.message : 'Internal server error',
            details: error?.details,
          },
        },
      });
    } catch (failureError) {
      this.logger?.error({ err: failureError, originalError: error }, 'Failed to record protection idempotency failure');
    }
  }
}

function normalizeUpdateCommand(command) {
  const normalized = {
    accountId: String(command?.accountId || '').trim(),
    positionId: String(command?.positionId || '').trim(),
    clientRequestId: String(command?.clientRequestId || '').trim(),
    stopLoss: normalizePatchValue(command?.stopLoss),
    takeProfit: normalizePatchValue(command?.takeProfit),
    source: normalizeSource(command?.source),
  };
  if (normalized.stopLoss === undefined && normalized.takeProfit === undefined) {
    throw new AppError('At least one of stopLoss or takeProfit must be supplied', {
      statusCode: 400,
      code: 'PROTECTION_CHANGE_REQUIRED',
    });
  }
  return normalized;
}

function normalizeBreakEvenCommand(command) {
  return {
    accountId: String(command?.accountId || '').trim(),
    positionId: String(command?.positionId || '').trim(),
    clientRequestId: String(command?.clientRequestId || '').trim(),
    source: normalizeSource(command?.source),
    stopLoss: undefined,
    takeProfit: undefined,
  };
}

function normalizePatchValue(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  return String(value).trim();
}

function normalizeSource(source) {
  const value = String(source || 'API').toUpperCase();
  return ['WEB', 'MOBILE', 'API', 'SYSTEM'].includes(value) ? value : 'API';
}

function validateOwnership(position, accountId) {
  if (!position) {
    throw new AppError('Position was not found', { statusCode: 404, code: 'POSITION_NOT_FOUND' });
  }
  if (String(position.accountId) !== String(accountId)) {
    throw new AppError('Position does not belong to this trading account', {
      statusCode: 403,
      code: 'POSITION_ACCOUNT_MISMATCH',
    });
  }
  if (String(position.status || '').toUpperCase() !== 'OPEN') {
    throw new AppError('Position is not open', { statusCode: 409, code: 'POSITION_NOT_OPEN' });
  }
}

async function loadLean(query) {
  if (typeof query?.lean === 'function') return query.lean();
  return query;
}

function resolveReservation(reservation) {
  if (reservation.created) return null;
  if (reservation.inProgress) {
    throw new AppError('An identical protection command is already in progress', {
      statusCode: 409,
      code: 'COMMAND_IN_PROGRESS',
    });
  }
  if (reservation.record.state === 'COMPLETED') {
    return { ...(reservation.record.response || {}), idempotentReplay: true };
  }
  if (reservation.record.state === 'FAILED') {
    const stored = reservation.record.response?.error || {};
    throw new AppError(stored.message || 'The previous protection command failed', {
      statusCode: Number(stored.statusCode) || 409,
      code: stored.code || reservation.record.failureCode || 'PROTECTION_UPDATE_FAILED',
      details: stored.details,
    });
  }
  return null;
}

module.exports = {
  PositionProtectionService,
  normalizeUpdateCommand,
  normalizeBreakEvenCommand,
};
