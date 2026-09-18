'use strict';

const mongoose = require('mongoose');
const { Order } = require('./order.model');
const { Deal } = require('./deal.model');
const { Position } = require('./position.model');
const { serializeOrder, serializeDeal, serializePosition } = require('./trading.serializer');

class TradingHistoryService {
  constructor({ orderModel = Order, dealModel = Deal, positionModel = Position } = {}) {
    Object.assign(this, { orderModel, dealModel, positionModel });
  }

  async orders(accountId, query = {}) { return page(this.orderModel, accountId, query, serializeOrder, 'createdAt'); }
  async deals(accountId, query = {}) { return page(this.dealModel, accountId, query, serializeDeal, 'executedAt'); }
  async positions(accountId, query = {}) { return page(this.positionModel, accountId, query, serializePosition, query.status === 'OPEN' ? 'openedAt' : 'closedAt'); }
}

async function page(model, accountId, query, serializer, timeField) {
  const filter = { accountId };
  if (query.symbol) filter.symbol = String(query.symbol).toUpperCase();
  if (query.status) filter.status = String(query.status).toUpperCase();
  if (query.side) filter.side = String(query.side).toUpperCase();
  if (query.from || query.to) {
    const range = {};
    if (query.from) range.$gte = new Date(query.from);
    if (query.to) range.$lte = new Date(query.to);
    filter[timeField] = mongoose.trusted(range);
  }
  if (query.cursor) filter._id = mongoose.trusted({ $lt: query.cursor });
  const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
  const docs = await model.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const hasMore = docs.length > limit;
  const slice = hasMore ? docs.slice(0, limit) : docs;
  return {
    items: slice.map(serializer),
    page: {
      limit,
      hasMore,
      nextCursor: hasMore && slice.length ? String(slice[slice.length - 1]._id) : null,
    },
  };
}

module.exports = { TradingHistoryService };
