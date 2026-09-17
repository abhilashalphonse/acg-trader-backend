'use strict';

const { connectDatabase, disconnectDatabase } = require('../src/config/database');
const { Tenant } = require('../src/modules/tenancy/tenant.model');
const { TradingAccount } = require('../src/modules/accounts/trading-account.model');
const { Order } = require('../src/modules/trading/order.model');
const { Position } = require('../src/modules/trading/position.model');
const { Deal } = require('../src/modules/trading/deal.model');
const { AccountLedger } = require('../src/modules/trading/account-ledger.model');
const { IdempotencyRecord } = require('../src/modules/trading/idempotency.model');
const { TraderCredential } = require('../src/modules/auth/trader-credential.model');
const { ServiceApiKey } = require('../src/modules/auth/service-api-key.model');
const { TraderSession } = require('../src/modules/auth/trader-session.model');
const { FederationTicket } = require('../src/modules/auth/federation-ticket.model');

async function main() {
  await connectDatabase();
  const slug = requiredEnv('TENANT_SLUG').toLowerCase();
  const name = process.env.TENANT_NAME || slug;
  let tenant = await Tenant.findOne({ slug });
  if (!tenant) tenant = await Tenant.create({ name, slug, authModes: ['PASSWORD', 'FEDERATED'] });

  const accountResult = await TradingAccount.updateMany({ tenantId: null }, { $set: { tenantId: tenant._id } });
  const accounts = await TradingAccount.find({ tenantId: tenant._id }).select('_id').lean();
  const accountIds = accounts.map(account => account._id);

  const executionResults = {};
  for (const [name, model] of Object.entries({ orders: Order, positions: Position, deals: Deal, ledgers: AccountLedger, idempotency: IdempotencyRecord })) {
    const result = await model.collection.updateMany({ accountId: { $in: accountIds }, $or: [{ tenantId: { $exists: false } }, { tenantId: null }] }, { $set: { tenantId: tenant._id } });
    executionResults[name] = result.modifiedCount ?? 0;
  }

  await migrateIndexes(TradingAccount.collection, ['accountCode_1', 'externalRef_1'], [
    [{ tenantId: 1, accountCode: 1 }, { unique: true, partialFilterExpression: { tenantId: { $type: 'objectId' } }, name: 'tenantId_1_accountCode_1' }],
    [{ tenantId: 1, externalRef: 1 }, { unique: true, partialFilterExpression: { tenantId: { $type: 'objectId' }, externalRef: { $type: 'string' } }, name: 'tenantId_1_externalRef_1' }],
    [{ tenantId: 1, ownerExternalRef: 1, status: 1 }, { name: 'tenantId_1_ownerExternalRef_1_status_1' }],
  ]);
  await migrateIndexes(Order.collection, ['accountId_1_clientOrderId_1'], [[{ tenantId: 1, accountId: 1, clientOrderId: 1 }, { unique: true, name: 'tenantId_1_accountId_1_clientOrderId_1' }]]);
  await migrateIndexes(AccountLedger.collection, ['accountId_1_idempotencyKey_1'], [[{ tenantId: 1, accountId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } }, name: 'tenantId_1_accountId_1_idempotencyKey_1' }]]);
  await migrateIndexes(IdempotencyRecord.collection, ['accountId_1_scope_1_key_1'], [[{ tenantId: 1, accountId: 1, scope: 1, key: 1 }, { unique: true, name: 'tenantId_1_accountId_1_scope_1_key_1' }]]);

  await Promise.all([
    Tenant.createIndexes(), TradingAccount.createIndexes(), Order.createIndexes(), Position.createIndexes(), Deal.createIndexes(),
    AccountLedger.createIndexes(), IdempotencyRecord.createIndexes(), TraderCredential.createIndexes(), ServiceApiKey.createIndexes(),
    TraderSession.createIndexes(), FederationTicket.createIndexes(),
  ]);

  console.log(JSON.stringify({ tenantId: String(tenant._id), tenantSlug: tenant.slug, migratedAccounts: accountResult.modifiedCount ?? accountResult.nModified ?? 0, executionResults }, null, 2));
}

async function migrateIndexes(collection, legacyNames, newIndexes) {
  const indexes = await collection.indexes();
  for (const legacyName of legacyNames) if (indexes.some(index => index.name === legacyName)) await collection.dropIndex(legacyName);
  for (const [keys, options] of newIndexes) await collection.createIndex(keys, options);
}
function requiredEnv(name) { const value = String(process.env[name] || '').trim(); if (!value) throw new Error(`${name} is required`); return value; }

main().then(disconnectDatabase).catch(async error => { console.error(error); await disconnectDatabase().catch(() => {}); process.exit(1); });
