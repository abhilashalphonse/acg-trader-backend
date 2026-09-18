'use strict';

const { TradingAccount } = require('../modules/accounts/trading-account.model');
const { AccountLifecycleEvent } = require('../modules/accounts/account-lifecycle-event.model');
const { Instrument } = require('../modules/instruments/instrument.model');
const { Candle } = require('../modules/market-data/candle.model');
const { Tenant } = require('../modules/tenancy/tenant.model');
const { TraderCredential } = require('../modules/auth/trader-credential.model');
const { ServiceApiKey } = require('../modules/auth/service-api-key.model');
const { TraderSession } = require('../modules/auth/trader-session.model');
const { FederationTicket } = require('../modules/auth/federation-ticket.model');
const { Order } = require('../modules/trading/order.model');
const { Deal } = require('../modules/trading/deal.model');
const { Position } = require('../modules/trading/position.model');
const { AccountLedger } = require('../modules/trading/account-ledger.model');
const { IdempotencyRecord } = require('../modules/trading/idempotency.model');
const { PlatformEventOutbox } = require('../modules/integration/platform-event-outbox.model');
const { ReconciliationReport } = require('../modules/operations/reconciliation-report.model');

const CRITICAL_MODELS = Object.freeze([
  TradingAccount,
  AccountLifecycleEvent,
  Instrument,
  Candle,
  Tenant,
  TraderCredential,
  ServiceApiKey,
  TraderSession,
  FederationTicket,
  Order,
  Deal,
  Position,
  AccountLedger,
  IdempotencyRecord,
  PlatformEventOutbox,
  ReconciliationReport,
]);

async function ensureCriticalIndexes({ logger = null } = {}) {
  const results = [];
  for (const model of CRITICAL_MODELS) {
    await model.createIndexes();
    results.push(model.modelName);
  }
  logger?.info?.({ models: results }, 'Critical MongoDB indexes verified');
  return results;
}

module.exports = { ensureCriticalIndexes, CRITICAL_MODELS };
