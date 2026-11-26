'use strict';
const mongoose = require('mongoose');
const { READ_TOOLS } = require('./read-tool-policy');
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  tenantId: { type: String, required: true, immutable: true },
  actorId: { type: String, required: true, immutable: true },
  accountId: { type: String, required: true, immutable: true },
  sessionId: { type: String, required: true, immutable: true },
  connectionId: { type: String, required: true },
  channel: { type: String, enum: ['NATIVE'], required: true },
  status: { type: String, enum: ['ACTIVE','REVOKED'], required: true },
  toolIds: { type: [{ type: String, enum: READ_TOOLS }], required: true },
  notBeforeMs: { type: Number, required: true },
  expiresAtMs: { type: Number, required: true },
  revokedAt: { type: Date, default: null },
}, { timestamps: true, strict: 'throw', autoIndex: false, writeConcern: { w: 'majority' } });
const AiReadGrant = mongoose.models.AiReadGrant || mongoose.model('AiReadGrant', schema);
module.exports = { AiReadGrant };
