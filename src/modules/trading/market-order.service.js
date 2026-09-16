'use strict';

const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/app-error');
const {
  normalizeDecimal,
  addDecimal,
  subtractDecimal,
  compareDecimal,
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
  planMarketClose,
  calculateAdverseSlippage,
} = require('./execution-planner');
const {
  serializeOrder,
  serializeDeal,
  serializePosition,
  serializeAccount,
} = require('./trading.serializer');

class MarketOrderService {
  constructor({
    quoteStore,
    eventBus,
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
    this.quoteStore = quoteStore;
    this.eventBus = eventBus;
    this.logger = logger;
    this.accountModel = accountModel;
    this.instrumentModel = instrumentModel;
    this.orderModel = orderModel;
    this.dealModel = dealModel;
    this.positionModel = positionModel;
    this.ledgerModel = ledgerModel;
    this.commandQueue = commandQueue;
    this.idempotencyService = idempotencyService;
    this.runTransaction = runTransaction;
  }

  async openMarketOrder(command) {
    const normalized = normalizeOpenCommand(command);
    const reservation = await this.idempotencyService.reserve({
      accountId: normalized.accountId,
      scope: 'MARKET_OPEN',
      key: normalized.clientOrderId,
      payload: normalized,
    });
    const replay = this.#resolveReservation(reservation);
    if (replay) return replay;

    try {
      const result = await this.commandQueue.run(normalized.accountId, async () => {
        const nowMs = Date.now();
        const quoteSnapshot = this.quoteStore.get(normalized.symbol);

        return this.runTransaction(async session => {
          const account = await this.accountModel.findById(normalized.accountId).session(session);
          const instrument = await this.instrumentModel.findOne({ symbol: normalized.symbol }).session(session);
          const plan = planMarketOpen({
            account,
            instrument,
            quote: quoteSnapshot,
            side: normalized.side,
            volume: normalized.volume,
            stopLoss: normalized.stopLoss,
            takeProfit: normalized.takeProfit,
            nowMs,
          });

          const now = new Date(nowMs);
          const slippage = calculateAdverseSlippage({
            side: plan.side,
            fillPrice: plan.fillPrice,
            requestedPrice: normalized.requestedPrice,
          });

          const order = new this.orderModel({
            accountId: account._id,
            clientOrderId: normalized.clientOrderId,
            symbol: plan.symbol,
            side: plan.side,
            type: 'MARKET',
            status: 'FILLED',
            requestedVolume: plan.volume,
            filledVolume: plan.volume,
            stopLoss: plan.stopLoss,
            takeProfit: plan.takeProfit,
            requestedPrice: normalized.requestedPrice,
            acceptedPrice: plan.fillPrice,
            source: normalized.source,
            receivedAt: now,
            acceptedAt: now,
            filledAt: now,
          });

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

          const deal = new this.dealModel({
            accountId: account._id,
            orderId: order._id,
            positionId: position._id,
            symbol: plan.symbol,
            side: plan.side,
            type: 'OPEN',
            volume: plan.volume,
            price: plan.fillPrice,
            requestedPrice: normalized.requestedPrice,
            slippage,
            commission: plan.commission,
            swap: '0',
            realizedPnl: '0',
            quoteSequence: plan.quoteSequence,
            quoteReceivedAt: plan.quoteReceivedAtMs ? new Date(plan.quoteReceivedAtMs) : null,
            quoteSource: quoteSnapshot?.source || null,
            executedAt: now,
          });

          const ledgerEntries = [];
          applyOpenAccountMutation(account, plan);
          if (compareDecimal(plan.commission, '0') > 0) {
            ledgerEntries.push(new this.ledgerModel(buildCommissionLedger({
              account,
              amount: plan.commission,
              balanceAfter: account.state.balance,
              referenceId: deal.dealId,
              idempotencyKey: `${normalized.clientOrderId}:open:commission`,
            })));
          }

          await order.save({ session });
          await position.save({ session });
          await deal.save({ session });
          for (const ledger of ledgerEntries) await ledger.save({ session });
          await account.save({ session });

          const response = {
            operation: 'OPEN',
            order: serializeOrder(order),
            deal: serializeDeal(deal),
            position: serializePosition(position),
            account: serializeAccount(account),
          };

          const completed = await this.idempotencyService.complete(
            reservation.record._id,
            { resourceType: 'ORDER', resourceId: order.orderId, response },
            { session },
          );
          if (!completed) throw new AppError('Idempotency record could not be completed', { statusCode: 409, code: 'IDEMPOTENCY_STATE_CONFLICT' });

          return { response, events: openEvents(response) };
        });
      });

      this.#emitEvents(result.events);
      return { ...result.response, idempotentReplay: false };
    } catch (error) {
      await this.#recordFailure(reservation.record._id, error);
      throw translateTransactionError(error);
    }
  }

  async closeMarketPosition(command) {
    const normalized = normalizeCloseCommand(command);
    const reservation = await this.idempotencyService.reserve({
      accountId: normalized.accountId,
      scope: 'MARKET_CLOSE',
      key: normalized.clientOrderId,
      payload: normalized,
    });
    const replay = this.#resolveReservation(reservation);
    if (replay) return replay;

    try {
      const result = await this.commandQueue.run(normalized.accountId, async () => {
        const nowMs = Date.now();
        let quoteSnapshot = null;

        return this.runTransaction(async session => {
          const account = await this.accountModel.findById(normalized.accountId).session(session);
          if (!account) throw new AppError('Trading account was not found', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });

          const position = await this.positionModel.findById(normalized.positionId).session(session);
          if (!position) throw new AppError('Position was not found', { statusCode: 404, code: 'POSITION_NOT_FOUND' });

          const instrument = await this.instrumentModel.findOne({ symbol: normalizeSymbol(position.symbol) }).session(session);
          if (!quoteSnapshot) quoteSnapshot = this.quoteStore.get(position.symbol);

          const plan = planMarketClose({
            account,
            instrument,
            quote: quoteSnapshot,
            position,
            volume: normalized.volume,
            nowMs,
          });

          const now = new Date(nowMs);
          const slippage = calculateAdverseSlippage({
            side: plan.closeSide,
            fillPrice: plan.fillPrice,
            requestedPrice: normalized.requestedPrice,
          });

          const order = new this.orderModel({
            accountId: account._id,
            clientOrderId: normalized.clientOrderId,
            targetPositionId: position._id,
            symbol: plan.symbol,
            side: plan.closeSide,
            type: 'MARKET',
            status: 'FILLED',
            requestedVolume: plan.volume,
            filledVolume: plan.volume,
            requestedPrice: normalized.requestedPrice,
            acceptedPrice: plan.fillPrice,
            source: normalized.source,
            receivedAt: now,
            acceptedAt: now,
            filledAt: now,
          });

          const deal = new this.dealModel({
            accountId: account._id,
            orderId: order._id,
            positionId: position._id,
            symbol: plan.symbol,
            side: plan.closeSide,
            type: plan.dealType,
            volume: plan.volume,
            price: plan.fillPrice,
            requestedPrice: normalized.requestedPrice,
            slippage,
            commission: plan.commission,
            swap: '0',
            realizedPnl: plan.realizedPnl,
            quoteSequence: plan.quoteSequence,
            quoteReceivedAt: plan.quoteReceivedAtMs ? new Date(plan.quoteReceivedAtMs) : null,
            quoteSource: quoteSnapshot?.source || null,
            executedAt: now,
          });

          const ledgerEntries = applyCloseAccountAndPositionMutation({
            account,
            position,
            plan,
            deal,
            clientOrderId: normalized.clientOrderId,
            ledgerModel: this.ledgerModel,
            now,
          });

          await order.save({ session });
          await deal.save({ session });
          await position.save({ session });
          for (const ledger of ledgerEntries) await ledger.save({ session });
          await account.save({ session });

          const response = {
            operation: plan.fullClose ? 'CLOSE' : 'PARTIAL_CLOSE',
            order: serializeOrder(order),
            deal: serializeDeal(deal),
            position: serializePosition(position),
            account: serializeAccount(account),
          };

          const completed = await this.idempotencyService.complete(
            reservation.record._id,
            { resourceType: 'ORDER', resourceId: order.orderId, response },
            { session },
          );
          if (!completed) throw new AppError('Idempotency record could not be completed', { statusCode: 409, code: 'IDEMPOTENCY_STATE_CONFLICT' });

          return { response, events: closeEvents(response, plan.fullClose) };
        });
      });

      this.#emitEvents(result.events);
      return { ...result.response, idempotentReplay: false };
    } catch (error) {
      await this.#recordFailure(reservation.record._id, error);
      throw translateTransactionError(error);
    }
  }

