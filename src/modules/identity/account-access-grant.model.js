'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// These grants are for new global identities; legacy session grants remain unchanged until migration.
const accountAccessGrantSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  permissions: [{ type: String, enum: ['VIEW', 'TRADE', 'MANAGE'], required: true }],
  status: { type: String, enum: ['ACTIVE', 'REVOKED'], default: 'ACTIVE', required: true },
  expiresAt: { type: Date, default: null },
  revokedAt: { type: Date, default: null },
  source: { type: String, enum: ['PERSONAL', 'PARTNER'], required: true },
  updatedByClientId: { type: String, default: null, maxlength: 128 },
}, { timestamps: true, optimisticConcurrency: true });

accountAccessGrantSchema.index({ tenantId: 1, accountId: 1, userId: 1 }, { unique: true });
accountAccessGrantSchema.index({ userId: 1, tenantId: 1, status: 1 });

const AccountAccessGrant = mongoose.models.AccountAccessGrant || mongoose.model('AccountAccessGrant', accountAccessGrantSchema);
module.exports = { AccountAccessGrant, accountAccessGrantSchema };
