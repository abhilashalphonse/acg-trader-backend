'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;

const traderProfileSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true },
  principalKey: { type: String, required: true, immutable: true, trim: true, maxlength: 256 },
  ownerExternalRef: { type: String, default: null, trim: true, maxlength: 256 },
  displayName: { type: String, default: 'Trader', trim: true, maxlength: 64 },
  sharePhotoDataUrl: { type: String, default: null, maxlength: 420000 },
  shareTemplate: { type: String, enum: ['PERFORMANCE', 'PHOTO'], default: 'PERFORMANCE' },
}, {
  timestamps: true,
  optimisticConcurrency: true,
});

traderProfileSchema.index({ tenantId: 1, principalKey: 1 }, { unique: true });

const TraderProfile = mongoose.models.TraderProfile || mongoose.model('TraderProfile', traderProfileSchema);

module.exports = { TraderProfile, traderProfileSchema };
