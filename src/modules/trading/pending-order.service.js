'use strict';

const { AppError } = require('../../shared/errors/app-error');
const {
  compareDecimal,
  subtractDecimal,
} = require('../../shared/decimal/decimal');
const { normalizeSymbol } = require('../market-data/market.utils');
const { TradingAccount } = require('../accounts/trading-account.model');
const { Instrument } = require('../instruments/instrument.model');
const { Order } = require('./order.model');
const { Deal } = require('./deal.model');
const { Position } = require('./position.model');
const { AccountLedger } = require('./account-ledger.model');
const { AccountCommandQueue } = require('./account-command-queue');
const { IdempotencyService } = require('./idempotency.service');
const {
  planMarketOpen,
  calculateAdverseSlippage,
} = require('./execution-planner');
const {
  planPendingOrder,
  detectPendingOrderAction,
} = require('./pending-order-planner');
const {
  runMongoTransaction,
  applyOpenAccountMutation,
} = require('./market-order.service');
const {
  serializeOrder,
  serializeDeal,
  serializePosition,
  serializeAccount,
} = require('./trading.serializer');

const ACTIVE_PENDING_STATUSES = Object.freeze(['PENDING', 'TRIGGERED']);
const PERMANENT_TRIGGER_REJECTIONS = new Set([
  'ACCOUNT_NOT_FOUND',
  'ACCOUNT_NOT_ACTIVE',
  'ACCOUNT_TRADING_DISABLED',
  'SYMBOL_NOT_ALLOWED',
  'INSTRUMENT_NOT_FOUND',
  'INSTRUMENT_NOT_ACTIVE',
  'INSTRUMENT_EXECUTION_DISABLED',
  'INVALID_VOLUME',
  'INVALID_VOLUME_RANGE',
  'INVALID_VOLUME_STEP',
  'INVALID_PROTECTION_PRICE',
  'INVALID_LEVERAGE',
  'INSUFFICIENT_MARGIN',
  'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE',
]);

class PendingOrderService {
  constructor({
    quoteStore,
    eventBus,
    valuationEngine,
    logger,
    accountModel = TradingAccount,
    instrumentModel = Instrument,
    orderModel = Order,
    dealModel = Deal,
    positionModel = Position,
    ledgerModel = AccountLedger,
    commandQueue = new AccountCommandQueue(),
    idempotencyService = new IdempotencyService(),
    runTransaction = runMongoTransaction,
  }) {
    Object.assign(this, {
      quoteStore,
      eventBus,
      valuationEngine,
      logger,
      accountModel,
      instrumentModel,
      orderModel,
      dealModel,
      positionModel,
      ledgerModel,
      commandQueue,
      idempotencyService,
      runTransaction,
    });
  }

  async placePendingOrder(command) {
    const normalized = normalizePlaceCommand(command);
    const reservation = await this.idempotencyService.reserve({
      accountId: normalized.accountId,
      scope: 'PENDING_CREATE',
      key: normalized.clientOrderId,
      payload: normalized,
    });
    const replay = resolveReservation(reservation);
    if (replay) return replay;

    try {
      const result = await this.commandQueue.run(normalized.accountId, async () => {
        const nowMs = Date.now();
        const quoteSnapshot = this.quoteStore.get(normalized.symbol);
        return this.runTransaction(async session => {
          const account = await this.accountModel.findById(normalized.accountId).session(session);
          const instrument = await this.instrumentModel.findOne({ symbol: normalized.symbol }).session(session);
          const plan = planPendingOrder({
            account,
            instrument,
            quote: quoteSnapshot,
            type: normalized.type,
            side: normalized.side,
            volume: normalized.volume,
            limitPrice: normalized.limitPrice,
            stopPrice: normalized.stopPrice,
            stopLoss: normalized.stopLoss,
            takeProfit: normalized.takeProfit,
            timeInForce: normalized.timeInForce,
            expiresAt: normalized.expiresAt,
            nowMs,
          });

          const now = new Date(nowMs);
          const order = new this.orderModel({
            accountId: account._id,
            clientOrderId: normalized.clientOrderId,
            symbol: plan.symbol,
            side: plan.side,
            type: plan.type,
            status: 'PENDING',
            requestedVolume: plan.volume,
            filledVolume: '0',
            limitPrice: plan.limitPrice,
            stopPrice: plan.stopPrice,
            stopLoss: plan.stopLoss,
            takeProfit: plan.takeProfit,
            timeInForce: plan.timeInForce,
            expiresAt: plan.expiresAt,
            source: normalized.source,
            receivedAt: now,
            acceptedAt: now,
          });

          await order.save({ session });
          const response = { operation: 'PENDING_CREATE', order: serializeOrder(order) };
          const completed = await this.idempotencyService.complete(
            reservation.record._id,
            { resourceType: 'ORDER', resourceId: order.orderId, response },
            { session },
          );
          if (!completed) throw new AppError('Idempotency record could not be completed', { statusCode: 409, code: 'IDEMPOTENCY_STATE_CONFLICT' });
          return response;
        });
      });

      this.#emit('trading.order.pending', result.order);
      return { ...result, idempotentReplay: false };
    } catch (error) {
      await this.#recordFailure(reservation.record._id, error);
      throw error;
    }
  }

