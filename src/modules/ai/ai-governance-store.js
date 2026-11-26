'use strict';
const mongoose = require('mongoose');
const crypto = require('crypto');
const { AppError } = require('../../shared/errors/app-error');
const { AiGovernanceControl, AiAuditEvent } = require('./ai-governance.model');
const conflict = () => new AppError('AI governance revision changed', { statusCode: 409, code: 'AI_CONTROL_CONFLICT' });
const read = q => q.read('primary').readConcern('majority').maxTimeMS(2000).lean();
function createAiGovernanceStore() {
  return Object.freeze({
    async control(tenantId) {
      return await read(AiGovernanceControl.findById(tenantId)) || { enabled: false, revision: 0 };
    },
    async append(event) {
      await new AiAuditEvent(event).save({ w: 'majority', wtimeout: 2000 });
    },
    async list(tenantId, limit) {
      return read(AiAuditEvent.find({ tenantId }).sort({ occurredAt: -1, _id: -1 }).limit(limit));
    },
    async updateControl({ tenantId, actorId, expectedRevision, enabled, reason }) {
      try {
        return await mongoose.connection.transaction(async session => {
          const current = await AiGovernanceControl.findById(tenantId).session(session).lean();
          if ((current?.revision ?? 0) !== expectedRevision) throw conflict();
          const revision = expectedRevision + 1;
          if (current) {
            const result = await AiGovernanceControl.updateOne({ _id: tenantId, revision: expectedRevision },
              { $set: { enabled, revision } }, { session, runValidators: true });
            if (result.matchedCount !== 1) throw conflict();
          } else await AiGovernanceControl.create([{ _id: tenantId, enabled, revision }], { session });
          await AiAuditEvent.create([{
            _id: crypto.randomUUID() + ':control', tenantId, actorId, operation: 'CONTROL_CHANGE',
            stage: 'CONTROL_CHANGED', revision, enabled, reason, occurredAt: new Date(),
          }], { session });
          return { enabled, revision };
        }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
      } catch (error) { if (error?.code === 11000) throw conflict(); throw error; }
    },
  });
}
module.exports = { createAiGovernanceStore };
