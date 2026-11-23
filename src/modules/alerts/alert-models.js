'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

const alertRuleSchema = new Schema({
  name: { type: String, maxlength: 80, default: '' },
  note: { type: String, maxlength: 300, default: '' },
  deleted: { type: Boolean, default: false },
  pushEnabled: { type: Boolean, default: false },
  clientRequestId: { type: String },
  tenantId: { type: String, required: true, index: true },
  ownerId: { type: String, required: true, index: true },
  streamId: { type: String, required: true, index: true },
  symbol: { type: String, required: true },
  feedId: { type: String, required: true },
  status: { type: String, enum: ['STARTING','MONITORING','PAUSED','COMPLETED','EXPIRED','NEEDS_ATTENTION'], default: 'STARTING' },
  version: { type: Number, required: true, default: 1 },
  effectiveFrom: { type: Date, required: true, default: Date.now },
  condition: { type: Schema.Types.Mixed, required: true },
  priceSource: { type: String, enum: ['bid','ask','last'], required: true },
  tickSize: { type: String, required: true },
  timeframe: { type: String, default: null },
  frequency: { type: String, enum: ['once','repeat'], default: 'once' },
  cooldownMs: { type: Number, min: 0, default: 0 },
  schedule: { type: Schema.Types.Mixed, default: null },
  expiresAt: { type: Date, default: null },
  runtime: { type: Schema.Types.Mixed, default: null },
  checkpoint: { type: Schema.Types.Mixed, default: null },
}, { timestamps: true, versionKey: false });
alertRuleSchema.index({ streamId: 1, status: 1 });
alertRuleSchema.index({ status: 1, _id: 1 });
alertRuleSchema.index({ tenantId: 1, ownerId: 1, clientRequestId: 1 }, { unique: true, partialFilterExpression: { clientRequestId: { $type: 'string' } } });

const marketBatchSchema = new Schema({
  streamId: { type: String, required: true },
  generation: { type: Number, required: true },
  firstSequence: { type: Number, required: true },
  lastSequence: { type: Number, required: true },
  events: { type: [Schema.Types.Mixed], required: true },
  acceptedAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });
marketBatchSchema.index({ streamId: 1, generation: 1, firstSequence: 1 }, { unique: true });
marketBatchSchema.index({ acceptedAt: 1 });
marketBatchSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const streamCoverageSchema = new Schema({
  _id: { type: String, required: true },
  generation: { type: Number, default: 0 },
  status: { type: String, enum: ['STARTING','MONITORING','INTERRUPTED','STOPPED'], default: 'STARTING' },
  lastEventAt: { type: Date, default: null },
  lastSequence: { type: Number, default: 0 },
  lastReason: { type: String, default: null },
  // Exclusive durable capture ownership; token advances on every generation.
  captureOwnerId: { type: String, default: null },
  captureToken: { type: Number, default: 0 },
  captureLeaseUntil: { type: Date, default: null },
}, { timestamps: true, versionKey: false });

const triggerSchema = new Schema({
  alertId: { type: Schema.Types.ObjectId, required: true },
  tenantId: { type: String, required: true },
  ownerId: { type: String, required: true },
  ruleVersion: { type: Number, required: true },
  eventId: { type: String, required: true },
  evidence: { type: Schema.Types.Mixed, required: true },
  readAt: { type: Date, default: null },
}, { timestamps: true, versionKey: false });
triggerSchema.index({ alertId: 1, ruleVersion: 1, eventId: 1 }, { unique: true });

// Immutable, rule-scoped evidence of unrecoverable input intervals.
const replayGapSchema = new Schema({
  alertId: { type: Schema.Types.ObjectId, required: true },
  tenantId: { type: String, required: true },
  ownerId: { type: String, required: true },
  streamId: { type: String, required: true },
  ruleVersion: { type: Number, required: true },
  eventId: { type: String, required: true },
  reason: { type: String, required: true },
  fromCursor: { type: Schema.Types.Mixed, default: null },
  resumedAt: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true, versionKey: false });
replayGapSchema.index({ alertId: 1, ruleVersion: 1, eventId: 1 }, { unique: true });

const outboxSchema = new Schema({
  triggerId: { type: Schema.Types.ObjectId, required: true },
  channel: { type: String, default: 'shadow' },
  status: { type: String, enum: ['PENDING','CLAIMED','ACCEPTED','DELIVERED','FAILED'], default: 'PENDING' },
  attempt: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: null },
  destinationRef: { type: String, default: null },
  claimUntil: { type: Date, default: null },
  claimId: { type: String, default: null },
  lastError: { type: String, default: null },
}, { timestamps: true, versionKey: false });
outboxSchema.index({ triggerId: 1, channel: 1 }, { unique: true });

const leaseSchema = new Schema({
  _id: { type: String, required: true },
  ownerId: { type: String, required: true },
  token: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true },
  lastFenceAt: { type: Date, default: null },
}, { versionKey: false });

const subscriptionSchema = new Schema({
  tenantId: { type: String, required: true }, ownerId: { type: String, required: true },
  endpoint: { type: String, required: true },
  keys: { p256dh: String, auth: String },
}, { timestamps: true });
subscriptionSchema.index({ endpoint: 1 }, { unique: true });

// All selectors here are constructed internally from validated scalars. The
// application enables sanitizeFilter globally; these selectors intentionally
// contain operators (including the conditional writes that enforce fencing).
for (const schema of [alertRuleSchema, marketBatchSchema, streamCoverageSchema,
  triggerSchema, replayGapSchema, outboxSchema, leaseSchema, subscriptionSchema]) {
  schema.pre(/^(find|update|delete|count)/, function () { trustInternalOperators(this.getFilter()); });
}
function trustInternalOperators(value) {
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  if (Array.isArray(value)) { value.forEach(trustInternalOperators); return value; }
  for (const child of Object.values(value)) trustInternalOperators(child);
  if (Object.keys(value).some(key=>key.startsWith('$'))) mongoose.trusted(value);
  return value;
}
const models = {
  AlertSubscription: mongoose.models.AlertSubscription || mongoose.model('AlertSubscription', subscriptionSchema),
  AlertRule: mongoose.models.AlertStage2Rule || mongoose.model('AlertStage2Rule', alertRuleSchema),
  MarketBatch: mongoose.models.AlertStage2MarketBatch || mongoose.model('AlertStage2MarketBatch', marketBatchSchema),
  StreamCoverage: mongoose.models.AlertStage2Coverage || mongoose.model('AlertStage2Coverage', streamCoverageSchema),
  AlertTrigger: mongoose.models.AlertStage2Trigger || mongoose.model('AlertStage2Trigger', triggerSchema),
  AlertReplayGap: mongoose.models.AlertStage2ReplayGap || mongoose.model('AlertStage2ReplayGap', replayGapSchema),
  AlertOutbox: mongoose.models.AlertStage2Outbox || mongoose.model('AlertStage2Outbox', outboxSchema),
  AlertLease: mongoose.models.AlertStage2Lease || mongoose.model('AlertStage2Lease', leaseSchema),
};
module.exports = models;