  async cancelPendingOrder(command) {
    const normalized = normalizeCancelCommand(command);
    const reservation = await this.idempotencyService.reserve({
      accountId: normalized.accountId,
      scope: 'PENDING_CANCEL',
      key: normalized.clientRequestId,
      payload: normalized,
    });
    const replay = resolveReservation(reservation);
    if (replay) return replay;

    try {
      const response = await this.commandQueue.run(normalized.accountId, () => this.runTransaction(async session => {
        const order = await this.orderModel.findById(normalized.orderId).session(session);
        if (!order) throw new AppError('Order was not found', { statusCode: 404, code: 'ORDER_NOT_FOUND' });
        if (String(order.accountId) !== normalized.accountId) {
          throw new AppError('Order does not belong to this trading account', { statusCode: 403, code: 'ORDER_ACCOUNT_MISMATCH' });
        }
        if (!ACTIVE_PENDING_STATUSES.includes(order.status)) {
          throw new AppError('Order is no longer cancellable', { statusCode: 409, code: 'ORDER_NOT_CANCELLABLE', details: { status: order.status } });
        }

        order.status = 'CANCELLED';
        order.cancelledAt = new Date();
        await order.save({ session });
        const result = { operation: 'PENDING_CANCEL', order: serializeOrder(order) };
        const completed = await this.idempotencyService.complete(
          reservation.record._id,
          { resourceType: 'ORDER', resourceId: order.orderId, response: result },
          { session },
        );
        if (!completed) throw new AppError('Idempotency record could not be completed', { statusCode: 409, code: 'IDEMPOTENCY_STATE_CONFLICT' });
        return result;
      }));

      this.#emit('trading.order.cancelled', response.order);
      return { ...response, idempotentReplay: false };
    } catch (error) {
      await this.#recordFailure(reservation.record._id, error);
      throw error;
    }
  }

  async listPendingOrders(accountId) {
    const orders = await this.orderModel.find({ accountId, status: { $in: ACTIVE_PENDING_STATUSES } })
      .sort({ createdAt: -1 })
      .lean();
    return orders.map(serializeOrder);
  }

  async activateStopLimit({ accountId, orderId, tick }) {
    return this.commandQueue.run(String(accountId), async () => {
      const result = await this.runTransaction(async session => {
        const order = await this.orderModel.findById(orderId).session(session);
        if (!order || String(order.accountId) !== String(accountId)) return { skipped: true, order: order ? serializeOrder(order) : null };
        if (order.type !== 'STOP_LIMIT' || order.status !== 'PENDING') return { skipped: true, order: serializeOrder(order) };

        const action = detectPendingOrderAction({ order, tick, nowMs: Date.now() });
        if (action?.action === 'EXPIRE') return this.#expireWithinTransaction(order, session);
        if (action?.action !== 'ACTIVATE') return { skipped: true, order: serializeOrder(order) };

        order.status = 'TRIGGERED';
        order.triggeredAt = new Date();
        await order.save({ session });
        return { operation: 'STOP_LIMIT_TRIGGERED', order: serializeOrder(order), skipped: false };
      });
      if (!result.skipped && result.operation === 'STOP_LIMIT_TRIGGERED') this.#emit('trading.order.triggered', result.order);
      if (!result.skipped && result.operation === 'PENDING_EXPIRE') this.#emit('trading.order.expired', result.order);
      return result;
    });
  }

