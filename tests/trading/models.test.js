'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { Order } = require('../../src/modules/trading/order.model');
const { Deal } = require('../../src/modules/trading/deal.model');
const { Position } = require('../../src/modules/trading/position.model');
const { AccountLedger } = require('../../src/modules/trading/account-ledger.model');

const tenantId = new mongoose.Types.ObjectId();
const accountId = new mongoose.Types.ObjectId();
const orderObjectId = new mongoose.Types.ObjectId();

function baseOrder(overrides = {}) {
  return new Order({
    tenantId,
    accountId,
    clientOrderId: 'client-order-1',
    symbol: 'EURUSD',
    side: 'BUY',
    type: 'MARKET',
    requestedVolume: '0.37',
    ...overrides,
  });
}

function basePosition(overrides = {}) {
  return new Position({
    tenantId,
    accountId,
    sourceOrderId: orderObjectId,
    symbol: 'EURUSD',
    side: 'BUY',
    initialVolume: '1',
    openVolume: '1',
    entryPrice: '1.15',
    contractSize: '100000',
    volumeStep: '0.01',
    quoteCurrency: 'USD',
    margin: '1150',
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

test('order volume invariants reject impossible fill state', async () => {
  await assert.rejects(
    baseOrder({ clientOrderId: 'zero-volume', requestedVolume: '0' }).validate(),
    error => Boolean(error.errors?.requestedVolume),
  );
  await assert.rejects(
    baseOrder({ clientOrderId: 'overfill', requestedVolume: '1', filledVolume: '1.01' }).validate(),
    error => Boolean(error.errors?.filledVolume),
  );
  await assert.rejects(
    baseOrder({ clientOrderId: 'bad-filled', requestedVolume: '1', filledVolume: '0.5', status: 'FILLED', filledAt: new Date() }).validate(),
    error => Boolean(error.errors?.filledVolume),
  );
  await baseOrder({ clientOrderId: 'filled', requestedVolume: '1', filledVolume: '1', status: 'FILLED', filledAt: new Date() }).validate();
});

test('specified expiration requires an explicit expiry timestamp', async () => {
  await assert.rejects(
    baseOrder({ clientOrderId: 'expiry-1', timeInForce: 'SPECIFIED' }).validate(),
    error => Boolean(error.errors?.expiresAt),
  );
});

test('position lifecycle requires zero remaining volume, zero margin and closedAt when CLOSED', async () => {
  const position = basePosition({ status: 'CLOSED' });
  await assert.rejects(position.validate(), error => Boolean(error.errors?.closedAt) && Boolean(error.errors?.openVolume));

  position.closedAt = new Date();
  position.openVolume = '0';
  position.margin = '0';
  await position.validate();
});

test('position snapshots immutable execution specifications required for future close math', async () => {
  const position = basePosition();
  await position.validate();
  assert.equal(position.contractSize.toString(), '100000');
  assert.equal(position.volumeStep.toString(), '0.01');
  assert.equal(position.quoteCurrency, 'USD');
  assert.equal(position.margin.toString(), '1150');
});

test('deal requires positive executed volume and price', async () => {
  const deal = new Deal({
    tenantId,
    accountId,
    orderId: orderObjectId,
    symbol: 'EURUSD',
    side: 'BUY',
    type: 'OPEN',
    volume: '1',
    price: '1.15',
  });
  await deal.validate();

  const bad = new Deal({
    tenantId,
    accountId,
    orderId: orderObjectId,
    symbol: 'EURUSD',
    side: 'BUY',
    type: 'OPEN',
    volume: '0',
    price: '0',
  });
  await assert.rejects(bad.validate(), error => Boolean(error.errors?.volume) && Boolean(error.errors?.price));
});

test('ledger requires exact balance equation and preserves immutable accounting identifiers', async () => {
  const deal = new Deal({
    tenantId,
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
    tenantId,
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

  const invalid = new AccountLedger({
    tenantId,
    accountId,
    type: 'REALIZED_PNL',
    amount: '-200',
    balanceBefore: '100',
    balanceAfter: '-99',
    currency: 'USD',
    referenceType: 'DEAL',
    referenceId: deal.dealId,
  });
  await assert.rejects(invalid.validate(), error => Boolean(error.errors?.balanceAfter));

  const negativeButCorrect = new AccountLedger({
    tenantId,
    accountId,
    type: 'REALIZED_PNL',
    amount: '-200',
    balanceBefore: '100',
    balanceAfter: '-100',
    currency: 'USD',
    referenceType: 'DEAL',
    referenceId: deal.dealId,
  });
  await negativeButCorrect.validate();

  assert.ok(deal.dealId);
  assert.ok(ledger.entryId);
  assert.equal(AccountLedger.schema.path('amount').options.immutable, true);
  assert.equal(Deal.schema.path('price').options.immutable, true);
});
