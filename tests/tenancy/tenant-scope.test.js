'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { tradingAccountSchema } = require('../../src/modules/accounts/trading-account.model');
const { orderSchema } = require('../../src/modules/trading/order.model');
const { positionSchema } = require('../../src/modules/trading/position.model');
const { dealSchema } = require('../../src/modules/trading/deal.model');
const { accountLedgerSchema } = require('../../src/modules/trading/account-ledger.model');
const { idempotencyRecordSchema } = require('../../src/modules/trading/idempotency.model');

const schemas = [
  ['TradingAccount', tradingAccountSchema],
  ['Order', orderSchema],
  ['Position', positionSchema],
  ['Deal', dealSchema],
  ['AccountLedger', accountLedgerSchema],
  ['IdempotencyRecord', idempotencyRecordSchema],
];

test('all execution-domain records require immutable tenantId', () => {
  for (const [name, schema] of schemas) {
    const tenantPath = schema.path('tenantId');
    assert.ok(tenantPath, `${name} must define tenantId`);
    assert.equal(tenantPath.options.required, true, `${name}.tenantId must be required`);
    assert.equal(tenantPath.options.immutable, true, `${name}.tenantId must be immutable`);
  }
});

test('trading accounts require externalRef for tenant-scoped idempotent provisioning', () => {
  const externalRefPath = tradingAccountSchema.path('externalRef');
  assert.ok(externalRefPath);
  assert.equal(externalRefPath.options.required, true);
});

test('trading account unique indexes are tenant-scoped', () => {
  const indexes = tradingAccountSchema.indexes();
  const unique = indexes.filter(([, options]) => options.unique).map(([keys]) => keys);
  assert.ok(unique.some(keys => keys.tenantId === 1 && keys.accountCode === 1));
  assert.ok(unique.some(keys => keys.tenantId === 1 && keys.externalRef === 1));
  assert.equal(unique.some(keys => keys.accountCode === 1 && !keys.tenantId), false);
  assert.equal(unique.some(keys => keys.externalRef === 1 && !keys.tenantId), false);
});