  #resolveReservation(reservation) {
    if (reservation.created) return null;
    if (reservation.inProgress) {
      throw new AppError('An identical trading command is already in progress', {
        statusCode: 409,
        code: 'COMMAND_IN_PROGRESS',
      });
    }
    if (reservation.record.state === 'COMPLETED') {
      return { ...(reservation.record.response || {}), idempotentReplay: true };
    }
    if (reservation.record.state === 'FAILED') {
      const stored = reservation.record.response?.error || {};
      throw new AppError(stored.message || 'The previous command attempt failed', {
        statusCode: Number(stored.statusCode) || 409,
        code: stored.code || reservation.record.failureCode || 'COMMAND_FAILED',
        details: stored.details,
      });
    }
    return null;
  }

  async #recordFailure(recordId, error) {
    try {
      const translated = translateTransactionError(error);
      await this.idempotencyService.fail(recordId, {
        failureCode: translated.code || 'COMMAND_FAILED',
        response: {
          error: {
            statusCode: translated.statusCode || 500,
            code: translated.code || 'INTERNAL_ERROR',
            message: translated.expose === true || translated.statusCode < 500 ? translated.message : 'Internal server error',
            details: translated.details,
          },
        },
      });
    } catch (failureError) {
      this.logger?.error({ err: failureError, originalError: error }, 'Failed to record idempotent trading command failure');
    }
  }

  #emitEvents(events) {
    for (const [name, payload] of events) {
      try {
        this.eventBus?.emit(name, payload);
      } catch (error) {
        this.logger?.error({ err: error, event: name }, 'Trading event listener failed after committed execution');
      }
    }
  }
}

