'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { Order } = require('../../src/modules/trading/order.model');
const { Deal } = require('../../src/modules/trading/deal.model');
const { Position } = require('../../src/modules/trading/position.model');
const { AccountLedger } = require('../../src/modules/trading/account-ledger.model');

const accountId = new mongoose.Types.ObjectId();
const orderObjectId = new mongoose.Types.ObjectId();

function baseOrder(overrides = {}) {
  return new Order({
    accountId,
    clientOrderId: 'client-order-1',
    symbol: 'EURUSD',
    side: 'BUY',
    type: 'MARKET',
    requestedVolume: '0.37',
    ...overrides,
  });
}

test('market order validates and pending order types require their trigger prices', async () => {
  await baseOrder().validate();

  await assert.rejects(
    baseOrder({ clientOrderId: 'limit-1', type: 'LIMIT' }).validate(),
    error => Boolean(error.errors?.limitPrice),
  );
  await assert.rejects(
    baseOrder({ clientOrderId: 'stop-1', type: 'STOP' }).validate(),
    error => Boolean(error.errors?.stopPrice),
  );
  await assert.rejects(
    baseOrder({ clientOrderId: 'stop-limit-1', type: 'STOP_LIMIT', stopPrice: '1.16' }).validate(),
    error => Boolean(error.errors?.limitPrice),
  );

  await baseOrder({
    clientOrderId: 'stop-limit-2',
    type: 'STOP_LIMIT',
    stopPrice: '1.16',
    limitPrice: '1.1595',
  }).validate();
});

test('specified expiration requires an explicit expiry timestamp', async () => {
  await assert.rejects(
    baseOrder({ clientOrderId: 'expiry-1', timeInForce: 'SPECIFIED' }).validate(),
    error => Boolean(error.errors?.expiresAt),
  );
});

test('position lifecycle requires closedAt when status is CLOSED', async () => {
  const position = new Position({
    accountId,
    sourceOrderId: orderObjectId,
    symbol: 'EURUSD',
    side: 'BUY',
    initialVolume: '1',
    openVolume: '1',
    entryPrice: '1.15',
    status: 'CLOSED',
  });

  await assert.rejects(position.validate(), error => Boolean(error.errors?.closedAt));
  position.closedAt = new Date();
  await position.validate();
});

test('deal and ledger schemas preserve immutable accounting identifiers', async () => {
  const deal = new Deal({
    accountId,
    orderId: orderObjectId,
    symbol: 'EURUSD',
    side: 'BUY',
    type: 'OPEN',
    volume: '1',
    price: '1.15',
  });
  await deal.validate();

  const ledger = new AccountLedger({
    accountId,
    type: 'REALIZED_PNL',
    amount: '25.50',
    balanceBefore: '10000',
    balanceAfter: '10025.50',
    currency: 'USD',
    referenceType: 'DEAL',
    referenceId: deal.dealId,
  });
  await ledger.validate();

  assert.ok(deal.dealId);
  assert.ok(ledger.entryId);
  assert.equal(AccountLedger.schema.path('amount').options.immutable, true);
  assert.equal(Deal.schema.path('price').options.immutable, true);
});
