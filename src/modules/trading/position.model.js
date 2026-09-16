'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { ORDER_SIDES, POSITION_STATUSES } = require('./trading.constants');

const { Schema } = mongoose;
const Decimal128 = Schema.Types.Decimal128;

const trailingSchema = new Schema({
  enabled: { type: Boolean, default: false },
  distancePoints: { type: Decimal128, default: null },
  bestPrice: { type: Decimal128, default: null },
  activatedAt: { type: Date, default: null },
}, { _id: false });

const positionSchema = new Schema({
  positionId: { type: String, required: true, unique: true, default: () => crypto.randomUUID(), immutable: true, index: true },
  accountId: { type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true, immutable: true, index: true },
  sourceOrderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, immutable: true, index: true },

  symbol: { type: String, required: true, uppercase: true, trim: true, immutable: true, index: true },
  side: { type: String, required: true, enum: ORDER_SIDES, immutable: true },
  status: { type: String, required: true, enum: POSITION_STATUSES, default: 'OPEN', index: true },

  initialVolume: { type: Decimal128, required: true, immutable: true },
  openVolume: { type: Decimal128, required: true },
  entryPrice: { type: Decimal128, required: true, immutable: true },

  stopLoss: { type: Decimal128, default: null },
  takeProfit: { type: Decimal128, default: null },
  trailing: { type: trailingSchema, default: () => ({}) },

  realizedPnl: { type: Decimal128, required: true, default: '0' },
  commissionPaid: { type: Decimal128, required: true, default: '0' },
  swapPaid: { type: Decimal128, required: true, default: '0' },

  openedAt: { type: Date, required: true, default: Date.now, immutable: true },
  closedAt: { type: Date, default: null },
  closeReason: { type: String, default: null },
  metadata: { type: Map, of: String, default: {} },
}, {
  timestamps: true,
  optimisticConcurrency: true,
});

positionSchema.index({ accountId: 1, status: 1, openedAt: -1 });
positionSchema.index({ accountId: 1, symbol: 1, status: 1 });

positionSchema.pre('validate', function validatePositionState(next) {
  if (this.status === 'CLOSED' && !this.closedAt) this.invalidate('closedAt', 'Closed positions require closedAt');
  if (this.status === 'OPEN' && this.closedAt) this.invalidate('closedAt', 'Open positions cannot have closedAt');
  next();
});

const Position = mongoose.models.Position || mongoose.model('Position', positionSchema);

module.exports = { Position, positionSchema };
