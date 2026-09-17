'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;

const serviceApiKeySchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true },
  clientId: { type: String, required: true, trim: true, maxlength: 128, unique: true, index: true },
  keyHash: { type: String, required: true },
  scopes: [{ type: String, trim: true }],
  status: { type: String, enum: ['ACTIVE', 'REVOKED'], default: 'ACTIVE', index: true },
  expiresAt: { type: Date, default: null },
  lastUsedAt: { type: Date, default: null },
  description: { type: String, default: null, maxlength: 256 },
}, {
  timestamps: true,
  optimisticConcurrency: true,
});

serviceApiKeySchema.index({ tenantId: 1, status: 1 });

const ServiceApiKey = mongoose.models.ServiceApiKey || mongoose.model('ServiceApiKey', serviceApiKeySchema);

module.exports = { ServiceApiKey, serviceApiKeySchema };
