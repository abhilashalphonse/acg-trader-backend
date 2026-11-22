'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

const alertRuleSchema = new Schema({
  tenantId: { type: String, required: true, index: true },
  ownerId: { type: String, required: true, index: true },
  streamId: { type: String, required: true, index: true },
  symbol: { type: String, required: true },
  feedId: { type: String, required: true },
  status: { type: String, enum: ['STARTING','MONITORING','PAUSED','COMPLETED','EXPIRED','NEEDS_ATTENTION'], default: 'STARTING' },
  version: { type: Number, required: true, default: 1 },
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

const marketBatchSchema = new Schema({
  streamId: { type: String, required: true },
  generation: { type: Number, required: true },
  firstSequence: { type: Number, required: true },
  lastSequence: { type: Number, required: true },
  events: { type: [Schema.Types.Mixed], required: true },
  acceptedAt: { type: Date, default: Date.now },
}, { versionKey: false });
marketBatchSchema.index({ streamId: 1, generation: 1, firstSequence: 1 }, { unique: true });
marketBatchSchema.index({ acceptedAt: 1 });

const streamCoverageSchema = new Schema({
  _id: { type: String, required: true },
  generation: { type: Number, default: 0 },
  status: { type: String, enum: ['STARTING','MONITORING','INTERRUPTED','STOPPED'], default: 'STARTING' },
  lastEventAt: { type: Date, default: null },
  lastSequence: { type: Number, default: 0 },
  lastReason: { type: String, default: null },
}, { timestamps: true, versionKey: false });

const triggerSchema = new Schema({
  alertId: { type: Schema.Types.ObjectId, required: true },
  tenantId: { type: String, required: true },
  ownerId: { type: String, required: true },
  ruleVersion: { type: Number, required: true },
  eventId: { type: String, required: true },
  evidence: { type: Schema.Types.Mixed, required: true },
}, { timestamps: true, versionKey: false });
triggerSchema.index({ alertId: 1, ruleVersion: 1, eventId: 1 }, { unique: true });

const outboxSchema = new Schema({
  triggerId: { type: Schema.Types.ObjectId, required: true },
  channel: { type: String, default: 'shadow' },
  status: { type: String, enum: ['PENDING','CLAIMED','ACCEPTED','DELIVERED','FAILED'], default: 'PENDING' },
  attempt: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: null },
  destinationRef: { type: String, default: null },
}, { timestamps: true, versionKey: false });
outboxSchema.index({ triggerId: 1, channel: 1 }, { unique: true });

const leaseSchema = new Schema({
  _id: { type: String, required: true },
  ownerId: { type: String, required: true },
  token: { type: Number, required: true, default: 0 },
  expiresAt: { type: Date, required: true },
  lastFenceAt: { type: Date, default: null },
}, { versionKey: false });

const models = {
  AlertRule: mongoose.models.AlertStage2Rule || mongoose.model('AlertStage2Rule', alertRuleSchema),
  MarketBatch: mongoose.models.AlertStage2MarketBatch || mongoose.model('AlertStage2MarketBatch', marketBatchSchema),
  StreamCoverage: mongoose.models.AlertStage2Coverage || mongoose.model('AlertStage2Coverage', streamCoverageSchema),
  AlertTrigger: mongoose.models.AlertStage2Trigger || mongoose.model('AlertStage2Trigger', triggerSchema),
  AlertOutbox: mongoose.models.AlertStage2Outbox || mongoose.model('AlertStage2Outbox', outboxSchema),
  AlertLease: mongoose.models.AlertStage2Lease || mongoose.model('AlertStage2Lease', leaseSchema),
};
module.exports = models;
