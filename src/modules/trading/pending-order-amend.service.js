'use strict';

const { AppError } = require('../../shared/errors/app-error');
const { normalizeSymbol } = require('../market-data/market.utils');
const { TradingAccount } = require('../accounts/trading-account.model');
const { Instrument } = require('../instruments/instrument.model');
const { Order } = require('./order.model');
const { AccountCommandQueue } = require('./account-command-queue');
const { IdempotencyService } = require('./idempotency.service');
const { planPendingOrder } = require('./pending-order-planner');
const { runMongoTransaction } = require('./market-order.service');
const { serializeOrder } = require('./trading.serializer');

class PendingOrderAmendService {
  constructor({ quoteStore, eventBus, logger, accountModel = TradingAccount, instrumentModel = Instrument, orderModel = Order, commandQueue = new AccountCommandQueue(), idempotencyService = new IdempotencyService(), runTransaction = runMongoTransaction }) {
    Object.assign(this, { quoteStore, eventBus, logger, accountModel, instrumentModel, orderModel, commandQueue, idempotencyService, runTransaction });
  }

  async amend(command) {
    const normalized = normalize(command);
    const reservation = await this.idempotencyService.reserve({ accountId: normalized.accountId, scope: 'PENDING_AMEND', key: normalized.clientRequestId, payload: normalized });
    const replay = resolveReservation(reservation);
    if (replay) return replay;

    try {
      const result = await this.commandQueue.run(normalized.accountId, () => this.runTransaction(async session => {
        const order = await this.orderModel.findById(normalized.orderId).session(session);
        if (!order) throw new AppError('Order was not found', { statusCode: 404, code: 'ORDER_NOT_FOUND' });
        if (String(order.accountId) !== normalized.accountId) throw new AppError('Order does not belong to this trading account', { statusCode: 403, code: 'ORDER_ACCOUNT_MISMATCH' });
        if (String(order.status).toUpperCase() !== 'PENDING') {
          throw new AppError('Only pending orders can be amended', { statusCode: 409, code: 'ORDER_NOT_AMENDABLE', details: { status: order.status } });
        }

        const account = await this.accountModel.findById(normalized.accountId).session(session);
        const symbol = normalizeSymbol(order.symbol);
        const instrument = await this.instrumentModel.findOne({ symbol }).session(session);
        const quote = this.quoteStore.get(symbol);
        const merged = {
          type: order.type,
          side: order.side,
          volume: normalized.volume ?? String(order.requestedVolume),
          limitPrice: normalized.limitPrice !== undefined ? normalized.limitPrice : value(order.limitPrice),
          stopPrice: normalized.stopPrice !== undefined ? normalized.stopPrice : value(order.stopPrice),
          stopLoss: normalized.stopLoss !== undefined ? normalized.stopLoss : value(order.stopLoss),
          takeProfit: normalized.takeProfit !== undefined ? normalized.takeProfit : value(order.takeProfit),
          timeInForce: normalized.timeInForce ?? order.timeInForce,
          expiresAt: normalized.expiresAt !== undefined ? normalized.expiresAt : order.expiresAt,
        };
        const plan = planPendingOrder({ account, instrument, quote, type: merged.type, side: merged.side, volume: merged.volume, limitPrice: merged.limitPrice, stopPrice: merged.stopPrice, stopLoss: merged.stopLoss, takeProfit: merged.takeProfit, timeInForce: merged.timeInForce, expiresAt: merged.expiresAt, nowMs: Date.now() });

        order.requestedVolume = plan.volume;
        order.limitPrice = plan.limitPrice;
        order.stopPrice = plan.stopPrice;
        order.stopLoss = plan.stopLoss;
        order.takeProfit = plan.takeProfit;
        order.timeInForce = plan.timeInForce;
        order.expiresAt = plan.expiresAt;
        await order.save({ session });
        const response = { operation: 'PENDING_AMEND', order: serializeOrder(order) };
        const completed = await this.idempotencyService.complete(reservation.record._id, { resourceType: 'ORDER', resourceId: order.orderId, response }, { session });
        if (!completed) throw new AppError('Idempotency record could not be completed', { statusCode: 409, code: 'IDEMPOTENCY_STATE_CONFLICT' });
        return response;
      }));
      this.#emit('trading.order.updated', result.order);
      return { ...result, idempotentReplay: false };
    } catch (error) {
      try { await this.idempotencyService.fail(reservation.record._id, { failureCode: error?.code || 'PENDING_AMEND_FAILED', response: { error: { statusCode: error?.statusCode || 500, code: error?.code || 'PENDING_AMEND_FAILED', message: error?.message || 'Pending order amendment failed' } } }); } catch (failureError) { this.logger?.error({ err: failureError }, 'Failed to record pending amendment failure'); }
      throw error;
    }
  }

  #emit(name, payload) { try { this.eventBus?.emit(name, payload); } catch (error) { this.logger?.error({ err: error, event: name }, 'Pending amendment event listener failed'); } }
}

function value(input) { return input === null || input === undefined ? null : String(input); }
function patchValue(input) { return input === undefined ? undefined : input === null || input === '' ? null : String(input); }
function normalize(command) { return { accountId: String(command?.accountId || '').trim(), orderId: String(command?.orderId || '').trim(), clientRequestId: String(command?.clientRequestId || '').trim(), volume: patchValue(command?.volume), limitPrice: patchValue(command?.limitPrice), stopPrice: patchValue(command?.stopPrice), stopLoss: patchValue(command?.stopLoss), takeProfit: patchValue(command?.takeProfit), timeInForce: command?.timeInForce === undefined ? undefined : String(command.timeInForce).toUpperCase(), expiresAt: command?.expiresAt === undefined ? undefined : command.expiresAt }; }
function resolveReservation(reservation) { if (reservation.created) return null; if (reservation.inProgress) throw new AppError('An identical amend command is already in progress', { statusCode: 409, code: 'COMMAND_IN_PROGRESS' }); if (reservation.record.state === 'COMPLETED') return { ...(reservation.record.response || {}), idempotentReplay: true }; const stored = reservation.record.response?.error || {}; throw new AppError(stored.message || 'Previous amendment failed', { statusCode: Number(stored.statusCode) || 409, code: stored.code || reservation.record.failureCode || 'PENDING_AMEND_FAILED' }); }

module.exports = { PendingOrderAmendService };
