'use strict';

const mongoose = require('mongoose');
const { applyTenantScope } = require('./tenant-scope.plugin');
const { Schema } = mongoose;

const payoutReservationSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, required: true, immutable: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  payoutId: { type: String, required: true, immutable: true, trim: true, maxlength: 128 },
  // Only a RESERVED record has an activeKey. Uniqueness is enforced by Mongo,
  // independent of any single-process command queue.
  activeKey: { type: String, default: null },
  status: { type: String, enum: ['RESERVED', 'SETTLED', 'RELEASED'], required: true, default: 'RESERVED' },
  amountUsd: { type: Schema.Types.Decimal128, required: true, immutable: true },
  checkpointHash: { type: String, required: true, immutable: true },
  reservedFinancialRevision: { type: Number, required: true, immutable: true },
  reservedBalanceUsd: { type: Schema.Types.Decimal128, required: true, immutable: true },
  settledLedgerEntryId: { type: String, default: null },
  reservedAt: { type: Date, required: true, immutable: true },
  settledAt: { type: Date, default: null },
  releasedAt: { type: Date, default: null },
  releaseReason: { type: String, default: null },
}, { timestamps: true, optimisticConcurrency: true });

applyTenantScope(payoutReservationSchema);
payoutReservationSchema.index({ tenantId: 1, payoutId: 1 }, { unique: true });
payoutReservationSchema.index({ tenantId: 1, activeKey: 1 }, {
  unique: true,
  partialFilterExpression: { activeKey: { $type: 'string' } },
});

const PayoutReservation = mongoose.models.PayoutReservation
  || mongoose.model('PayoutReservation', payoutReservationSchema);

module.exports = { PayoutReservation, payoutReservationSchema };
