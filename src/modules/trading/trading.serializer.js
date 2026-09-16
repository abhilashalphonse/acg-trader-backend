'use strict';

function decimalString(value) {
  if (value === null || value === undefined) return null;
  return value?._bsontype === 'Decimal128' || value?.constructor?.name === 'Decimal128'
    ? value.toString()
    : String(value);
}

function iso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function serializeOrder(doc) {
  const order = plain(doc);
  return {
    id: String(order._id),
    orderId: order.orderId,
    accountId: String(order.accountId),
    clientOrderId: order.clientOrderId,
    targetPositionId: order.targetPositionId ? String(order.targetPositionId) : null,
    symbol: order.symbol,
    side: order.side,
    type: order.type,
    status: order.status,
    requestedVolume: decimalString(order.requestedVolume),
    filledVolume: decimalString(order.filledVolume),
    limitPrice: decimalString(order.limitPrice),
    stopPrice: decimalString(order.stopPrice),
    stopLoss: decimalString(order.stopLoss),
    takeProfit: decimalString(order.takeProfit),
    requestedPrice: decimalString(order.requestedPrice),
    acceptedPrice: decimalString(order.acceptedPrice),
    timeInForce: order.timeInForce,
    source: order.source,
    receivedAt: iso(order.receivedAt),
    acceptedAt: iso(order.acceptedAt),
    filledAt: iso(order.filledAt),
    createdAt: iso(order.createdAt),
  };
}

function serializeDeal(doc) {
  const deal = plain(doc);
  return {
    id: String(deal._id),
    dealId: deal.dealId,
    accountId: String(deal.accountId),
    orderId: String(deal.orderId),
    positionId: deal.positionId ? String(deal.positionId) : null,
    symbol: deal.symbol,
    side: deal.side,
    type: deal.type,
    volume: decimalString(deal.volume),
    price: decimalString(deal.price),
    requestedPrice: decimalString(deal.requestedPrice),
    slippage: decimalString(deal.slippage),
    commission: decimalString(deal.commission),
    swap: decimalString(deal.swap),
    realizedPnl: decimalString(deal.realizedPnl),
    quoteSequence: deal.quoteSequence ?? null,
    executedAt: iso(deal.executedAt),
  };
}

function serializePosition(doc) {
  const position = plain(doc);
  return {
    id: String(position._id),
    positionId: position.positionId,
    accountId: String(position.accountId),
    sourceOrderId: String(position.sourceOrderId),
    symbol: position.symbol,
    side: position.side,
    status: position.status,
    initialVolume: decimalString(position.initialVolume),
    openVolume: decimalString(position.openVolume),
    entryPrice: decimalString(position.entryPrice),
    stopLoss: decimalString(position.stopLoss),
    takeProfit: decimalString(position.takeProfit),
    contractSize: decimalString(position.contractSize),
    volumeStep: decimalString(position.volumeStep),
    quoteCurrency: position.quoteCurrency,
    margin: decimalString(position.margin),
    realizedPnl: decimalString(position.realizedPnl),
    commissionPaid: decimalString(position.commissionPaid),
    swapPaid: decimalString(position.swapPaid),
    trailing: position.trailing ? {
      enabled: Boolean(position.trailing.enabled),
      distancePoints: decimalString(position.trailing.distancePoints),
      bestPrice: decimalString(position.trailing.bestPrice),
      activatedAt: iso(position.trailing.activatedAt),
    } : null,
    openedAt: iso(position.openedAt),
    closedAt: iso(position.closedAt),
    closeReason: position.closeReason || null,
  };
}

function serializeAccount(doc) {
  const account = plain(doc);
  const state = account.state || {};
  return {
    id: String(account._id),
    accountCode: account.accountCode,
    accountType: account.accountType,
    currency: account.currency,
    leverage: account.leverage,
    status: account.status,
    tradingEnabled: Boolean(account.tradingEnabled),
    state: {
      initialBalance: decimalString(state.initialBalance),
      balance: decimalString(state.balance),
      equity: decimalString(state.equity),
      floatingPnl: decimalString(state.floatingPnl),
      realizedPnlToday: decimalString(state.realizedPnlToday),
      usedMargin: decimalString(state.usedMargin),
      freeMargin: decimalString(state.freeMargin),
      dailyStartEquity: decimalString(state.dailyStartEquity),
    },
  };
}

function plain(doc) {
  return typeof doc?.toObject === 'function' ? doc.toObject({ getters: false, virtuals: false }) : doc;
}

module.exports = {
  serializeOrder,
  serializeDeal,
  serializePosition,
  serializeAccount,
  decimalString,
};
