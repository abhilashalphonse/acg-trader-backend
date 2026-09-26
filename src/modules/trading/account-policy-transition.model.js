'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { Schema } = mongoose;

const POLICY_TRANSITION_STATES = Object.freeze(['COMPLETED']);

const accountPolicyTransitionSchema = new Schema({
  transitionId: { type: String, required: true, unique: true, immutable: true, default: () => crypto.randomUUID(), index: true },
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  migrationId: { type: String, required: true, immutable: true, trim: true, maxlength: 256 },
  fromVersion: { type: String, required: true, immutable: true, trim: true, maxlength: 64 },
  toVersion: { type: String, required: true, immutable: true, trim: true, maxlength: 64 },
  effectiveRiskSequence: { type: Number, required: true, immutable: true, min: 1 },
  effectiveFinancialRevision: { type: Number, required: true, immutable: true, min: 0 },
  originalProvisioningContractHash: { type: String, default: null, immutable: true },
  previousPolicy: { type: Schema.Types.Mixed, required: true, immutable: true },
  newPolicy: { type: Schema.Types.Mixed, required: true, immutable: true },
  preservedStateHashBefore: { type: String, required: true, immutable: true },
  preservedStateHashAfter: { type: String, required: true, immutable: true },
  status: { type: String, enum: POLICY_TRANSITION_STATES, default: 'COMPLETED', immutable: true, index: true },
  verifiedAt: { type: Date, required: true, immutable: true },
}, { timestamps: true, optimisticConcurrency: true });

accountPolicyTransitionSchema.index({ accountId: 1, migrationId: 1 }, { unique: true });
accountPolicyTransitionSchema.index({ accountId: 1, createdAt: -1 });

const AccountPolicyTransition = mongoose.models.AccountPolicyTransition
  || mongoose.model('AccountPolicyTransition', accountPolicyTransitionSchema);

module.exports = {
  AccountPolicyTransition,
  accountPolicyTransitionSchema,
  POLICY_TRANSITION_STATES,
};
