'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const tradingPolicyShadowEventSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, index: true },
  type: {
    type: String,
    required: true,
    enum: ['NEWS_WOULD_BLOCK', 'WEEKEND_WOULD_BLOCK', 'WEEKEND_WOULD_CLOSE', 'WEEKEND_WOULD_CANCEL_PENDING'],
    index: true,
  },
  symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
  action: { type: String, required: true, trim: true },
  referenceId: { type: String, default: null },
  eventId: { type: String, default: null },
  eventTitle: { type: String, default: null },
  eventCurrency: { type: String, default: null },
  eventAt: { type: Date, default: null },
  windowFrom: { type: Date, default: null },
  windowUntil: { type: Date, default: null },
  weekendCloseAt: { type: Date, default: null },
  weekendAutoCloseAt: { type: Date, default: null },
  enforcementEnabled: { type: Boolean, default: false },
  dedupeKey: { type: String, required: true, unique: true, index: true },
  observedAt: { type: Date, required: true, default: Date.now, index: true },
}, { timestamps: true, versionKey: false });

tradingPolicyShadowEventSchema.index({ accountId: 1, observedAt: -1 });
tradingPolicyShadowEventSchema.index({ type: 1, observedAt: -1 });

const TradingPolicyShadowEvent = mongoose.models.TradingPolicyShadowEvent
  || mongoose.model('TradingPolicyShadowEvent', tradingPolicyShadowEventSchema);

module.exports = { TradingPolicyShadowEvent, tradingPolicyShadowEventSchema };