  async executePendingOrder({ accountId, orderId, tick }) {
    return this.commandQueue.run(String(accountId), async () => {
      const result = await this.runTransaction(async session => {
        const order = await this.orderModel.findById(orderId).session(session);
        if (!order || String(order.accountId) !== String(accountId)) return { skipped: true, order: order ? serializeOrder(order) : null };
        if (!ACTIVE_PENDING_STATUSES.includes(order.status)) return { skipped: true, order: serializeOrder(order) };

        const action = detectPendingOrderAction({ order, tick, nowMs: Date.now() });
        if (action?.action === 'EXPIRE') return this.#expireWithinTransaction(order, session);
        if (action?.action !== 'FILL') return { skipped: true, order: serializeOrder(order) };

        const account = await this.accountModel.findById(accountId).session(session);
        if (account && this.valuationEngine) this.valuationEngine.overlayAccountDocument(account, { requireLive: true });
        const instrument = await this.instrumentModel.findOne({ symbol: normalizeSymbol(order.symbol) }).session(session);

        let plan;
        try {
          plan = planMarketOpen({
            account,
            instrument,
            quote: tick,
            side: order.side,
            volume: order.requestedVolume,
            stopLoss: order.stopLoss,
            takeProfit: order.takeProfit,
            nowMs: Date.now(),
          });
        } catch (error) {
          if (!PERMANENT_TRIGGER_REJECTIONS.has(error?.code)) throw error;
          order.status = 'REJECTED';
          order.rejectCode = error.code || 'PENDING_EXECUTION_REJECTED';
          order.rejectMessage = error.message || 'Pending order execution rejected';
          order.rejectedAt = new Date();
          await order.save({ session });
          return { operation: 'PENDING_REJECT', order: serializeOrder(order), skipped: false };
        }

        const now = new Date();
        if ((order.type === 'STOP' || order.type === 'STOP_LIMIT') && !order.triggeredAt) order.triggeredAt = now;
        order.status = 'FILLED';
        order.filledVolume = plan.volume;
        order.acceptedPrice = plan.fillPrice;
        order.filledAt = now;

        const position = new this.positionModel({
          accountId: account._id,
          sourceOrderId: order._id,
          symbol: plan.symbol,
          side: plan.side,
          status: 'OPEN',
          initialVolume: plan.volume,
          openVolume: plan.volume,
          entryPrice: plan.fillPrice,
          stopLoss: plan.stopLoss,
          takeProfit: plan.takeProfit,
          contractSize: plan.contractSize,
          volumeStep: plan.volumeStep,
          quoteCurrency: plan.quoteCurrency,
          margin: plan.requiredMargin,
          realizedPnl: '0',
          commissionPaid: plan.commission,
          swapPaid: '0',
          openedAt: now,
        });

        const requestedPrice = pendingRequestedPrice(order);
        const deal = new this.dealModel({
          accountId: account._id,
          orderId: order._id,
          positionId: position._id,
          symbol: plan.symbol,
          side: plan.side,
          type: 'OPEN',
          volume: plan.volume,
          price: plan.fillPrice,
          requestedPrice,
          slippage: calculateAdverseSlippage({ side: plan.side, fillPrice: plan.fillPrice, requestedPrice }),
          commission: plan.commission,
          swap: '0',
          realizedPnl: '0',
          quoteSequence: plan.quoteSequence,
          quoteReceivedAt: plan.quoteReceivedAtMs ? new Date(plan.quoteReceivedAtMs) : null,
          quoteSource: tick?.source || null,
          executedAt: now,
        });

        applyOpenAccountMutation(account, plan);
        const ledgers = [];
        if (compareDecimal(plan.commission, '0') > 0) {
          ledgers.push(new this.ledgerModel({
            accountId: account._id,
            type: 'COMMISSION',
            amount: subtractDecimal('0', plan.commission),
            balanceBefore: String(Number.NaN),
            balanceAfter: account.state.balance,
            currency: account.currency,
            referenceType: 'DEAL',
            referenceId: deal.dealId,
            idempotencyKey: `pending:${order.orderId}:commission`,
            reason: 'Execution commission',
          }));
          ledgers[0].balanceBefore = require('../../shared/decimal/decimal').addDecimal(account.state.balance, plan.commission);
        }

        await order.save({ session });
        await position.save({ session });
        await deal.save({ session });
        for (const ledger of ledgers) await ledger.save({ session });
        await account.save({ session });

        return {
          operation: 'PENDING_FILL',
          skipped: false,
          order: serializeOrder(order),
          deal: serializeDeal(deal),
          position: serializePosition(position),
          account: serializeAccount(account),
        };
      });

      this.#emitResult(result);
      return result;
    });
  }

