'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { Schema } = mongoose;

const BREACH_CLEANUP_STATES = Object.freeze(['PENDING', 'PROCESSING', 'RETRY', 'COMPLETED']);

const accountBreachCleanupJobSchema = new Schema({
  jobId: { type: String, required: true, unique: true, immutable: true, default: () => crypto.randomUUID(), index: true },
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  jobKey: { type: String, required: true, immutable: true, trim: true, maxlength: 256 },
  sourceOrderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, immutable: true },
  sourceDealId: { type: Schema.Types.ObjectId, ref: 'Deal', required: true, immutable: true },
  riskSequence: { type: Number, required: true, immutable: true, min: 1 },
  reason: { type: String, required: true, immutable: true, maxlength: 256 },
  breachAction: { type: String, enum: ['LOCK_ONLY', 'CANCEL_ORDERS_AND_LOCK', 'LIQUIDATE_AND_LOCK'], required: true, immutable: true },
  evidence: { type: Schema.Types.Mixed, required: true, immutable: true },
  state: { type: String, enum: BREACH_CLEANUP_STATES, default: 'PENDING', index: true },
  attempts: { type: Number, default: 0, min: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  leaseExpiresAt: { type: Date, default: null, index: true },
  lastAttemptAt: { type: Date, default: null },
  completedAt: { type: Date, default: null },
  lastError: { type: String, default: null, maxlength: 2000 },
}, { timestamps: true, optimisticConcurrency: true });

accountBreachCleanupJobSchema.index({ accountId: 1, jobKey: 1 }, { unique: true });
accountBreachCleanupJobSchema.index({ state: 1, nextAttemptAt: 1, createdAt: 1 });

const AccountBreachCleanupJob = mongoose.models.AccountBreachCleanupJob
  || mongoose.model('AccountBreachCleanupJob', accountBreachCleanupJobSchema);

module.exports = {
  AccountBreachCleanupJob,
  accountBreachCleanupJobSchema,
  BREACH_CLEANUP_STATES,
};
