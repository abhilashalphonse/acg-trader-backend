'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;

const tenantSchema = new Schema({
  name: { type: String, required: true, trim: true, maxlength: 128 },
  slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 64, unique: true, index: true },
  status: { type: String, enum: ['ACTIVE', 'DISABLED'], default: 'ACTIVE', index: true },
  branding: { type: Schema.Types.Mixed, default: {} },
  allowedOrigins: [{ type: String, trim: true }],
  authModes: [{ type: String, enum: ['PASSWORD', 'FEDERATED'] }],
  features: { type: Schema.Types.Mixed, default: {} },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, {
  timestamps: true,
  optimisticConcurrency: true,
});

tenantSchema.pre('validate', function normalizeTenant(next) {
  if (this.slug) this.slug = String(this.slug).trim().toLowerCase();
  if (!Array.isArray(this.authModes) || this.authModes.length === 0) this.authModes = ['PASSWORD', 'FEDERATED'];
  next();
});

const Tenant = mongoose.models.Tenant || mongoose.model('Tenant', tenantSchema);

module.exports = { Tenant, tenantSchema };
