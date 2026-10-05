'use strict';
const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/app-error');
const schema = new mongoose.Schema({
  _id: String, revision: { type: Number, default: 0 },
  newsDisabled: { type: Boolean, default: false }, weekendDisabled: { type: Boolean, default: false },
  reason: String, actor: String,
}, { timestamps: true, versionKey: false });
const auditSchema = new mongoose.Schema({ tenantId: { type: mongoose.Schema.Types.ObjectId, required: true },
  revision: Number, newsDisabled: Boolean, weekendDisabled: Boolean, reason: String, actor: String,
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });
auditSchema.index({ tenantId: 1, revision: 1 }, { unique: true });
auditSchema.pre('save', function(next) { next(this.isNew ? undefined : new Error('Policy control audit is immutable')); });
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace']) {
  auditSchema.pre(operation, function(next) { next(new Error('Policy control audit is immutable')); });
}
const PolicyControl = mongoose.models.PolicyControl || mongoose.model('PolicyControl', schema);
const PolicyControlAudit = mongoose.models.PolicyControlAudit || mongoose.model('PolicyControlAudit', auditSchema);

class PolicyControlService {
  constructor({ model = PolicyControl, auditModel = PolicyControlAudit,
    transaction = work => mongoose.connection.transaction(work, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' }) } = {}) {
    Object.assign(this, { model, auditModel, transaction });
  }
  async read(tenantId) {
    if (!tenantId) throw new AppError('Policy control requires a tenant', { statusCode: 503, code: 'POLICY_CONTROL_UNAVAILABLE' });
    try {
      // Intentionally read the primary on each decision, outside the caller's older transaction snapshot.
      // No process cache or restart is needed. Commands already authorized may finish.
      return await this.model.findById(String(tenantId)).read('primary').maxTimeMS(2000).lean()
        || { revision: 0, newsDisabled: false, weekendDisabled: false };
    } catch (error) {
      throw new AppError('Enforcement control is unavailable; retry this operation', { statusCode: 503, code: 'POLICY_CONTROL_UNAVAILABLE' });
    }
  }
  async update({ tenantId, expectedRevision, newsDisabled, weekendDisabled, actor, reason }) {
    try {
      return await this.transaction(async session => {
        const current = await this.model.findById(String(tenantId)).session(session).lean();
        if (Number(current?.revision || 0) !== expectedRevision) throw conflict();
        const next = { newsDisabled: newsDisabled ?? current?.newsDisabled ?? false,
          weekendDisabled: weekendDisabled ?? current?.weekendDisabled ?? false,
          revision: expectedRevision + 1, actor, reason };
        if (current) {
          const result = await this.model.updateOne({ _id: String(tenantId), revision: expectedRevision }, { $set: next }, { session });
          if (!result.matchedCount) throw conflict();
        } else await this.model.create([{ _id: String(tenantId), ...next }], { session });
        await this.auditModel.create([{ tenantId, ...next }], { session });
        return next;
      });
    } catch (error) { if (error.code === 11000) throw conflict(); throw error; }
  }
}
function conflict() { return new AppError('Enforcement control changed; refresh before updating', { statusCode: 409, code: 'POLICY_CONTROL_CONFLICT' }); }
module.exports = { PolicyControlService, PolicyControl, PolicyControlAudit };
