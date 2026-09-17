'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { compareDecimal } = require('../../shared/decimal/decimal');
const { ORDER_SIDES, ORDER_TYPES, ORDER_STATUSES, TIME_IN_FORCE, ORDER_SOURCES } = require('./trading.constants');
const { applyTenantScope } = require('./tenant-scope.plugin');
const { Schema } = mongoose;
const Decimal128 = Schema.Types.Decimal128;

const orderSchema = new Schema({
  orderId: { type: String, required: true, unique: true, default: () => crypto.randomUUID(), immutable: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  clientOrderId: { type: String, required: true, trim: true, maxlength: 128, immutable: true },
  targetPositionId: { type: Schema.Types.ObjectId, ref: 'Position', default: null, immutable: true, index: true },
  symbol: { type: String, required: true, uppercase: true, trim: true, immutable: true, index: true },
  side: { type: String, required: true, enum: ORDER_SIDES, immutable: true },
  type: { type: String, required: true, enum: ORDER_TYPES, immutable: true, index: true },
  status: { type: String, required: true, enum: ORDER_STATUSES, default: 'RECEIVED', index: true },
  requestedVolume: { type: Decimal128, required: true, immutable: true },
  filledVolume: { type: Decimal128, required: true, default: '0' },
  limitPrice: { type: Decimal128, default: null, immutable: true },
  stopPrice: { type: Decimal128, default: null, immutable: true },
  stopLoss: { type: Decimal128, default: null },
  takeProfit: { type: Decimal128, default: null },
  timeInForce: { type: String, enum: TIME_IN_FORCE, default: 'GTC', immutable: true },
  expiresAt: { type: Date, default: null, immutable: true },
  requestedPrice: { type: Decimal128, default: null, immutable: true },
  acceptedPrice: { type: Decimal128, default: null },
  rejectCode: { type: String, default: null },
  rejectMessage: { type: String, default: null },
  source: { type: String, enum: ORDER_SOURCES, default: 'WEB', immutable: true },
  receivedAt: { type: Date, required: true, default: Date.now, immutable: true },
  acceptedAt: { type: Date, default: null },
  triggeredAt: { type: Date, default: null },
  filledAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  expiredAt: { type: Date, default: null },
  rejectedAt: { type: Date, default: null },
  metadata: { type: Map, of: String, default: {} },
}, { timestamps: true, optimisticConcurrency: true });

applyTenantScope(orderSchema);
orderSchema.index({ tenantId: 1, accountId: 1, clientOrderId: 1 }, { unique: true });
orderSchema.index({ tenantId: 1, accountId: 1, status: 1, createdAt: -1 });
orderSchema.index({ tenantId: 1, accountId: 1, symbol: 1, status: 1 });
orderSchema.index({ status: 1, expiresAt: 1 });

orderSchema.pre('validate', function validateOrderShape(next) {
  try {
    if (this.type === 'LIMIT' && this.limitPrice == null) this.invalidate('limitPrice', 'LIMIT orders require limitPrice');
    if (this.type === 'STOP' && this.stopPrice == null) this.invalidate('stopPrice', 'STOP orders require stopPrice');
    if (this.type === 'STOP_LIMIT') { if (this.stopPrice == null) this.invalidate('stopPrice', 'STOP_LIMIT orders require stopPrice'); if (this.limitPrice == null) this.invalidate('limitPrice', 'STOP_LIMIT orders require limitPrice'); }
    if (['SPECIFIED', 'TODAY'].includes(this.timeInForce) && !this.expiresAt) this.invalidate('expiresAt', `${this.timeInForce} orders require expiresAt`);
    if (this.requestedVolume != null && compareDecimal(this.requestedVolume, '0') <= 0) this.invalidate('requestedVolume', 'requestedVolume must be greater than zero');
    if (this.filledVolume != null && compareDecimal(this.filledVolume, '0') < 0) this.invalidate('filledVolume', 'filledVolume cannot be negative');
    if (this.requestedVolume != null && this.filledVolume != null && compareDecimal(this.filledVolume, this.requestedVolume) > 0) this.invalidate('filledVolume', 'filledVolume cannot exceed requestedVolume');
    for (const field of ['limitPrice', 'stopPrice', 'stopLoss', 'takeProfit', 'acceptedPrice']) if (this[field] != null && compareDecimal(this[field], '0') <= 0) this.invalidate(field, `${field} must be greater than zero`);
    if (['PENDING', 'TRIGGERED', 'CANCELLED', 'EXPIRED', 'REJECTED'].includes(this.status) && this.filledVolume != null && compareDecimal(this.filledVolume, '0') !== 0) this.invalidate('filledVolume', `${this.status} orders require zero filledVolume`);
    if (this.status === 'TRIGGERED') { if (this.type !== 'STOP_LIMIT') this.invalidate('status', 'Only STOP_LIMIT orders can remain TRIGGERED'); if (!this.triggeredAt) this.invalidate('triggeredAt', 'TRIGGERED orders require triggeredAt'); }
    if (this.status === 'FILLED') { if (this.requestedVolume != null && this.filledVolume != null && compareDecimal(this.filledVolume, this.requestedVolume) !== 0) this.invalidate('filledVolume', 'FILLED orders require filledVolume to equal requestedVolume'); if (!this.filledAt) this.invalidate('filledAt', 'FILLED orders require filledAt'); }
    if (this.status === 'CANCELLED' && !this.cancelledAt) this.invalidate('cancelledAt', 'CANCELLED orders require cancelledAt');
    if (this.status === 'EXPIRED' && !this.expiredAt) this.invalidate('expiredAt', 'EXPIRED orders require expiredAt');
    if (this.status === 'REJECTED') { if (!this.rejectedAt) this.invalidate('rejectedAt', 'REJECTED orders require rejectedAt'); if (!this.rejectCode) this.invalidate('rejectCode', 'REJECTED orders require rejectCode'); }
  } catch (error) { this.invalidate('requestedVolume', error.message); }
  next();
});

const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);
module.exports = { Order, orderSchema };
