'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');

const { Schema } = mongoose;

const accountLifecycleEventSchema = new Schema({
  eventId: { type: String, required: true, unique: true, immutable: true, default: () => crypto.randomUUID(), index: true },
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  type: {
    type: String,
    required: true,
    immutable: true,
    enum: ['PROVISIONED', 'PAUSED', 'RESUMED', 'DISABLED', 'BREACHED', 'CLOSING', 'CLOSED'],
    index: true,
  },
  fromStatus: { type: String, default: null, immutable: true },
  toStatus: { type: String, required: true, immutable: true },
  tradingEnabledBefore: { type: Boolean, default: null, immutable: true },
  tradingEnabledAfter: { type: Boolean, required: true, immutable: true },
  reason: { type: String, required: true, maxlength: 512, immutable: true },
  actorType: { type: String, enum: ['SYSTEM', 'SERVICE'], default: 'SERVICE', immutable: true },
  actorRef: { type: String, default: null, maxlength: 256, immutable: true },
  metadata: { type: Map, of: String, default: {}, immutable: true },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
  versionKey: false,
});

accountLifecycleEventSchema.index({ tenantId: 1, accountId: 1, createdAt: 1, _id: 1 });

accountLifecycleEventSchema.pre('save', function preventMutation(next) {
  if (!this.isNew) return next(new Error('Account lifecycle events are immutable'));
  next();
});

for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  accountLifecycleEventSchema.pre(operation, function preventMutationQuery(next) {
    next(new Error('Account lifecycle events are immutable'));
  });
}

const AccountLifecycleEvent = mongoose.models.AccountLifecycleEvent
  || mongoose.model('AccountLifecycleEvent', accountLifecycleEventSchema);

module.exports = { AccountLifecycleEvent, accountLifecycleEventSchema };
