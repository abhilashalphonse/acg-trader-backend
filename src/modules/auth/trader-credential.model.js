'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;

const traderCredentialSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  login: { type: String, required: true, trim: true, maxlength: 64 },
  passwordSalt: { type: String, required: true },
  passwordHash: { type: String, required: true },
  status: { type: String, enum: ['ACTIVE', 'DISABLED'], default: 'ACTIVE', index: true },
  failedAttempts: { type: Number, default: 0, min: 0 },
  lockedUntil: { type: Date, default: null },
  passwordChangedAt: { type: Date, required: true, default: Date.now },
  mustChangePassword: { type: Boolean, default: true },
  lastLoginAt: { type: Date, default: null },
}, {
  timestamps: true,
  optimisticConcurrency: true,
});

traderCredentialSchema.index({ tenantId: 1, login: 1 }, { unique: true });
traderCredentialSchema.index({ tenantId: 1, accountId: 1 }, { unique: true });

const TraderCredential = mongoose.models.TraderCredential || mongoose.model('TraderCredential', traderCredentialSchema);

module.exports = { TraderCredential, traderCredentialSchema };
