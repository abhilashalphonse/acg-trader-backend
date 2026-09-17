'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const { Schema } = mongoose;

const challengeRiskDecisionSchema = new Schema({
  decisionId: { type: String, required: true, unique: true, immutable: true, default: () => crypto.randomUUID(), index: true },
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  challengeId: { type: String, default: null, immutable: true, index: true },
  type: { type: String, required: true, enum: ['BREACH', 'PASS', 'DAILY_RESET'], immutable: true, index: true },
  rule: { type: String, required: true, immutable: true },
  riskDayKey: { type: String, required: true, immutable: true, index: true },
  valuationSequence: { type: Number, default: null, immutable: true },
  valuedAtMs: { type: Number, default: null, immutable: true },
  balance: { type: String, default: null, immutable: true },
  equity: { type: String, default: null, immutable: true },
  threshold: { type: String, default: null, immutable: true },
  referenceValue: { type: String, default: null, immutable: true },
  observedValue: { type: String, default: null, immutable: true },
  evidence: { type: Schema.Types.Mixed, default: {}, immutable: true },
  createdAt: { type: Date, required: true, default: Date.now, immutable: true },
}, { versionKey: false });

challengeRiskDecisionSchema.index({ accountId: 1, type: 1, createdAt: -1 });
challengeRiskDecisionSchema.index({ accountId: 1, riskDayKey: 1, type: 1, rule: 1 });

challengeRiskDecisionSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'], function rejectMutation(next) {
  next(new Error('Challenge risk decisions are immutable'));
});

const ChallengeRiskDecision = mongoose.models.ChallengeRiskDecision || mongoose.model('ChallengeRiskDecision', challengeRiskDecisionSchema);
module.exports = { ChallengeRiskDecision, challengeRiskDecisionSchema };
