'use strict';

const { AppError } = require('../../shared/errors/app-error');
const { Position } = require('./position.model');
const { Instrument } = require('../instruments/instrument.model');
const { AccountCommandQueue } = require('./account-command-queue');
const { IdempotencyService } = require('./idempotency.service');
const { runMongoTransaction } = require('./market-order.service');
const { serializePosition } = require('./trading.serializer');
const { planTrailingConfiguration, planTrailingAdvance } = require('./trailing-stop-planner');

class TrailingStopService {
  constructor({ quoteStore, eventBus, logger, positionModel = Position, instrumentModel = Instrument, commandQueue = new AccountCommandQueue(), idempotencyService = new IdempotencyService(), runTransaction = runMongoTransaction }) {
    Object.assign(this, { quoteStore, eventBus, logger, positionModel, instrumentModel, commandQueue, idempotencyService, runTransaction });
  }

  async configure(command) {
    const normalized = normalizeConfigureCommand(command);
    const reservation = await this.idempotencyService.reserve({ accountId: normalized.accountId, scope: 'POSITION_TRAILING', key: normalized.clientRequestId, payload: normalized });
    const replay = resolveReservation(reservation);
    if (replay) return replay;

    try {
      const result = await this.commandQueue.run(normalized.accountId, async () => {
        const snapshot = await loadLean(this.positionModel.findById(normalized.positionId));
        validateOwnership(snapshot, normalized.accountId);
        const quoteSnapshot = normalized.enabled ? this.quoteStore.get(snapshot.symbol) : null;
        const nowMs = Date.now();
        return this.runTransaction(async session => {
          const position = await this.positionModel.findById(normalized.positionId).session(session);
          validateOwnership(position, normalized.accountId);
          const instrument = normalized.enabled ? await this.instrumentModel.findOne({ symbol: String(position.symbol).toUpperCase() }).session(session) : null;
          const plan = planTrailingConfiguration({ position, instrument, quote: quoteSnapshot, enabled: normalized.enabled, distancePoints: normalized.distancePoints, nowMs });
          if (plan.changed) {
            position.stopLoss = plan.stopLoss;
            position.trailing.enabled = plan.enabled;
            position.trailing.distancePoints = plan.distancePoints;
            position.trailing.bestPrice = plan.bestPrice;
            position.trailing.activatedAt = plan.activatedAt;
            await position.save({ session });
          }
          const response = { operation: plan.enabled ? 'TRAILING_ENABLE' : 'TRAILING_DISABLE', changed: plan.changed, position: serializePosition(position) };
          const completed = await this.idempotencyService.complete(reservation.record._id, { resourceType: 'POSITION', resourceId: position.positionId, response }, { session });
          if (!completed) throw new AppError('Idempotency record could not be completed', { statusCode: 409, code: 'IDEMPOTENCY_STATE_CONFLICT' });
          return response;
        });
      });
      if (result.changed) this.#emitUpdated(result.position, result.operation);
      return { ...result, idempotentReplay: false };
    } catch (error) {
      await this.#recordFailure(reservation.record._id, error);
      throw error;
    }
  }

  async advance({ accountId, positionId, tick }) {
    const accountKey = String(accountId);
    const result = await this.commandQueue.run(accountKey, async () => this.runTransaction(async session => {
      const position = await this.positionModel.findById(positionId).session(session);
      if (!position || String(position.accountId) !== accountKey || position.status !== 'OPEN' || !position.trailing?.enabled) return { skipped: true, position: position ? serializePosition(position) : null };
      const instrument = await this.instrumentModel.findOne({ symbol: String(position.symbol).toUpperCase() }).session(session);
      const plan = planTrailingAdvance({ position, instrument, tick, nowMs: Date.now() });
      if (!plan || !plan.changed) return { skipped: true, position: serializePosition(position) };
      if (plan.bestPriceChanged) position.trailing.bestPrice = plan.bestPrice;
      if (plan.stopChanged) position.stopLoss = plan.stopLoss;
      await position.save({ session });
      return { operation: 'TRAILING_ADVANCE', skipped: false, bestPriceChanged: plan.bestPriceChanged, stopChanged: plan.stopChanged, position: serializePosition(position) };
    }));
    if (!result.skipped) this.#emitUpdated(result.position, result.operation);
    return result;
  }

  #emitUpdated(position, operation) {
    this.#emit('trading.position.updated', position);
    this.#emit('trading.position.trailing.updated', { operation, position });
  }

  #emit(name, payload) {
    try { this.eventBus?.emit(name, payload); }
    catch (error) { this.logger?.error({ err: error, event: name }, 'Trailing stop event listener failed'); }
  }

  async #recordFailure(recordId, error) {
    try {
      await this.idempotencyService.fail(recordId, { failureCode: error?.code || 'TRAILING_UPDATE_FAILED', response: { error: { statusCode: error?.statusCode || 500, code: error?.code || 'INTERNAL_ERROR', message: error?.statusCode < 500 || error?.expose === true ? error.message : 'Internal server error', details: error?.details } } });
    } catch (failureError) {
      this.logger?.error({ err: failureError, originalError: error }, 'Failed to record trailing idempotency failure');
    }
  }
}

function normalizeConfigureCommand(command) {
  const enabled = Boolean(command?.enabled);
  const normalized = {
    accountId: String(command?.accountId || '').trim(),
    positionId: String(command?.positionId || '').trim(),
    clientRequestId: String(command?.clientRequestId || '').trim(),
    enabled,
    distancePoints: enabled ? String(command?.distancePoints ?? '').trim() : null,
    source: String(command?.source || 'API').toUpperCase(),
  };
  if (enabled && !normalized.distancePoints) throw new AppError('distancePoints is required when trailing is enabled', { statusCode: 400, code: 'TRAILING_DISTANCE_REQUIRED' });
  return normalized;
}

function validateOwnership(position, accountId) {
  if (!position) throw new AppError('Position was not found', { statusCode: 404, code: 'POSITION_NOT_FOUND' });
  if (String(position.accountId) !== String(accountId)) throw new AppError('Position does not belong to this trading account', { statusCode: 403, code: 'POSITION_ACCOUNT_MISMATCH' });
  if (String(position.status || '').toUpperCase() !== 'OPEN') throw new AppError('Position is not open', { statusCode: 409, code: 'POSITION_NOT_OPEN' });
}

async function loadLean(query) { return typeof query?.lean === 'function' ? query.lean() : query; }

function resolveReservation(reservation) {
  if (reservation.created) return null;
  if (reservation.inProgress) throw new AppError('An identical trailing command is already in progress', { statusCode: 409, code: 'COMMAND_IN_PROGRESS' });
  if (reservation.record.state === 'COMPLETED') return { ...(reservation.record.response || {}), idempotentReplay: true };
  if (reservation.record.state === 'FAILED') {
    const stored = reservation.record.response?.error || {};
    throw new AppError(stored.message || 'The previous trailing command failed', { statusCode: Number(stored.statusCode) || 409, code: stored.code || reservation.record.failureCode || 'TRAILING_UPDATE_FAILED', details: stored.details });
  }
  return null;
}

module.exports = { TrailingStopService, normalizeConfigureCommand };