  async expirePendingOrder({ accountId, orderId, nowMs = Date.now() }) {
    return this.commandQueue.run(String(accountId), async () => {
      const result = await this.runTransaction(async session => {
        const order = await this.orderModel.findById(orderId).session(session);
        if (!order || String(order.accountId) !== String(accountId)) return { skipped: true, order: order ? serializeOrder(order) : null };
        if (!ACTIVE_PENDING_STATUSES.includes(order.status)) return { skipped: true, order: serializeOrder(order) };
        if (!order.expiresAt || new Date(order.expiresAt).getTime() > nowMs) return { skipped: true, order: serializeOrder(order) };
        return this.#expireWithinTransaction(order, session);
      });
      if (!result.skipped && result.operation === 'PENDING_EXPIRE') this.#emit('trading.order.expired', result.order);
      return result;
    });
  }

  async #expireWithinTransaction(order, session) {
    order.status = 'EXPIRED';
    order.expiredAt = new Date();
    await order.save({ session });
    return { operation: 'PENDING_EXPIRE', order: serializeOrder(order), skipped: false };
  }

  #emitResult(result) {
    if (!result || result.skipped) return;
    if (result.operation === 'PENDING_REJECT') {
      this.#emit('trading.order.rejected', result.order);
      return;
    }
    if (result.operation === 'PENDING_EXPIRE') {
      this.#emit('trading.order.expired', result.order);
      return;
    }
    if (result.operation === 'PENDING_FILL') {
      this.#emit('trading.order.filled', result.order);
      this.#emit('trading.deal.created', result.deal);
      this.#emit('trading.position.opened', result.position);
      this.#emit('trading.account.updated', result.account);
    }
  }

  #emit(name, payload) {
    try {
      this.eventBus?.emit(name, payload);
    } catch (error) {
      this.logger?.error({ err: error, event: name }, 'Pending order event listener failed');
    }
  }

  async #recordFailure(recordId, error) {
    try {
      await this.idempotencyService.fail(recordId, {
        failureCode: error?.code || 'COMMAND_FAILED',
        response: { error: { statusCode: error?.statusCode || 500, code: error?.code || 'INTERNAL_ERROR', message: error?.message || 'Internal server error' } },
      });
    } catch (failureError) {
      this.logger?.error({ err: failureError, originalError: error }, 'Failed to record pending-order idempotency failure');
    }
  }
}

function resolveReservation(reservation) {
  if (reservation.created) return null;
  if (reservation.inProgress) throw new AppError('An identical trading command is already in progress', { statusCode: 409, code: 'COMMAND_IN_PROGRESS' });
  if (reservation.record.state === 'COMPLETED') return { ...(reservation.record.response || {}), idempotentReplay: true };
  if (reservation.record.state === 'FAILED') {
    const stored = reservation.record.response?.error || {};
    throw new AppError(stored.message || 'The previous command attempt failed', {
      statusCode: Number(stored.statusCode) || 409,
      code: stored.code || reservation.record.failureCode || 'COMMAND_FAILED',
    });
  }
  return null;
}

function pendingRequestedPrice(order) {
  if (order.type === 'STOP') return order.stopPrice;
  return order.limitPrice;
}

function normalizePlaceCommand(command) {
  return {
    accountId: String(command?.accountId || '').trim(),
    clientOrderId: String(command?.clientOrderId || '').trim(),
    symbol: normalizeSymbol(command?.symbol),
    type: String(command?.type || '').toUpperCase(),
    side: String(command?.side || '').toUpperCase(),
    volume: String(command?.volume ?? '').trim(),
    limitPrice: nullableString(command?.limitPrice),
    stopPrice: nullableString(command?.stopPrice),
    stopLoss: nullableString(command?.stopLoss),
    takeProfit: nullableString(command?.takeProfit),
    timeInForce: String(command?.timeInForce || 'GTC').toUpperCase(),
    expiresAt: command?.expiresAt || null,
    source: normalizeSource(command?.source),
  };
}

function normalizeCancelCommand(command) {
  return {
    accountId: String(command?.accountId || '').trim(),
    orderId: String(command?.orderId || '').trim(),
    clientRequestId: String(command?.clientRequestId || '').trim(),
  };
}

function nullableString(value) {
  return value === null || value === undefined || value === '' ? null : String(value).trim();
}
function normalizeSource(source) {
  const value = String(source || 'API').toUpperCase();
  return ['WEB', 'MOBILE', 'API', 'SYSTEM'].includes(value) ? value : 'API';
}

module.exports = {
  PendingOrderService,
  ACTIVE_PENDING_STATUSES,
  PERMANENT_TRIGGER_REJECTIONS,
};
