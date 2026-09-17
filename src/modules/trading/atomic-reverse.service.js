'use strict';

const { AppError } = require('../../shared/errors/app-error');
const { subtractDecimal, compareDecimal } = require('../../shared/decimal/decimal');
const { normalizeSymbol } = require('../market-data/market.utils');
const { TradingAccount } = require('../accounts/trading-account.model');
const { Instrument } = require('../instruments/instrument.model');
const { Order } = require('./order.model');
const { Deal } = require('./deal.model');
const { Position } = require('./position.model');
const { AccountLedger } = require('./account-ledger.model');
const { AccountCommandQueue } = require('./account-command-queue');
const { IdempotencyService } = require('./idempotency.service');
const { planMarketOpen, planMarketClose, calculateAdverseSlippage } = require('./execution-planner');
const { runMongoTransaction, applyOpenAccountMutation, applyCloseAccountAndPositionMutation } = require('./market-order.service');
const { serializeOrder, serializeDeal, serializePosition, serializeAccount } = require('./trading.serializer');

class AtomicReverseService {
  constructor({ quoteStore, eventBus, valuationEngine, logger, accountModel = TradingAccount, instrumentModel = Instrument, orderModel = Order, dealModel = Deal, positionModel = Position, ledgerModel = AccountLedger, commandQueue = new AccountCommandQueue(), idempotencyService = new IdempotencyService(), runTransaction = runMongoTransaction }) {
    Object.assign(this, { quoteStore, eventBus, valuationEngine, logger, accountModel, instrumentModel, orderModel, dealModel, positionModel, ledgerModel, commandQueue, idempotencyService, runTransaction });
  }

