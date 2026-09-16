'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const {
  ORDER_SIDES,
  ORDER_TYPES,
  ORDER_STATUSES,
  TIME_IN_FORCE,
  ORDER_SOURCES,
} = require('./trading.constants');

const { Schema } = mongoose;
const Decimal128 = Schema.Types.Decimal128;

const orderSchema = new Schema({
  orderId: { type: String, required: true, unique: true, default: () => crypto.randomUUID(), immutable: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  clientOrderId: { type: String, required: true, trim: true, maxlength: 128, immutable: true },

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
}, {
  timestamps: true,
  optimisticConcurrency: true,
});

orderSchema.index({ accountId: 1, clientOrderId: 1 }, { unique: true });
orderSchema.index({ accountId: 1, status: 1, createdAt: -1 });
orderSchema.index({ accountId: 1, symbol: 1, status: 1 });

orderSchema.pre('validate', function validateOrderShape(next) {
  if (this.type === 'LIMIT' && this.limitPrice == null) this.invalidate('limitPrice', 'LIMIT orders require limitPrice');
  if (this.type === 'STOP' && this.stopPrice == null) this.invalidate('stopPrice', 'STOP orders require stopPrice');
  if (this.type === 'STOP_LIMIT') {
    if (this.stopPrice == null) this.invalidate('stopPrice', 'STOP_LIMIT orders require stopPrice');
    if (this.limitPrice == null) this.invalidate('limitPrice', 'STOP_LIMIT orders require limitPrice');
  }
  if (this.timeInForce === 'SPECIFIED' && !this.expiresAt) this.invalidate('expiresAt', 'SPECIFIED orders require expiresAt');
  next();
});

const Order = mongoose.models.Order || mongoose.model('Order', orderSchema);

module.exports = { Order, orderSchema };
