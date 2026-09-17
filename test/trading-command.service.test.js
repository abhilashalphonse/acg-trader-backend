'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TradingCommandService, childId } = require('../src/modules/trading/trading-command.service');

function queryOne(value) { return { lean: async () => value }; }
function queryMany(values) { return { sort: () => ({ lean: async () => values }) }; }

function createService({ position, positions, priorClose, closeImpl, openImpl } = {}) {
  const calls = { close: [], open: [] };
  const marketOrderService = {
    closeMarketPosition: async command => {
      calls.close.push(command);
      return closeImpl ? closeImpl(command) : { operation: 'CLOSE', position: { id: command.positionId, status: 'CLOSED' } };
    },
    openMarketOrder: async command => {
      calls.open.push(command);
      return openImpl ? openImpl(command) : { operation: 'OPEN', position: { id: 'new-position', symbol: command.symbol, side: command.side } };
    },
  };
  const positionModel = {
    findOne: () => queryOne(position),
    find: () => queryMany(positions || []),
  };
  const orderModel = { findOne: () => queryOne(priorClose) };
  return { service: new TradingCommandService({ marketOrderService, positionModel, orderModel }), calls };
}

const basePosition = {
  _id: '64b000000000000000000001',
  accountId: '64a000000000000000000001',
  symbol: 'EURUSD',
  side: 'BUY',
  status: 'OPEN',
  initialVolume: '1.00',
  openVolume: '1.00',
};

test('childId is deterministic and fits the order id limit', () => {
  const a = childId('x'.repeat(128), 'close-64b000000000000000000001');
  const b = childId('x'.repeat(128), 'close-64b000000000000000000001');
  assert.equal(a, b);
  assert.ok(a.length <= 128);
});

test('reverse closes the original position and opens the opposite side with the same volume', async () => {
  const { service, calls } = createService({ position: basePosition });
  const result = await service.reversePosition({
    accountId: basePosition.accountId,
    positionId: basePosition._id,
    clientRequestId: 'reverse-1',
    source: 'WEB',
  });
  assert.equal(result.complete, true);
  assert.equal(result.resumed, false);
  assert.equal(calls.close.length, 1);
  assert.equal(calls.open.length, 1);
  assert.equal(calls.open[0].side, 'SELL');
  assert.equal(calls.open[0].volume, '1.00');
  assert.equal(calls.open[0].symbol, 'EURUSD');
});

test('reverse retry resumes the open leg only after verifying its own prior close', async () => {
  const closed = { ...basePosition, status: 'CLOSED', openVolume: '0' };
  const { service, calls } = createService({ position: closed, priorClose: { status: 'FILLED' } });
  const result = await service.reversePosition({
    accountId: closed.accountId,
    positionId: closed._id,
    clientRequestId: 'reverse-retry',
  });
  assert.equal(result.complete, true);
  assert.equal(result.resumed, true);
  assert.equal(calls.close.length, 0);
  assert.equal(calls.open.length, 1);
  assert.equal(calls.open[0].volume, '1.00');
});

test('reverse refuses to reverse an already-closed position not closed by the same command', async () => {
  const closed = { ...basePosition, status: 'CLOSED', openVolume: '0' };
  const { service } = createService({ position: closed, priorClose: null });
  await assert.rejects(
    () => service.reversePosition({ accountId: closed.accountId, positionId: closed._id, clientRequestId: 'new-reverse' }),
    error => error.code === 'POSITION_ALREADY_CLOSED',
  );
});

test('close all reports partial failure without losing successful closes', async () => {
  const positions = [
    basePosition,
    { ...basePosition, _id: '64b000000000000000000002', symbol: 'XAUUSD' },
  ];
  const { service, calls } = createService({
    positions,
    closeImpl: command => {
      if (command.positionId.endsWith('2')) {
        const error = new Error('stale quote');
        error.code = 'STALE_QUOTE';
        throw error;
      }
      return { operation: 'CLOSE', position: { id: command.positionId, status: 'CLOSED' } };
    },
  });
  const result = await service.closeAllPositions({ accountId: basePosition.accountId, clientRequestId: 'close-all-1', source: 'WEB' });
  assert.equal(calls.close.length, 2);
  assert.equal(result.complete, false);
  assert.equal(result.requested, 2);
  assert.equal(result.closed, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.results[1].error.code, 'STALE_QUOTE');
});
