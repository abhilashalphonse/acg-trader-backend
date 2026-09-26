'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { Schema } = mongoose;
const Decimal128 = Schema.Types.Decimal128;

const STOP_OUT_JOB_STATES = Object.freeze(['PENDING', 'PROCESSING', 'RETRY', 'COMPLETED', 'SUPERSEDED']);

const marginStopOutJobSchema = new Schema({
  jobId: { type: String, required: true, unique: true, immutable: true, default: () => crypto.randomUUID(), index: true },
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  activeKey: { type: String, default: undefined, trim: true },
  triggerFinancialRevision: { type: Number, required: true, immutable: true, min: 0 },
  triggerValuationSequence: { type: Number, default: null, immutable: true },
  triggerValuedAtMs: { type: Number, default: null, immutable: true },
  triggerMarginLevel: { type: Decimal128, required: true, immutable: true },
  triggerEquity: { type: Decimal128, required: true, immutable: true },
  triggerUsedMargin: { type: Decimal128, required: true, immutable: true },
  stopOutLevelPercent: { type: Decimal128, required: true, immutable: true, default: '50' },
  state: { type: String, enum: STOP_OUT_JOB_STATES, default: 'PENDING', index: true },
  step: { type: Number, default: 1, min: 1 },
  attempts: { type: Number, default: 0, min: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  leaseExpiresAt: { type: Date, default: null, index: true },
  lastAttemptAt: { type: Date, default: null },
  lastAction: { type: Schema.Types.Mixed, default: null },
  completionReason: { type: String, default: null },
  completedAt: { type: Date, default: null },
  lastError: { type: String, default: null, maxlength: 2000 },
}, { timestamps: true, optimisticConcurrency: true });

marginStopOutJobSchema.index(
  { activeKey: 1 },
  { unique: true, partialFilterExpression: { activeKey: { $type: 'string' } } },
);
marginStopOutJobSchema.index({ state: 1, nextAttemptAt: 1, createdAt: 1 });
marginStopOutJobSchema.index({ accountId: 1, createdAt: -1 });

const MarginStopOutJob = mongoose.models.MarginStopOutJob
  || mongoose.model('MarginStopOutJob', marginStopOutJobSchema);

module.exports = {
  MarginStopOutJob,
  marginStopOutJobSchema,
  STOP_OUT_JOB_STATES,
};
