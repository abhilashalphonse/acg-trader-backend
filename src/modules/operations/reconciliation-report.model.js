'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const { Schema } = mongoose;

const issueSchema = new Schema({
  code: { type: String, required: true, immutable: true, index: true },
  severity: { type: String, enum: ['WARNING', 'ERROR', 'CRITICAL'], required: true, immutable: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', default: null, immutable: true },
  message: { type: String, required: true, maxlength: 512, immutable: true },
  details: { type: Schema.Types.Mixed, default: {}, immutable: true },
}, { _id: false });

const recoverySchema = new Schema({
  databaseOpenPositions: { type: Number, default: null, immutable: true },
  recoveredOpenPositions: { type: Number, default: null, immutable: true },
  databasePendingOrders: { type: Number, default: null, immutable: true },
  recoveredPendingOrders: { type: Number, default: null, immutable: true },
  databaseProtectedPositions: { type: Number, default: null, immutable: true },
  recoveredProtectedPositions: { type: Number, default: null, immutable: true },
  databaseTrailingPositions: { type: Number, default: null, immutable: true },
  recoveredTrailingPositions: { type: Number, default: null, immutable: true },
  consistent: { type: Boolean, default: null, immutable: true },
}, { _id: false });

const reconciliationReportSchema = new Schema({
  reportId: { type: String, required: true, unique: true, default: () => crypto.randomUUID(), immutable: true, index: true },
  scope: { type: String, enum: ['STARTUP_RECOVERY', 'MANUAL', 'PERIODIC'], required: true, immutable: true, index: true },
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', default: null, immutable: true, index: true },
  requestedBy: { type: String, default: null, maxlength: 256, immutable: true },
  checkedAccounts: { type: Number, required: true, min: 0, immutable: true },
  issueCount: { type: Number, required: true, min: 0, immutable: true },
  status: { type: String, enum: ['PASSED', 'ISSUES', 'FAILED'], required: true, immutable: true, index: true },
  issues: { type: [issueSchema], default: [], immutable: true },
  recovery: { type: recoverySchema, default: null, immutable: true },
  startedAt: { type: Date, required: true, immutable: true },
  completedAt: { type: Date, required: true, immutable: true },
}, { timestamps: { createdAt: 'createdAt', updatedAt: false }, versionKey: false });

reconciliationReportSchema.index({ tenantId: 1, createdAt: -1 });
reconciliationReportSchema.index({ scope: 1, createdAt: -1 });
reconciliationReportSchema.pre('save', function preventMutation(next) {
  if (!this.isNew) return next(new Error('Reconciliation reports are immutable'));
  next();
});
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  reconciliationReportSchema.pre(operation, function preventMutationQuery(next) {
    next(new Error('Reconciliation reports are immutable'));
  });
}

const ReconciliationReport = mongoose.models.ReconciliationReport || mongoose.model('ReconciliationReport', reconciliationReportSchema);
module.exports = { ReconciliationReport, reconciliationReportSchema };
