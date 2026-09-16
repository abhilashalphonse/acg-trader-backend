'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { addDecimal, compareDecimal } = require('../../shared/decimal/decimal');
const { LEDGER_TYPES } = require('./trading.constants');

const { Schema } = mongoose;
const Decimal128 = Schema.Types.Decimal128;

const accountLedgerSchema = new Schema({
  entryId: { type: String, required: true, unique: true, default: () => crypto.randomUUID(), immutable: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  type: { type: String, required: true, enum: LEDGER_TYPES, immutable: true, index: true },
  amount: { type: Decimal128, required: true, immutable: true },
  balanceBefore: { type: Decimal128, required: true, immutable: true },
  balanceAfter: { type: Decimal128, required: true, immutable: true },
  currency: { type: String, required: true, uppercase: true, trim: true, immutable: true },
  referenceType: { type: String, enum: ['ORDER', 'DEAL', 'POSITION', 'SYSTEM'], required: true, immutable: true },
  referenceId: { type: String, required: true, trim: true, immutable: true },
  idempotencyKey: { type: String, default: null, trim: true, maxlength: 128, immutable: true },
  reason: { type: String, default: null, maxlength: 512, immutable: true },
  metadata: { type: Map, of: String, default: {}, immutable: true },
}, {
  timestamps: { createdAt: 'createdAt', updatedAt: false },
  versionKey: false,
});

accountLedgerSchema.index({ accountId: 1, createdAt: 1, _id: 1 });
accountLedgerSchema.index(
  { accountId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

accountLedgerSchema.pre('validate', function validateLedgerMath(next) {
  try {
    if (this.balanceBefore != null && compareDecimal(this.balanceBefore, '0') < 0) this.invalidate('balanceBefore', 'balanceBefore cannot be negative');
    if (this.balanceAfter != null && compareDecimal(this.balanceAfter, '0') < 0) this.invalidate('balanceAfter', 'balanceAfter cannot be negative');
    if (this.amount != null && this.balanceBefore != null && this.balanceAfter != null) {
      const expected = addDecimal(this.balanceBefore, this.amount);
      if (compareDecimal(expected, this.balanceAfter) !== 0) this.invalidate('balanceAfter', 'balanceAfter must equal balanceBefore + amount');
    }
  } catch (error) {
    this.invalidate('amount', error.message);
  }
  next();
});

accountLedgerSchema.pre('save', function preventLedgerMutation(next) {
  if (!this.isNew) return next(new Error('Account ledger records are immutable'));
  next();
});
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete']) {
  accountLedgerSchema.pre(operation, function preventLedgerMutationQuery(next) {
    next(new Error('Account ledger records are immutable'));
  });
}

const AccountLedger = mongoose.models.AccountLedger || mongoose.model('AccountLedger', accountLedgerSchema);
module.exports = { AccountLedger, accountLedgerSchema };
