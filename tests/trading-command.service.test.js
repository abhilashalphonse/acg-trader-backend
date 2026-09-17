'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TradingCommandService, childId } = require('../src/modules/trading/trading-command.service');

function queryMany(values) { return { sort: () => ({ lean: async () => values }) }; }

function createService({ positions = [], closeImpl, reverseImpl } = {}) {
  const calls = { close: [], reverse: [] };
  const marketOrderService = {
    closeMarketPosition: async command => {
      calls.close.push(command);
      return closeImpl ? closeImpl(command) : { operation: 'CLOSE', position: { id: command.positionId, status: 'CLOSED' } };
    },
  };
  const atomicReverseService = {
    reversePosition: async command => {
      calls.reverse.push(command);
      return reverseImpl ? reverseImpl(command) : { operation: 'REVERSE', atomic: true, position: { id: 'replacement-position' } };
    },
  };
  const positionModel = { find: () => queryMany(positions) };
  return { service: new TradingCommandService({ marketOrderService, atomicReverseService, positionModel }), calls };
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

test('reverse delegates the complete command to the atomic reverse service exactly once', async () => {
  const { service, calls } = createService();
  const command = { accountId: basePosition.accountId, positionId: basePosition._id, clientRequestId: 'reverse-1', source: 'WEB' };
  const result = await service.reversePosition(command);
  assert.equal(result.atomic, true);
  assert.equal(calls.reverse.length, 1);
  assert.deepEqual(calls.reverse[0], command);
  assert.equal(calls.close.length, 0);
});

test('reverse propagates atomic service failure without falling back to client-style close/open composition', async () => {
  const expected = Object.assign(new Error('transaction failed'), { code: 'TRANSACTION_UNAVAILABLE' });
  const { service, calls } = createService({ reverseImpl: async () => { throw expected; } });
  await assert.rejects(
    () => service.reversePosition({ accountId: basePosition.accountId, positionId: basePosition._id, clientRequestId: 'reverse-fail' }),
    error => error === expected,
  );
  assert.equal(calls.reverse.length, 1);
  assert.equal(calls.close.length, 0);
});

test('close all reports partial failure without losing successful closes', async () => {
  const positions = [basePosition, { ...basePosition, _id: '64b000000000000000000002', symbol: 'XAUUSD' }];
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
