'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const RISK_EVENT_TYPES = Object.freeze(['VALUATION', 'RISK_DAY_ROLLOVER', 'POLICY_TRANSITION']);
const RISK_EVENT_STATES = Object.freeze(['RECEIVED', 'EVALUATED', 'BREACHED', 'IGNORED']);

const accountRiskEventSchema = new Schema({
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  sequence: { type: Number, required: true, immutable: true, min: 1 },
  eventKey: { type: String, required: true, immutable: true, trim: true, maxlength: 256 },
  type: { type: String, enum: RISK_EVENT_TYPES, required: true, immutable: true, index: true },
  financialRevision: { type: Number, required: true, immutable: true, min: 0 },
  policyVersion: { type: String, default: null, immutable: true },
  riskDayKey: { type: String, required: true, immutable: true },
  riskTimezone: { type: String, required: true, immutable: true, default: 'UTC' },
  valuedAtMs: { type: Number, default: null, immutable: true },
  sourceSequence: { type: Number, default: null, immutable: true },
  context: { type: Schema.Types.Mixed, required: true, immutable: true },
  state: { type: String, enum: RISK_EVENT_STATES, default: 'RECEIVED', index: true },
  result: { type: Schema.Types.Mixed, default: null },
  evaluatedAt: { type: Date, default: null },
}, { timestamps: true, optimisticConcurrency: true });

accountRiskEventSchema.index({ accountId: 1, sequence: 1 }, { unique: true });
accountRiskEventSchema.index({ accountId: 1, eventKey: 1 }, { unique: true });
accountRiskEventSchema.index({ accountId: 1, state: 1, sequence: 1 });

const AccountRiskEvent = mongoose.models.AccountRiskEvent || mongoose.model('AccountRiskEvent', accountRiskEventSchema);

module.exports = {
  AccountRiskEvent,
  accountRiskEventSchema,
  RISK_EVENT_TYPES,
  RISK_EVENT_STATES,
};
