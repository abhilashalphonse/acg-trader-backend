'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { compareDecimal } = require('../../shared/decimal/decimal');
const { ORDER_SIDES, DEAL_TYPES } = require('./trading.constants');
const { applyTenantScope } = require('./tenant-scope.plugin');
const { Schema } = mongoose;
const Decimal128 = Schema.Types.Decimal128;

const dealSchema = new Schema({
  dealId: { type: String, required: true, unique: true, default: () => crypto.randomUUID(), immutable: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, immutable: true, index: true },
  positionId: { type: Schema.Types.ObjectId, ref: 'Position', default: null, immutable: true, index: true },
  symbol: { type: String, required: true, uppercase: true, trim: true, immutable: true, index: true },
  side: { type: String, required: true, enum: ORDER_SIDES, immutable: true },
  type: { type: String, required: true, enum: DEAL_TYPES, immutable: true, index: true },
  volume: { type: Decimal128, required: true, immutable: true },
  price: { type: Decimal128, required: true, immutable: true },
  requestedPrice: { type: Decimal128, default: null, immutable: true },
  slippage: { type: Decimal128, default: '0', immutable: true },
  commission: { type: Decimal128, required: true, default: '0', immutable: true },
  swap: { type: Decimal128, required: true, default: '0', immutable: true },
  realizedPnl: { type: Decimal128, required: true, default: '0', immutable: true },
  quoteSequence: { type: Number, default: null, immutable: true },
  quoteReceivedAt: { type: Date, default: null, immutable: true },
  quoteSource: { type: String, default: null, immutable: true },
  referencePrice: { type: Decimal128, default: null, immutable: true },
  executionBid: { type: Decimal128, default: null, immutable: true },
  executionAsk: { type: Decimal128, default: null, immutable: true },
  spreadPoints: { type: Decimal128, default: null, immutable: true },
  providerSpreadPoints: { type: Decimal128, default: null, immutable: true },
  liquidityAdjustmentPoints: { type: Decimal128, default: '0', immutable: true },
  volumeBand: { type: String, default: null, immutable: true },
  pricingModel: { type: String, default: null, immutable: true },
  executedAt: { type: Date, required: true, default: Date.now, immutable: true, index: true },
  metadata: { type: Map, of: String, default: {}, immutable: true },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false }, versionKey: false });

applyTenantScope(dealSchema);
dealSchema.index({ tenantId: 1, accountId: 1, executedAt: -1 });
dealSchema.index({ tenantId: 1, accountId: 1, positionId: 1, executedAt: 1 });

dealSchema.pre('validate', function validateDeal(next) {
  try {
    if (this.volume != null && compareDecimal(this.volume, '0') <= 0) this.invalidate('volume', 'volume must be greater than zero');
    if (this.price != null && compareDecimal(this.price, '0') <= 0) this.invalidate('price', 'price must be greater than zero');
  } catch (error) { this.invalidate('volume', error.message); }
  next();
});
dealSchema.pre('save', function preventDealMutation(next) { if (!this.isNew) return next(new Error('Deal records are immutable')); next(); });
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) dealSchema.pre(operation, function preventDealMutationQuery(next) { next(new Error('Deal records are immutable')); });

const Deal = mongoose.models.Deal || mongoose.model('Deal', dealSchema);
module.exports = { Deal, dealSchema };