  async reversePosition(command) {
    const normalized = normalizeCommand(command);
    const reservation = await this.idempotencyService.reserve({ accountId: normalized.accountId, scope: 'POSITION_REVERSE_ATOMIC', key: normalized.clientRequestId, payload: normalized });
    const replay = resolveReservation(reservation, normalized.accountId, this.valuationEngine);
    if (replay) return replay;

    try {
      const result = await this.commandQueue.run(normalized.accountId, async () => {
        const nowMs = Date.now();
        const transactionResult = await this.runTransaction(async session => {
          const account = await this.accountModel.findById(normalized.accountId).session(session);
          if (!account) throw new AppError('Trading account was not found', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });
          const valuationProjection = this.valuationEngine ? this.valuationEngine.overlayAccountDocument(account, { requireLive: false }) : null;
          const position = await this.positionModel.findById(normalized.positionId).session(session);
          if (!position) throw new AppError('Position was not found', { statusCode: 404, code: 'POSITION_NOT_FOUND' });
          if (String(position.accountId) !== normalized.accountId) throw new AppError('Position does not belong to this trading account', { statusCode: 403, code: 'POSITION_ACCOUNT_MISMATCH' });
          if (position.status !== 'OPEN') throw new AppError('Position is no longer open', { statusCode: 409, code: 'POSITION_NOT_OPEN' });

          const symbol = normalizeSymbol(position.symbol);
          const instrument = await this.instrumentModel.findOne({ symbol }).session(session);
          const quote = this.quoteStore.get(symbol);
          const originalVolume = String(position.openVolume);
          const oppositeSide = String(position.side).toUpperCase() === 'BUY' ? 'SELL' : 'BUY';
          const closePlan = planMarketClose({ account, instrument, quote, position, volume: null, nowMs });
          const close = await this.#persistClose({ account, position, plan: closePlan, quote, normalized, session, nowMs, valuationComplete: valuationProjection ? valuationProjection.complete : true });

          const openPlan = planMarketOpen({ account, instrument, quote, side: oppositeSide, volume: originalVolume, stopLoss: normalized.stopLoss, takeProfit: normalized.takeProfit, nowMs });
          const open = await this.#persistOpen({ account, plan: openPlan, quote, normalized, session, nowMs });
          const response = {
            operation: 'REVERSE',
            atomic: true,
            originalPositionId: normalized.positionId,
            close,
            open,
            position: open.position,
            account: open.account,
          };
          const completed = await this.idempotencyService.complete(reservation.record._id, { resourceType: 'POSITION', resourceId: open.position.positionId || open.position.id, response }, { session });
          if (!completed) throw new AppError('Idempotency record could not be completed', { statusCode: 409, code: 'IDEMPOTENCY_STATE_CONFLICT' });
          return response;
        });
        this.#emitCommitted(transactionResult);
        return transactionResult;
      });
      return { ...result, valuation: this.valuationEngine?.getAccountSnapshot(normalized.accountId) || null, idempotentReplay: false };
    } catch (error) {
      await this.#recordFailure(reservation.record._id, error);
      throw error;
    }
  }

  async #persistClose({ account, position, plan, quote, normalized, session, nowMs, valuationComplete }) {
    const now = new Date(nowMs);
    const order = new this.orderModel({ accountId: account._id, clientOrderId: `${normalized.clientRequestId}:close`.slice(0, 128), targetPositionId: position._id, symbol: plan.symbol, side: plan.closeSide, type: 'MARKET', status: 'FILLED', requestedVolume: plan.volume, filledVolume: plan.volume, requestedPrice: normalized.requestedPrice, acceptedPrice: plan.fillPrice, source: normalized.source, receivedAt: now, acceptedAt: now, filledAt: now });
    const deal = new this.dealModel({ accountId: account._id, orderId: order._id, positionId: position._id, symbol: plan.symbol, side: plan.closeSide, type: plan.dealType, volume: plan.volume, price: plan.fillPrice, requestedPrice: normalized.requestedPrice, slippage: calculateAdverseSlippage({ side: plan.closeSide, fillPrice: plan.fillPrice, requestedPrice: normalized.requestedPrice }), commission: plan.commission, swap: '0', realizedPnl: plan.realizedPnl, quoteSequence: plan.quoteSequence, quoteReceivedAt: plan.quoteReceivedAtMs ? new Date(plan.quoteReceivedAtMs) : null, quoteSource: quote?.source || null, executedAt: now });
    const ledgers = applyCloseAccountAndPositionMutation({ account, position, plan, deal, clientOrderId: order.clientOrderId, ledgerModel: this.ledgerModel, now, valuationComplete, closeReason: 'REVERSE' });
    await order.save({ session }); await deal.save({ session }); await position.save({ session }); for (const ledger of ledgers) await ledger.save({ session }); await account.save({ session });
    return { order: serializeOrder(order), deal: serializeDeal(deal), position: serializePosition(position), account: serializeAccount(account) };
  }

  async #persistOpen({ account, plan, quote, normalized, session, nowMs }) {
    const now = new Date(nowMs);
    const order = new this.orderModel({ accountId: account._id, clientOrderId: `${normalized.clientRequestId}:open`.slice(0, 128), symbol: plan.symbol, side: plan.side, type: 'MARKET', status: 'FILLED', requestedVolume: plan.volume, filledVolume: plan.volume, stopLoss: plan.stopLoss, takeProfit: plan.takeProfit, requestedPrice: normalized.requestedPrice, acceptedPrice: plan.fillPrice, source: normalized.source, receivedAt: now, acceptedAt: now, filledAt: now });
    const position = new this.positionModel({ accountId: account._id, sourceOrderId: order._id, symbol: plan.symbol, side: plan.side, status: 'OPEN', initialVolume: plan.volume, openVolume: plan.volume, entryPrice: plan.fillPrice, stopLoss: plan.stopLoss, takeProfit: plan.takeProfit, contractSize: plan.contractSize, volumeStep: plan.volumeStep, quoteCurrency: plan.quoteCurrency, margin: plan.requiredMargin, realizedPnl: '0', commissionPaid: plan.commission, swapPaid: '0', openedAt: now });
    const deal = new this.dealModel({ accountId: account._id, orderId: order._id, positionId: position._id, symbol: plan.symbol, side: plan.side, type: 'OPEN', volume: plan.volume, price: plan.fillPrice, requestedPrice: normalized.requestedPrice, slippage: calculateAdverseSlippage({ side: plan.side, fillPrice: plan.fillPrice, requestedPrice: normalized.requestedPrice }), commission: plan.commission, swap: '0', realizedPnl: '0', quoteSequence: plan.quoteSequence, quoteReceivedAt: plan.quoteReceivedAtMs ? new Date(plan.quoteReceivedAtMs) : null, quoteSource: quote?.source || null, executedAt: now });
    applyOpenAccountMutation(account, plan);
    const ledgers = [];
    if (compareDecimal(plan.commission, '0') > 0) ledgers.push(new this.ledgerModel({ accountId: account._id, type: 'COMMISSION', amount: subtractDecimal('0', plan.commission), balanceBefore: String(Number(account.state.balance.toString()) + Number(plan.commission)), balanceAfter: account.state.balance, currency: account.currency, referenceType: 'DEAL', referenceId: deal.dealId, idempotencyKey: `${order.clientOrderId}:commission`, reason: 'Execution commission' }));
    await order.save({ session }); await position.save({ session }); await deal.save({ session }); for (const ledger of ledgers) await ledger.save({ session }); await account.save({ session });
    return { order: serializeOrder(order), deal: serializeDeal(deal), position: serializePosition(position), account: serializeAccount(account) };
  }

  #emitCommitted(result) {
    const close = result.close; const open = result.open;
    const events = [['trading.order.accepted', close.order], ['trading.order.filled', close.order], ['trading.deal.created', close.deal], ['trading.position.closed', close.position], ['trading.order.accepted', open.order], ['trading.order.filled', open.order], ['trading.deal.created', open.deal], ['trading.position.opened', open.position], ['trading.account.updated', open.account]];
    for (const [name, payload] of events) { try { this.eventBus?.emit(name, payload); } catch (error) { this.logger?.error({ err: error, event: name }, 'Atomic reverse event listener failed after commit'); } }
  }

  async #recordFailure(recordId, error) {
    try { await this.idempotencyService.fail(recordId, { failureCode: error?.code || 'REVERSE_FAILED', response: { error: { statusCode: error?.statusCode || 500, code: error?.code || 'REVERSE_FAILED', message: error?.message || 'Atomic reverse failed', details: error?.details } } }); } catch (failureError) { this.logger?.error({ err: failureError }, 'Failed to record atomic reverse failure'); }
  }
}

