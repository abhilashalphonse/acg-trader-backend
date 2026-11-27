'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;
const id = { type: String, required: true, match: /^[a-f0-9]{24}$/ };
const controlSchema = new Schema({
  _id: id, enabled: { type: Boolean, required: true },
  revision: { type: Number, required: true, min: 1, validate: Number.isSafeInteger },
}, { timestamps: true, versionKey: false, strict: 'throw', autoIndex: false });

const auditSchema = new Schema({
  _id: { type: String, required: true, maxlength: 64 },
  tenantId: id,
  actorId: { type: String, default: null, maxlength: 64 },
  sessionId: { type: String, default: null, match: /^[a-f0-9]{24}$/ },
  requestedAccountId: { type: String, default: null, match: /^[a-f0-9]{24}$/ },
  operation: { type: String, required: true, enum: ['DISCOVER','GRANT_GET','GRANT_CREATE','GRANT_REVOKE','TOOL_INVOKE','AI_GENERATE_OFFLINE','CHAT_DISCOVER_OFFLINE','CHAT_PREFLIGHT_OFFLINE','CHAT_CREATE_OFFLINE','CHAT_LIST_OFFLINE','CHAT_HISTORY_OFFLINE','CHAT_APPEND_OFFLINE','CHAT_CANCEL_OFFLINE','CHAT_DELETE_OFFLINE','CHAT_ANALYZE_OFFLINE','CONTROL_CHANGE'] },
  toolId: { type: String, default: null, maxlength: 80 },
  stage: { type: String, required: true, enum: ['ATTEMPT','ALLOWED','DENIED','FAILED','SUPPRESSED','CONTROL_CHANGED'] },
  reason: { type: String, default: null, maxlength: 64 },
  revision: { type: Number, default: null, min: 0, validate: v => v == null || Number.isSafeInteger(v) },
  enabled: { type: Boolean, default: null },
  occurredAt: { type: Date, required: true },
}, { versionKey: false, strict: 'throw', autoIndex: false });
auditSchema.index({ tenantId: 1, occurredAt: -1, _id: -1 });
function immutable(next) { next(new Error('AI audit events are append-only')); }
auditSchema.pre('save', function(next) { if (this.isNew) return next(); return immutable(next); });
for (const op of ['updateOne','updateMany','findOneAndUpdate','replaceOne','findOneAndReplace','deleteMany','findOneAndDelete']) auditSchema.pre(op, immutable);
auditSchema.pre('deleteOne', { document: true, query: true }, immutable);
const AiGovernanceControl = mongoose.models.AiGovernanceControl || mongoose.model('AiGovernanceControl', controlSchema);
const AiAuditEvent = mongoose.models.AiAuditEvent || mongoose.model('AiAuditEvent', auditSchema);
module.exports = { AiGovernanceControl, AiAuditEvent };
