'use strict';

const mongoose = require('mongoose');
const {
  timeAsync,
  addDuration,
  setDuration,
  setExecutionContext,
  nowMs: timingNowMs,
} = require('../../shared/observability/execution-timing');
const { AppError } = require('../../shared/errors/app-error');
const {
  normalizeDecimal,
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
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
const { planMarketOpen, planMarketClose, calculateAdverseSlippage } = require('./execution-planner');
const {
  calculatePositionStopRiskAmount,
  hasActiveExposurePolicy,
} = require('./firm-risk-policy');
const { serializeOrder, serializeDeal, serializePosition, serializeAccount } = require('./trading.serializer');

class MarketOrderService {
  constructor({
    quoteStore,
    eventBus,
    logger,
    valuationEngine = null,
    platformEventRelay = null,
    quoteRecovery = null,
    accountModel = TradingAccount,
    instrumentModel = Instrument,
    orderModel = Order,
    dealModel = Deal,
    positionModel = Position,
    ledgerModel = AccountLedger,
    commandQueue = new AccountCommandQueue(),
    idempotencyService = new IdempotencyService(),
    postFillRiskService = null,
    runTransaction = runMongoTransaction,
  }) {
    Object.assign(this, {
      quoteStore,
      eventBus,
      logger,
      valuationEngine,
      platformEventRelay,
      quoteRecovery,
      accountModel,
      instrumentModel,
      orderModel,
      dealModel,
      positionModel,
      ledgerModel,
      commandQueue,
      idempotencyService,
      postFillRiskService,
      runTransaction,
    });
  }

  async openMarketOrder(command, { timing = null, requestId = null, tenantId = null } = {}) {
    const normalized = normalizeOpenCommand(command);
    setExecutionContext(timing, {
      requestId,
      accountId: normalized.accountId,
      symbol: normalized.symbol,
      clientOrderId: normalized.clientOrderId,
    });

    const reservation = await timeAsync(
      timing,
      'idempotency_reserve',
      () => this.#reserve(normalized.accountId, 'MARKET_OPEN', normalized.clientOrderId, normalized, tenantId),
    );
    const replay = this.#resolveReservation(reservation, normalized.accountId);
    if (replay) return replay;

    try {
      const queuedAt = timingNowMs();
      const result = await this.commandQueue.run(normalized.accountId, async () => {
        addDuration(timing, 'queue_wait', timingNowMs() - queuedAt);
        const quoteSnapshot = await timeAsync(
          timing,
          'quote_recovery',
          () => this.#resolveExecutableQuote(normalized.symbol, 'market-open'),
        );
        setExecutionContext(timing, {
          quoteSource: quoteSnapshot?.source || null,
          quoteAgeMs: Number.isFinite(Number(quoteSnapshot?.receivedAtMs))
            ? Math.max(0, Date.now() - Number(quoteSnapshot.receivedAtMs))
            : null,
        });

        const nowMs = Date.now();
        const transactionResult = await this.runTransaction(async session => {
          const account = await timeAsync(
            timing,
            'account_read',
            () => this.accountModel.findById(normalized.accountId).session(session),
          );
          if (account && this.valuationEngine) this.valuationEngine.overlayAccountDocument(account, { requireLive: true });

          const instrument = await timeAsync(
            timing,
            'instrument_read',
            () => this.instrumentModel.findOne({ symbol: normalized.symbol }).session(session),
          );

          const exposure = hasExposureLimits(account)
            ? await timeAsync(
              timing,
              'exposure_read',
              () => loadOpenExposure(this.positionModel, normalized.accountId, session, {
                account,
                symbol: normalized.symbol,
                nowMs,
                instrumentModel: this.instrumentModel,
              }),
            )
            : null;

          const plan = planMarketOpen({
            account,
            instrument,
            quote: quoteSnapshot,
            exposure,
            side: normalized.side,
            volume: normalized.volume,
            stopLoss: normalized.stopLoss,
            takeProfit: normalized.takeProfit,
            nowMs,
          });

          return timeAsync(
            timing,
            'persist_total',
            () => this.#persistOpen({
              normalized,
              reservation,
              account,
              plan,
              quoteSnapshot,
              session,
              nowMs,
              timing,
            }),
          );
        }, timing);

        this.#emitEvents(transactionResult.events);
        return transactionResult;
      });
      return this.#decorateResponse(result.response, normalized.accountId, false);
    } catch (error) {
      await timeAsync(timing, 'failure_record', () => this.#recordFailure(reservation.record._id, error));
      throw translateTransactionError(error);
    }
  }

  async closeMarketPosition(command, { timing = null, requestId = null, tenantId = null } = {}) {
    const normalized = normalizeCloseCommand(command);
    const scope = normalized.reason ? 'PROTECTIVE_CLOSE' : 'MARKET_CLOSE';
    setExecutionContext(timing, {
      requestId,
      accountId: normalized.accountId,
      positionId: normalized.positionId,
      clientOrderId: normalized.clientOrderId,
    });

    const reservation = await timeAsync(
      timing,
      'idempotency_reserve',
      () => this.#reserve(normalized.accountId, scope, normalized.clientOrderId, normalized, tenantId),
    );
    const replay = this.#resolveReservation(reservation, normalized.accountId);
    if (replay) return replay;

    try {
      const queuedAt = timingNowMs();
      const result = await this.commandQueue.run(normalized.accountId, async () => {
        addDuration(timing, 'queue_wait', timingNowMs() - queuedAt);

        let quoteSnapshot = null;
        const previewPosition = await timeAsync(timing, 'preview_position_read', async () => {
          const query = this.positionModel.findById(normalized.positionId);
          return typeof query?.lean === 'function' ? query.lean() : query;
        });

        if (previewPosition?.symbol) {
          setExecutionContext(timing, { symbol: previewPosition.symbol });
          quoteSnapshot = await timeAsync(
            timing,
            'quote_recovery',
            () => this.#resolveExecutableQuote(
              previewPosition.symbol,
              normalized.reason ? 'protective-close' : 'market-close',
            ),
          );
        }

        setExecutionContext(timing, {
          quoteSource: quoteSnapshot?.source || null,
          quoteAgeMs: Number.isFinite(Number(quoteSnapshot?.receivedAtMs))
            ? Math.max(0, Date.now() - Number(quoteSnapshot.receivedAtMs))
            : null,
        });

        const nowMs = Date.now();
        const transactionResult = await this.runTransaction(async session => {
          const account = await timeAsync(
            timing,
            'account_read',
            () => this.accountModel.findById(normalized.accountId).session(session),
          );
          if (!account) throw new AppError('Trading account was not found', { statusCode: 404, code: 'ACCOUNT_NOT_FOUND' });

          const valuationProjection = this.valuationEngine
            ? this.valuationEngine.overlayAccountDocument(account, { requireLive: false })
            : null;

          const position = await timeAsync(
            timing,
            'position_read',
            () => this.positionModel.findById(normalized.positionId).session(session),
          );
          if (!position) throw new AppError('Position was not found', { statusCode: 404, code: 'POSITION_NOT_FOUND' });

          const instrument = await timeAsync(
            timing,
            'instrument_read',
            () => this.instrumentModel.findOne({ symbol: normalizeSymbol(position.symbol) }).session(session),
          );
          if (!quoteSnapshot) quoteSnapshot = this.quoteStore.get(position.symbol);

          const plan = planMarketClose({
            account,
            instrument,
            quote: quoteSnapshot,
            position,
            volume: normalized.volume,
            nowMs,
          });

          return timeAsync(
            timing,
            'persist_total',
            () => this.#persistClose({
              normalized,
              reservation,
              account,
              position,
              plan,
              quoteSnapshot,
              session,
              nowMs,
              valuationComplete: valuationProjection ? valuationProjection.complete : true,
              timing,
            }),
          );
        }, timing);

        this.#emitEvents(transactionResult.events);
        return transactionResult;
      });
      return this.#decorateResponse(result.response, normalized.accountId, false);
    } catch (error) {
      await timeAsync(timing, 'failure_record', () => this.#recordFailure(reservation.record._id, error));
      throw translateTransactionError(error);
    }
  }

  async #resolveExecutableQuote(symbol, reason) {
    try {
      if (this.quoteRecovery) await this.quoteRecovery(symbol, { reason });
    } catch (error) {
      this.logger?.warn?.({ err: error, symbol, reason }, 'On-demand quote recovery failed before execution');
    }
    return this.quoteStore.get(symbol);
  }

  async #persistOpen({ normalized, reservation, account, plan, quoteSnapshot, session, nowMs, timing = null }) {
    const now = new Date(nowMs);
    const slippage = calculateAdverseSlippage({ side: plan.side, fillPrice: plan.fillPrice, requestedPrice: normalized.requestedPrice });
    const order = new this.orderModel({
      tenantId: account.tenantId,
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
      tenantId: account.tenantId,
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
      tenantId: account.tenantId,
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
      referencePrice: plan.referencePrice,
      executionBid: plan.executionBid,
      executionAsk: plan.executionAsk,
      spreadPoints: plan.spreadPoints,
      providerSpreadPoints: plan.providerSpreadPoints,
      liquidityAdjustmentPoints: plan.liquidityAdjustmentPoints,
      volumeBand: plan.volumeBand,
      pricingModel: plan.pricingModel,
      executedAt: now,
    });

    const ledgers = [];
    applyOpenAccountMutation(account, plan);
    const postFillRisk = this.postFillRiskService
      ? await this.postFillRiskService.evaluateAndApply({ account, order, deal, session, now })
      : null;
    if (compareDecimal(plan.commission, '0') > 0) {
      ledgers.push(new this.ledgerModel(buildCommissionLedger({
        account,
        amount: plan.commission,
        balanceAfter: account.state.balance,
        referenceId: deal.dealId,
        idempotencyKey: `${normalized.clientOrderId}:open:commission`,
      })));
    }

    await timeAsync(timing, 'order_write', () => order.save({ session }));
    await timeAsync(timing, 'position_write', () => position.save({ session }));
    await timeAsync(timing, 'deal_write', () => deal.save({ session }));
    for (const ledger of ledgers) {
      await timeAsync(timing, 'ledger_write', () => ledger.save({ session }));
    }
    await timeAsync(timing, 'account_write', () => account.save({ session }));
    await timeAsync(
      timing,
      'outbox_write',
      () => this.platformEventRelay?.enqueueDeal({ account, deal, session }),
    );

    const response = executionResponse('OPEN', order, deal, position, account, plan, postFillRisk);
    await timeAsync(
      timing,
      'idempotency_complete',
      () => this.#completeReservation(reservation.record._id, order.orderId, response, session),
    );
    return { response, events: openEvents(response) };
  }

  async #persistClose({ normalized, reservation, account, position, plan, quoteSnapshot, session, nowMs, valuationComplete, timing = null }) {
    const now = new Date(nowMs);
    const slippage = calculateAdverseSlippage({ side: plan.closeSide, fillPrice: plan.fillPrice, requestedPrice: normalized.requestedPrice });
    const order = new this.orderModel({
      tenantId: account.tenantId,
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
      tenantId: account.tenantId,
      accountId: account._id,
      orderId: order._id,
      positionId: position._id,
      symbol: plan.symbol,
      side: plan.closeSide,
      type: normalized.reason || plan.dealType,
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
      referencePrice: plan.referencePrice,
      executionBid: plan.executionBid,
      executionAsk: plan.executionAsk,
      spreadPoints: plan.spreadPoints,
      providerSpreadPoints: plan.providerSpreadPoints,
      liquidityAdjustmentPoints: plan.liquidityAdjustmentPoints,
      volumeBand: plan.volumeBand,
      pricingModel: plan.pricingModel,
      executedAt: now,
    });

    const closeReason = normalized.reason || 'MANUAL';
    const ledgers = applyCloseAccountAndPositionMutation({
      account,
      position,
      plan,
      deal,
      clientOrderId: normalized.clientOrderId,
      ledgerModel: this.ledgerModel,
      now,
      valuationComplete,
      closeReason,
    });

    await timeAsync(timing, 'order_write', () => order.save({ session }));
    await timeAsync(timing, 'deal_write', () => deal.save({ session }));
    await timeAsync(timing, 'position_write', () => position.save({ session }));
    for (const ledger of ledgers) {
      await timeAsync(timing, 'ledger_write', () => ledger.save({ session }));
    }
    await timeAsync(timing, 'account_write', () => account.save({ session }));
    await timeAsync(
      timing,
      'outbox_write',
      () => this.platformEventRelay?.enqueueDeal({ account, deal, session }),
    );

    const operation = normalized.reason || (plan.fullClose ? 'CLOSE' : 'PARTIAL_CLOSE');
    const response = executionResponse(operation, order, deal, position, account);
    await timeAsync(
      timing,
      'idempotency_complete',
      () => this.#completeReservation(reservation.record._id, order.orderId, response, session),
    );
    return { response, events: closeEvents(response, plan.fullClose) };
  }

  async #reserve(accountId, scope, key, payload, tenantId = null) {
    return this.idempotencyService.reserve({ accountId, tenantId, scope, key, payload });
  }

  #resolveReservation(reservation, accountId) {
    if (reservation.created) return null;
    if (reservation.inProgress) {
      throw new AppError('An identical trading command is already in progress', { statusCode: 409, code: 'COMMAND_IN_PROGRESS' });
    }
    if (reservation.record.state === 'COMPLETED') {
      return this.#decorateResponse(reservation.record.response || {}, accountId, true);
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

  #decorateResponse(response, accountId, idempotentReplay) {
    return {
      ...response,
      valuation: this.valuationEngine?.getAccountSnapshot(accountId) || null,
      idempotentReplay,
    };
  }

  async #completeReservation(recordId, resourceId, response, session) {
    const completed = await this.idempotencyService.complete(
      recordId,
      { resourceType: 'ORDER', resourceId, response },
      { session },
    );
    if (!completed) throw new AppError('Idempotency record could not be completed', { statusCode: 409, code: 'IDEMPOTENCY_STATE_CONFLICT' });
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
  const projected = plan?.projectedAccountState;
  if (!projected) {
    throw new AppError('Projected account state is required for an opening fill', {
      statusCode: 500,
      code: 'PROJECTED_ACCOUNT_STATE_MISSING',
    });
  }
  account.financialRevision = Number(account.financialRevision || 0) + 1;
  account.state.balance = projected.balance;
  account.state.floatingPnl = projected.floatingPnl;
  account.state.equity = projected.equity;
  account.state.usedMargin = projected.usedMargin;
  account.state.freeMargin = projected.freeMargin;
  account.state.marginLevel = projected.marginLevel;
}