function applyOpenAccountMutation(account, plan) {
  const balanceBefore = normalizeDecimal(account.state.balance);
  const equityBefore = normalizeDecimal(account.state.equity);
  const usedMarginBefore = normalizeDecimal(account.state.usedMargin);
  const freeMarginBefore = normalizeDecimal(account.state.freeMargin);

  account.state.balance = subtractDecimal(balanceBefore, plan.commission);
  account.state.equity = subtractDecimal(equityBefore, plan.commission);
  account.state.usedMargin = addDecimal(usedMarginBefore, plan.requiredMargin);
  account.state.freeMargin = subtractDecimal(subtractDecimal(freeMarginBefore, plan.requiredMargin), plan.commission);
}

function applyCloseAccountAndPositionMutation({ account, position, plan, deal, clientOrderId, ledgerModel, now }) {
  const ledgers = [];
  let runningBalance = normalizeDecimal(account.state.balance);

  if (compareDecimal(plan.realizedPnl, '0') !== 0) {
    const next = addDecimal(runningBalance, plan.realizedPnl);
    ledgers.push(new ledgerModel({
      accountId: account._id,
      type: 'REALIZED_PNL',
      amount: plan.realizedPnl,
      balanceBefore: runningBalance,
      balanceAfter: next,
      currency: account.currency,
      referenceType: 'DEAL',
      referenceId: deal.dealId,
      idempotencyKey: `${clientOrderId}:close:pnl`,
      reason: plan.fullClose ? 'Position closed' : 'Position partially closed',
    }));
    runningBalance = next;
  }

  if (compareDecimal(plan.commission, '0') > 0) {
    const commissionAmount = subtractDecimal('0', plan.commission);
    const next = addDecimal(runningBalance, commissionAmount);
    ledgers.push(new ledgerModel({
      accountId: account._id,
      type: 'COMMISSION',
      amount: commissionAmount,
      balanceBefore: runningBalance,
      balanceAfter: next,
      currency: account.currency,
      referenceType: 'DEAL',
      referenceId: deal.dealId,
      idempotencyKey: `${clientOrderId}:close:commission`,
      reason: 'Execution commission',
    }));
    runningBalance = next;
  }

  account.state.balance = runningBalance;
  account.state.equity = addDecimal(account.state.equity, plan.netBalanceChange);
  account.state.realizedPnlToday = addDecimal(account.state.realizedPnlToday, plan.realizedPnl);
  let usedMargin = subtractDecimal(account.state.usedMargin, plan.releasedMargin);
  if (compareDecimal(usedMargin, '0') < 0) usedMargin = '0';
  account.state.usedMargin = usedMargin;
  account.state.freeMargin = addDecimal(addDecimal(account.state.freeMargin, plan.releasedMargin), plan.netBalanceChange);

  position.openVolume = plan.remainingVolume;
  position.margin = subtractDecimal(position.margin, plan.releasedMargin);
  if (compareDecimal(position.margin, '0') < 0) position.margin = '0';
  position.realizedPnl = addDecimal(position.realizedPnl, plan.realizedPnl);
  position.commissionPaid = addDecimal(position.commissionPaid, plan.commission);

  if (plan.fullClose) {
    position.status = 'CLOSED';
    position.openVolume = '0';
    position.margin = '0';
    position.closedAt = now;
    position.closeReason = 'MANUAL';
  }

  return ledgers;
}

