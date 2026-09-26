'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;

const EVENT_TYPES = Object.freeze([
  'VALUATION',
  'RISK_DAY_ROLLOVER',
  'POLICY_TRANSITION',
]);

const PROCESSING_STATES = Object.freeze([
  'PENDING',
  'PROCESSED',
  'BREACH',
]);

const accountRiskEventSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, index: true },
  sequence: { type: Number, required: true, min: 1 },
  eventType: { type: String, enum: EVENT_TYPES, required: true, index: true },
  sourceEventId: { type: String, default: null },
  financialRevision: { type: Number, required: true, min: 0 },
  accountRevision: { type: Number, required: true, min: 0 },
  policyVersion: { type: String, default: null },
  riskDayKey: { type: String, required: true },
  riskTimezone: { type: String, required: true, default: 'UTC' },
  effectiveAt: { type: Date, required: true },
  context: { type: Schema.Types.Mixed, required: true },
  processingState: { type: String, enum: PROCESSING_STATES, default: 'PENDING', index: true },
  processedAt: { type: Date, default: null },
  processingResult: { type: Schema.Types.Mixed, default: null },
}, {
  timestamps: true,
  minimize: false,
});

accountRiskEventSchema.index({ accountId: 1, sequence: 1 }, { unique: true });
accountRiskEventSchema.index(
  { accountId: 1, sourceEventId: 1 },
  {
    unique: true,
    partialFilterExpression: { sourceEventId: { $type: 'string' } },
  },
);
accountRiskEventSchema.index({ processingState: 1, accountId: 1, sequence: 1 });

const AccountRiskEvent = mongoose.models.AccountRiskEvent
  || mongoose.model('AccountRiskEvent', accountRiskEventSchema);

module.exports = {
  AccountRiskEvent,
  accountRiskEventSchema,
  EVENT_TYPES,
  PROCESSING_STATES,
};