function applyCloseAccountAndPositionMutation({ account, position, plan, deal, clientOrderId, ledgerModel, now, valuationComplete = true, closeReason = 'MANUAL' }) {
  account.financialRevision = Number(account.financialRevision || 0) + 1;
  const ledgers = [];
  let runningBalance = normalizeDecimal(account.state.balance);

  if (compareDecimal(plan.realizedPnl, '0') !== 0) {
    const next = addDecimal(runningBalance, plan.realizedPnl);
    ledgers.push(new ledgerModel({
      tenantId: account.tenantId,
      accountId: account._id,
      type: 'REALIZED_PNL',
      amount: plan.realizedPnl,
      balanceBefore: runningBalance,
      balanceAfter: next,
      currency: account.currency,
      referenceType: 'DEAL',
      referenceId: deal.dealId,
      idempotencyKey: `${clientOrderId}:close:pnl`,
      reason: closeReason === 'MANUAL' ? (plan.fullClose ? 'Position closed' : 'Position partially closed') : closeReason,
    }));
    runningBalance = next;
  }

  if (compareDecimal(plan.commission, '0') > 0) {
    const commissionAmount = subtractDecimal('0', plan.commission);
    const next = addDecimal(runningBalance, commissionAmount);
    ledgers.push(new ledgerModel({
      tenantId: account.tenantId,
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
  if (valuationComplete) {
    account.state.floatingPnl = subtractDecimal(account.state.floatingPnl, plan.realizedPnl);
  }
  account.state.equity = subtractDecimal(account.state.equity, plan.commission);
  account.state.realizedPnlToday = addDecimal(account.state.realizedPnlToday, plan.realizedPnl);
  let usedMargin = subtractDecimal(account.state.usedMargin, plan.releasedMargin);
  if (compareDecimal(usedMargin, '0') < 0) usedMargin = '0';
  account.state.usedMargin = usedMargin;
  account.state.freeMargin = subtractDecimal(account.state.equity, usedMargin);
  account.state.marginLevel = marginLevel(account.state.equity, usedMargin);

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
    position.closeReason = closeReason;
  }
  return ledgers;
}

function buildCommissionLedger({ account, amount, balanceAfter, referenceId, idempotencyKey }) {
  return {
    tenantId: account.tenantId,
    accountId: account._id,
    type: 'COMMISSION',
    amount: subtractDecimal('0', amount),
    balanceBefore: addDecimal(balanceAfter, amount),
    balanceAfter,
    currency: account.currency,
    referenceType: 'DEAL',
    referenceId,
    idempotencyKey,
    reason: 'Execution commission',
  };
}

function serializeOpenExecution(plan, account, postFillRisk = null) {
  if (!plan) return null;
  return {
    fillPrice: plan.fillPrice,
    commission: plan.commission,
    immediateOpeningPnl: plan.immediateOpeningPnl,
    requiredMargin: plan.requiredMargin,
    resultingAccount: {
      balance: normalizeDecimal(account.state.balance),
      floatingPnl: normalizeDecimal(account.state.floatingPnl),
      equity: normalizeDecimal(account.state.equity),
      usedMargin: normalizeDecimal(account.state.usedMargin),
      freeMargin: normalizeDecimal(account.state.freeMargin),
      marginLevel: account.state.marginLevel == null ? null : normalizeDecimal(account.state.marginLevel),
      financialRevision: Number(account.financialRevision || 0),
    },
    breached: postFillRisk?.breached === true || String(account.status || '').toUpperCase() === 'BREACHED',
    breachEvidence: postFillRisk?.outcome?.evidence || null,
  };
}

function marginLevel(equity, usedMargin) {
  if (compareDecimal(usedMargin, '0') <= 0) return null;
  return multiplyDecimal(divideDecimal(equity, usedMargin, { scale: 8 }), '100');
}

function executionResponse(operation, order, deal, position, account, plan = null, postFillRisk = null) {
  return {
    operation,
    order: serializeOrder(order),
    deal: serializeDeal(deal),
    position: serializePosition(position),
    account: serializeAccount(account),
    ...(operation === 'OPEN' && plan ? { execution: serializeOpenExecution(plan, account, postFillRisk) } : {}),
  };
}

function openEvents(response) {
  const events = [
    ['trading.order.accepted', response.order],
    ['trading.order.filled', response.order],
    ['trading.deal.created', response.deal],
    ['trading.position.opened', response.position],
    ['trading.account.updated', response.account],
  ];
  if (String(response.account?.status || '').toUpperCase() === 'BREACHED') {
    events.push(['trading.account.breached', response.account]);
  }
  return events;
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
    reason: normalizeCloseReason(command?.reason),
  };
}

function nullableString(value) {
  return value === null || value === undefined || value === '' ? null : String(value).trim();
}

function normalizeSource(source) {
  const value = String(source || 'API').toUpperCase();
  return ['WEB', 'MOBILE', 'API', 'SYSTEM'].includes(value) ? value : 'API';
}

function normalizeCloseReason(reason) {
  if (reason === null || reason === undefined || reason === '') return null;
  const value = String(reason).toUpperCase();
  if (!['STOP_LOSS', 'TAKE_PROFIT'].includes(value)) {
    throw new AppError('Invalid system close reason', { statusCode: 400, code: 'INVALID_CLOSE_REASON' });
  }
  return value;
}

function hasExposureLimits(account) {
  return hasActiveExposurePolicy(account);
}

async function loadOpenExposure(positionModel, accountId, session = null, {
  account = null,
  symbol = null,
  currencyConverter = null,
  nowMs = Date.now(),
  excludePositionId = null,
  instrumentModel = null,
} = {}) {
  const filter = { accountId: String(accountId), status: 'OPEN' };
  if (excludePositionId) filter._id = mongoose.trusted({ $ne: String(excludePositionId) });
  let query = positionModel.find(filter)
    .select('symbol side openVolume entryPrice stopLoss contractSize quoteCurrency margin')
    .lean();
  if (session) query = query.session(session);
  const positions = await query;

  const instrumentsBySymbol = new Map();
  if (instrumentModel && positions.some(position => position.stopLoss !== null && position.stopLoss !== undefined && position.stopLoss !== '')) {
    const symbols = [...new Set(positions.map(position => normalizeSymbol(position.symbol)).filter(Boolean))];
    if (symbols.length) {
      let instrumentQuery = instrumentModel.find({
        symbol: mongoose.trusted({ $in: symbols }),
      })
        .select('symbol contractSize quoteCurrency pnlCurrency commissionPerLot commissionPerLotPerSide commissionRate')
        .lean();
      if (session) instrumentQuery = instrumentQuery.session(session);
      const instruments = await instrumentQuery;
      for (const instrument of instruments || []) {
        instrumentsBySymbol.set(normalizeSymbol(instrument.symbol), instrument);
      }
    }
  }

  const targetSymbol = normalizeSymbol(symbol);
  let currentTotalVolume = '0';
  let currentSymbolVolume = '0';
  let currentSymbolMargin = '0';
  let currentSymbolPositions = 0;
  let currentOpenRisk = '0';
  let unmeasuredRiskPositions = 0;
  // Standard ACG aggregate-risk monitoring is enabled even for older accounts
  // whose persisted policy predates the new default fields.
  const aggregateRiskEnabled = true;

  for (const position of positions) {
    const openVolume = position.openVolume?.toString?.() ?? String(position.openVolume || '0');
    currentTotalVolume = addDecimal(currentTotalVolume, openVolume);
    if (targetSymbol && normalizeSymbol(position.symbol) === targetSymbol) {
      currentSymbolVolume = addDecimal(currentSymbolVolume, openVolume);
      currentSymbolMargin = addDecimal(currentSymbolMargin, position.margin?.toString?.() ?? String(position.margin || '0'));
      currentSymbolPositions += 1;
    }
    if (aggregateRiskEnabled) {
      const risk = calculatePositionStopRiskAmount({
        account,
        position,
        instrument: instrumentsBySymbol.get(normalizeSymbol(position.symbol)) || null,
        currencyConverter,
        nowMs,
      });
      if (risk == null) unmeasuredRiskPositions += 1;
      else currentOpenRisk = addDecimal(currentOpenRisk, risk);
    }
  }

  return {
    currentOpenPositions: positions.length,
    currentTotalVolume,
    currentSymbolVolume,
    currentSymbolMargin,
    currentSymbolPositions,
    currentOpenRisk,
    unmeasuredRiskPositions,
  };
}

async function runMongoTransaction(work, timing = null, { startSession = () => mongoose.startSession() } = {}) {
  const session = await timeAsync(timing, 'mongo_session_start', () => startSession());
  let result;
  let transactionWorkMs = 0;
  let transactionAttempts = 0;
  const transactionStartedAt = timingNowMs();

  try {
    await session.withTransaction(async () => {
      transactionAttempts += 1;
      const workStartedAt = timingNowMs();
      try {
        result = await work(session);
      } finally {
        transactionWorkMs += timingNowMs() - workStartedAt;
      }
    }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    return result;
  } finally {
    const transactionTotalMs = timingNowMs() - transactionStartedAt;
    setDuration(timing, 'transaction_work', transactionWorkMs);
    setDuration(timing, 'transaction_total', transactionTotalMs);
    setDuration(timing, 'transaction_commit_overhead', Math.max(0, transactionTotalMs - transactionWorkMs));
    setExecutionContext(timing, { transactionAttempts });
    await timeAsync(timing, 'mongo_session_end', () => session.endSession());
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
  normalizeCloseReason,
  loadOpenExposure,
  hasExposureLimits,
  serializeOpenExecution,
  marginLevel,
};