function buildCommissionLedger({ account, amount, balanceAfter, referenceId, idempotencyKey }) {
  const negative = subtractDecimal('0', amount);
  return {
    accountId: account._id,
    type: 'COMMISSION',
    amount: negative,
    balanceBefore: addDecimal(balanceAfter, amount),
    balanceAfter,
    currency: account.currency,
    referenceType: 'DEAL',
    referenceId,
    idempotencyKey,
    reason: 'Execution commission',
  };
}

function openEvents(response) {
  return [
    ['trading.order.accepted', response.order],
    ['trading.order.filled', response.order],
    ['trading.deal.created', response.deal],
    ['trading.position.opened', response.position],
    ['trading.account.updated', response.account],
  ];
}

function closeEvents(response, fullClose) {
  return [
    ['trading.order.accepted', response.order],
    ['trading.order.filled', response.order],
    ['trading.deal.created', response.deal],
    [fullClose ? 'trading.position.closed' : 'trading.position.updated', response.position],
    ['trading.account.updated', response.account],
  ];
}

function normalizeOpenCommand(command) {
  return {
    accountId: String(command?.accountId || '').trim(),
    clientOrderId: String(command?.clientOrderId || '').trim(),
    symbol: normalizeSymbol(command?.symbol),
    side: String(command?.side || '').toUpperCase(),
    volume: String(command?.volume ?? '').trim(),
    stopLoss: nullableString(command?.stopLoss),
    takeProfit: nullableString(command?.takeProfit),
    requestedPrice: nullableString(command?.requestedPrice),
    source: normalizeSource(command?.source),
  };
}

function normalizeCloseCommand(command) {
  return {
    accountId: String(command?.accountId || '').trim(),
    clientOrderId: String(command?.clientOrderId || '').trim(),
    positionId: String(command?.positionId || '').trim(),
    volume: nullableString(command?.volume),
    requestedPrice: nullableString(command?.requestedPrice),
    source: normalizeSource(command?.source),
  };
}

function nullableString(value) {
  return value === null || value === undefined || value === '' ? null : String(value).trim();
}

function normalizeSource(source) {
  const value = String(source || 'API').toUpperCase();
  return ['WEB', 'MOBILE', 'API', 'SYSTEM'].includes(value) ? value : 'API';
}

async function runMongoTransaction(work) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      result = await work(session);
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    return result;
  } finally {
    await session.endSession();
  }
}

function translateTransactionError(error) {
  if (error instanceof AppError) return error;
  if (error?.code === 20 || /Transaction numbers are only allowed|replica set/i.test(error?.message || '')) {
    return new AppError('MongoDB transactions are unavailable; ACG Trader requires a replica-set/Atlas deployment for execution', {
      statusCode: 503,
      code: 'TRANSACTION_UNAVAILABLE',
    });
  }
  if (error?.code === 11000) {
    return new AppError('A trading record with the same idempotency identity already exists', {
      statusCode: 409,
      code: 'TRADING_DUPLICATE',
    });
  }
  return error;
}

module.exports = {
  MarketOrderService,
  runMongoTransaction,
  applyOpenAccountMutation,
  applyCloseAccountAndPositionMutation,
};
