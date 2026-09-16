'use strict';

const mongoose = require('mongoose');
const { IDEMPOTENCY_STATES } = require('./trading.constants');

const { Schema } = mongoose;

const idempotencyRecordSchema = new Schema({
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  scope: { type: String, required: true, trim: true, maxlength: 64, immutable: true },
  key: { type: String, required: true, trim: true, maxlength: 128, immutable: true },
  requestHash: { type: String, required: true, minlength: 64, maxlength: 64, immutable: true },
  state: { type: String, enum: IDEMPOTENCY_STATES, default: 'IN_PROGRESS', index: true },

  resourceType: { type: String, default: null },
  resourceId: { type: String, default: null },
  response: { type: Schema.Types.Mixed, default: null },
  failureCode: { type: String, default: null },

  expiresAt: {
    type: Date,
    required: true,
    default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    index: true,
  },
}, {
  timestamps: true,
  optimisticConcurrency: true,
});

idempotencyRecordSchema.index({ accountId: 1, scope: 1, key: 1 }, { unique: true });
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const IdempotencyRecord = mongoose.models.IdempotencyRecord || mongoose.model('IdempotencyRecord', idempotencyRecordSchema);

module.exports = { IdempotencyRecord, idempotencyRecordSchema };
