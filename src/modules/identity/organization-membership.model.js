'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// Organization administrator privileges do NOT authorize viewing or trading customer accounts.
const organizationMembershipSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true },
  roles: [{ type: String, enum: ['MEMBER', 'ADMIN', 'OWNER'], required: true }],
  status: { type: String, enum: ['ACTIVE', 'REVOKED'], default: 'ACTIVE', required: true },
  revokedAt: { type: Date, default: null },
}, { timestamps: true, optimisticConcurrency: true });

organizationMembershipSchema.index({ tenantId: 1, userId: 1 }, { unique: true });
organizationMembershipSchema.index({ userId: 1, status: 1 });

const OrganizationMembership = mongoose.models.OrganizationMembership || mongoose.model('OrganizationMembership', organizationMembershipSchema);
module.exports = { OrganizationMembership, organizationMembershipSchema };