function normalizeCommand(command) { return { accountId: String(command?.accountId || '').trim(), positionId: String(command?.positionId || '').trim(), clientRequestId: String(command?.clientRequestId || '').trim(), requestedPrice: nullable(command?.requestedPrice), stopLoss: nullable(command?.stopLoss), takeProfit: nullable(command?.takeProfit), source: ['WEB', 'MOBILE', 'API'].includes(String(command?.source || '').toUpperCase()) ? String(command.source).toUpperCase() : 'API' }; }
function nullable(value) { return value === null || value === undefined || value === '' ? null : String(value); }
function resolveReservation(reservation, accountId, valuationEngine) { if (reservation.created) return null; if (reservation.inProgress) throw new AppError('An identical reverse command is already in progress', { statusCode: 409, code: 'COMMAND_IN_PROGRESS' }); if (reservation.record.state === 'COMPLETED') return { ...(reservation.record.response || {}), valuation: valuationEngine?.getAccountSnapshot(accountId) || null, idempotentReplay: true }; const stored = reservation.record.response?.error || {}; throw new AppError(stored.message || 'Previous reverse attempt failed', { statusCode: Number(stored.statusCode) || 409, code: stored.code || reservation.record.failureCode || 'REVERSE_FAILED', details: stored.details }); }

module.exports = { AtomicReverseService };