'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TradingHistoryService } = require('../../src/modules/trading/trading-history.service');

function modelWith(rows, capture) {
  return {
    find(filter) {
      capture.filter = filter;
      return {
        sort(sort) {
          capture.sort = sort;
          return {
            limit(limit) {
              capture.limit = limit;
              return { lean: async () => rows };
            },
          };
        },
      };
    },
  };
}

function order(id, overrides = {}) {
  return {
    _id: id,
    orderId: `order-${id}`,
    accountId: '64a000000000000000000001',
    clientOrderId: `client-${id}`,
    symbol: 'EURUSD',
    side: 'BUY',
    type: 'MARKET',
    status: 'FILLED',
    requestedVolume: '1',
    filledVolume: '1',
    timeInForce: 'GTC',
    source: 'WEB',
    createdAt: new Date('2026-09-17T10:00:00Z'),
    ...overrides,
  };
}

test('orders history returns keyset cursor and hasMore without leaking the lookahead row', async () => {
  const capture = {};
  const rows = [order('64b000000000000000000003'), order('64b000000000000000000002'), order('64b000000000000000000001')];
  const service = new TradingHistoryService({ orderModel: modelWith(rows, capture) });
  const result = await service.orders('64a000000000000000000001', { limit: 2, symbol: 'eurusd', side: 'BUY' });
  assert.equal(result.items.length, 2);
  assert.equal(result.page.hasMore, true);
  assert.equal(result.page.nextCursor, '64b000000000000000000002');
  assert.equal(capture.limit, 3);
  assert.equal(capture.filter.symbol, 'EURUSD');
  assert.equal(capture.filter.side, 'BUY');
  assert.deepEqual(capture.sort, { _id: -1 });
});

test('history applies cursor and date filters server-side', async () => {
  const capture = {};
  const service = new TradingHistoryService({ dealModel: modelWith([], capture) });
  await service.deals('64a000000000000000000001', {
    cursor: '64b000000000000000000002',
    from: '2026-09-01T00:00:00.000Z',
    to: '2026-09-17T23:59:59.000Z',
  });
  assert.deepEqual(capture.filter._id, { $lt: '64b000000000000000000002' });
  assert.equal(capture.filter.executedAt.$gte.toISOString(), '2026-09-01T00:00:00.000Z');
  assert.equal(capture.filter.executedAt.$lte.toISOString(), '2026-09-17T23:59:59.000Z');
});
