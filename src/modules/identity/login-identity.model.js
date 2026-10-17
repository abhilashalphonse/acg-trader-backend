'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

// Never identify or merge people by email. The verified (issuer, subject) pair is authoritative.
const loginIdentitySchema = new Schema({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, immutable: true, index: true },
  provider: { type: String, enum: ['SUPABASE'], required: true, immutable: true },
  issuer: { type: String, required: true, immutable: true, maxlength: 255 },
  subject: { type: String, required: true, immutable: true, maxlength: 255 },
  status: { type: String, enum: ['ACTIVE', 'DISABLED'], default: 'ACTIVE', required: true },
  linkedAt: { type: Date, default: Date.now, immutable: true },
}, { timestamps: true, optimisticConcurrency: true });

loginIdentitySchema.index({ provider: 1, issuer: 1, subject: 1 }, { unique: true });
loginIdentitySchema.index({ userId: 1, status: 1 });

const LoginIdentity = mongoose.models.LoginIdentity || mongoose.model('LoginIdentity', loginIdentitySchema);
module.exports = { LoginIdentity, loginIdentitySchema };
