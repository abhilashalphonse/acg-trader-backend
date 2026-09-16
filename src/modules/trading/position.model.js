'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const { compareDecimal } = require('../../shared/decimal/decimal');
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

  contractSize: { type: Decimal128, required: true, immutable: true },
  volumeStep: { type: Decimal128, required: true, immutable: true },
  quoteCurrency: { type: String, required: true, uppercase: true, trim: true, immutable: true },
  margin: { type: Decimal128, required: true, default: '0' },

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
  try {
    if (this.initialVolume != null && compareDecimal(this.initialVolume, '0') <= 0) this.invalidate('initialVolume', 'initialVolume must be greater than zero');
    if (this.openVolume != null && compareDecimal(this.openVolume, '0') < 0) this.invalidate('openVolume', 'openVolume cannot be negative');
    if (this.initialVolume != null && this.openVolume != null && compareDecimal(this.openVolume, this.initialVolume) > 0) {
      this.invalidate('openVolume', 'openVolume cannot exceed initialVolume');
    }
    if (this.entryPrice != null && compareDecimal(this.entryPrice, '0') <= 0) this.invalidate('entryPrice', 'entryPrice must be greater than zero');
    if (this.contractSize != null && compareDecimal(this.contractSize, '0') <= 0) this.invalidate('contractSize', 'contractSize must be greater than zero');
    if (this.volumeStep != null && compareDecimal(this.volumeStep, '0') <= 0) this.invalidate('volumeStep', 'volumeStep must be greater than zero');
    if (this.margin != null && compareDecimal(this.margin, '0') < 0) this.invalidate('margin', 'margin cannot be negative');

    if (this.status === 'CLOSED') {
      if (!this.closedAt) this.invalidate('closedAt', 'Closed positions require closedAt');
      if (this.openVolume != null && compareDecimal(this.openVolume, '0') !== 0) this.invalidate('openVolume', 'Closed positions require zero openVolume');
      if (this.margin != null && compareDecimal(this.margin, '0') !== 0) this.invalidate('margin', 'Closed positions require zero margin');
    }
    if (this.status === 'OPEN') {
      if (this.closedAt) this.invalidate('closedAt', 'Open positions cannot have closedAt');
      if (this.openVolume != null && compareDecimal(this.openVolume, '0') <= 0) this.invalidate('openVolume', 'Open positions require positive openVolume');
    }
    if (this.trailing?.enabled && (this.trailing.distancePoints == null || compareDecimal(this.trailing.distancePoints, '0') <= 0)) {
      this.invalidate('trailing.distancePoints', 'Enabled trailing stop requires positive distancePoints');
    }
  } catch (error) {
    this.invalidate('openVolume', error.message);
  }
  next();
});

const Position = mongoose.models.Position || mongoose.model('Position', positionSchema);

module.exports = { Position, positionSchema };
