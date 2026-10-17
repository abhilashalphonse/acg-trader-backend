'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;

const traderSessionSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  previousTokenHash: { type: String, default: null, index: true },
  previousAccessExpiresAt: { type: Date, default: null },
  refreshTokenHash: { type: String, unique: true, sparse: true, index: true },
  authMethod: { type: String, enum: ['PASSWORD', 'FEDERATED', 'SUPABASE'], required: true, immutable: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', default: null, immutable: true, index: true },
  loginIdentityId: { type: Schema.Types.ObjectId, ref: 'LoginIdentity', default: null, immutable: true },
  ownerExternalRef: { type: String, default: null, immutable: true, index: true },
  ownerExternalRefs: [{ type: String, immutable: true }],
  accountIds: [{ type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true }],
  selectedAccountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', default: null, immutable: true },
  credentialId: { type: Schema.Types.ObjectId, ref: 'TraderCredential', default: null, immutable: true },
  accessExpiresAt: { type: Date, default: null },
  idleExpiresAt: { type: Date, default: null },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null, index: true },
  lastSeenAt: { type: Date, default: Date.now },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, {
  timestamps: true,
  optimisticConcurrency: true,
});

traderSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
traderSessionSchema.index({ tenantId: 1, ownerExternalRef: 1, revokedAt: 1 });
traderSessionSchema.index({ userId: 1, tenantId: 1, revokedAt: 1 });

const TraderSession = mongoose.models.TraderSession || mongoose.model('TraderSession', traderSessionSchema);

module.exports = { TraderSession, traderSessionSchema };
