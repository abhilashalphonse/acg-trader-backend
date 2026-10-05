'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;
const deadlineSchema = new Schema({
  _id: String, symbol: String, scheduleVersion: Number, scheduleHash: String,
  marketCloseAt: Date, processingStartAt: Date, requiredFlatAt: Date, reopenAt: Date,
}, { timestamps: true, versionKey: false });
const actionSchema = new Schema({
  _id: String, deadlineId: { type: String, index: true },
  tenantId: { type: Schema.Types.ObjectId, required: true, index: true },
  accountId: { type: Schema.Types.ObjectId, required: true, index: true },
  symbol: String, permissionVersion: Number, scheduleVersion: Number, scheduleHash: String,
  mode: { type: String, enum: ['SHADOW', 'ENFORCED'], required: true },
  state: { type: String, enum: ['PLANNED', 'LOCKED', 'CANCELLING', 'CLOSING', 'VERIFYING', 'CONFIRMED', 'RETRYING', 'MISSED', 'OBSOLETE'], default: 'PLANNED' },
  processingStartAt: Date, requiredFlatAt: Date, marketCloseAt: Date, reopenAt: Date,
  nextAttemptAt: Date, leaseOwner: String, leaseUntil: { type: Date, default: () => new Date(0) },
  generation: { type: Number, default: 0 }, operationRevision: { type: Number, default: 0 },
  attempt: { type: Number, default: 0 }, confirmedAt: Date, late: Boolean, lastError: String,
}, { timestamps: true, versionKey: false });
actionSchema.index({ mode: 1, state: 1, nextAttemptAt: 1, leaseUntil: 1 });
module.exports = {
  WeekendDeadline: mongoose.models.WeekendDeadline || mongoose.model('WeekendDeadline', deadlineSchema),
  WeekendAccountAction: mongoose.models.WeekendAccountAction || mongoose.model('WeekendAccountAction', actionSchema),
};
