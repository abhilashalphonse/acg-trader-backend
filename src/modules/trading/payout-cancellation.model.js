'use strict';
const mongoose = require('mongoose');
const { applyTenantScope } = require('./tenant-scope.plugin');
const { Schema } = mongoose;

// A cancellation tombstone prevents a rejected payout from being reserved by
// a concurrent or delayed APPROVE request using the same payout ID.
const schema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, required: true, immutable: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true },
  payoutId: { type: String, required: true, immutable: true, trim: true, maxlength: 128 },
  reason: { type: String, required: true, immutable: true, maxlength: 256 },
  cancelledAt: { type: Date, required: true, immutable: true },
}, { timestamps: false, versionKey: false });
applyTenantScope(schema);
schema.index({ tenantId: 1, payoutId: 1 }, { unique: true });
schema.index({ tenantId: 1, accountId: 1, payoutId: 1 });

const PayoutCancellation = mongoose.models.PayoutCancellation
  || mongoose.model('PayoutCancellation', schema);
module.exports = { PayoutCancellation };
