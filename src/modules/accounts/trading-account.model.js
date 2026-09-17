'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;
const Decimal128 = Schema.Types.Decimal128;

const limitRuleSchema = new Schema({
  limit: { type: Decimal128, required: true },
  reference: { type: String, required: true },
}, { _id: false });

const riskPolicySchema = new Schema({
  dailyLoss: { type: limitRuleSchema, required: true, default: () => ({ limit: '0', reference: 'DAILY_START_EQUITY' }) },
  maxLoss: { type: limitRuleSchema, required: true, default: () => ({ limit: '0', reference: 'INITIAL_BALANCE' }) },
  profitTarget: { type: Decimal128, required: true, default: '0' },
  breachAction: { type: String, enum: ['LOCK_ONLY', 'CANCEL_ORDERS_AND_LOCK', 'LIQUIDATE_AND_LOCK'], default: 'LIQUIDATE_AND_LOCK' },
  maxOpenPositions: { type: Number, default: null, min: 1 },
  maxTotalVolume: { type: Decimal128, default: null },
  allowedSymbols: [{ type: String, uppercase: true, trim: true }],
}, { _id: false });

const accountStateSchema = new Schema({
  initialBalance: { type: Decimal128, required: true },
  balance: { type: Decimal128, required: true },
  equity: { type: Decimal128, required: true },
  floatingPnl: { type: Decimal128, required: true, default: '0' },
  realizedPnlToday: { type: Decimal128, required: true, default: '0' },
  usedMargin: { type: Decimal128, required: true, default: '0' },
  freeMargin: { type: Decimal128, required: true },
  dailyStartEquity: { type: Decimal128, required: true },
}, { _id: false });

const tradingAccountSchema = new Schema({
  // Migration-safe: legacy rows may remain null until scripts/migrate-multitenancy.js runs.
  // New provisioning requires tenantId in AccountControlService.
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null, index: true },
  accountCode: { type: String, required: true, uppercase: true, trim: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
  ownerExternalRef: { type: String, default: null, index: true },
  externalRef: { type: String, default: null },

  accountType: { type: String, enum: ['DEMO', 'CHALLENGE', 'FUNDED'], default: 'DEMO', index: true },
  positionMode: { type: String, enum: ['HEDGING'], default: 'HEDGING' },
  currency: { type: String, uppercase: true, trim: true, default: 'USD' },
  leverage: { type: Number, required: true, min: 1, default: 100 },
  status: { type: String, enum: ['ACTIVE', 'PAUSED', 'BREACHED', 'DISABLED', 'CLOSED'], default: 'ACTIVE', index: true },

  state: { type: accountStateSchema, required: true },
  riskPolicy: { type: riskPolicySchema, required: true, default: () => ({}) },
  riskDayKey: { type: String, required: true, index: true },
  riskTimezone: { type: String, default: 'UTC' },
  tradingEnabled: { type: Boolean, default: true, index: true },
  breachedAt: { type: Date, default: null },
  closedAt: { type: Date, default: null },
  metadata: { type: Map, of: String, default: {} },
}, {
  timestamps: true,
  optimisticConcurrency: true,
});

tradingAccountSchema.pre('validate', function requireOwner(next) {
  if (!this.userId && !this.ownerExternalRef) this.invalidate('ownerExternalRef', 'Either userId or ownerExternalRef is required');
  next();
});

tradingAccountSchema.index({ status: 1, tradingEnabled: 1 });
tradingAccountSchema.index({ tenantId: 1, ownerExternalRef: 1, status: 1 });
tradingAccountSchema.index({ tenantId: 1, accountCode: 1 }, { unique: true, partialFilterExpression: { tenantId: { $type: 'objectId' } } });
tradingAccountSchema.index({ tenantId: 1, externalRef: 1 }, { unique: true, partialFilterExpression: { tenantId: { $type: 'objectId' }, externalRef: { $type: 'string' } } });

const TradingAccount = mongoose.models.TradingAccount || mongoose.model('TradingAccount', tradingAccountSchema);

module.exports = { TradingAccount, tradingAccountSchema };
