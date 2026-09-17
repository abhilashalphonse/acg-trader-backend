'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const { Schema } = mongoose;

const platformEventOutboxSchema = new Schema({
  eventId: { type: String, required: true, unique: true, immutable: true, default: () => crypto.randomUUID(), index: true },
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  aggregateId: { type: String, required: true, immutable: true, index: true },
  eventType: { type: String, required: true, enum: ['ACCOUNT_SNAPSHOT', 'DEAL_CREATED', 'ACCOUNT_CONTROLLED'], immutable: true, index: true },
  occurredAt: { type: Date, required: true, immutable: true },
  payload: { type: Schema.Types.Mixed, required: true, immutable: true },
  metadata: { type: Schema.Types.Mixed, default: {}, immutable: true },
  status: { type: String, enum: ['PENDING', 'DELIVERED', 'DEAD'], default: 'PENDING', index: true },
  attempts: { type: Number, default: 0, min: 0 },
  nextAttemptAt: { type: Date, default: Date.now, index: true },
  lastAttemptAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  lastError: { type: String, default: null, maxlength: 2000 },
}, { timestamps: true, versionKey: false });

platformEventOutboxSchema.index({ status: 1, nextAttemptAt: 1, createdAt: 1 });
platformEventOutboxSchema.index({ tenantId: 1, accountId: 1, createdAt: -1 });
platformEventOutboxSchema.index({ aggregateId: 1, createdAt: -1 });

const PlatformEventOutbox = mongoose.models.PlatformEventOutbox || mongoose.model('PlatformEventOutbox', platformEventOutboxSchema);

module.exports = { PlatformEventOutbox, platformEventOutboxSchema };
