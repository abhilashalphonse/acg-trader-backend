'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;
const Decimal128 = Schema.Types.Decimal128;

const candleSchema = new Schema({
  symbol: { type: String, required: true, uppercase: true, trim: true, index: true },
  timeframe: { type: String, required: true, index: true },
  openTime: { type: Date, required: true, index: true },
  closeTime: { type: Date, required: true },
  open: { type: Decimal128, required: true },
  high: { type: Decimal128, required: true },
  low: { type: Decimal128, required: true },
  close: { type: Decimal128, required: true },
  tickCount: { type: Number, required: true, min: 0, default: 0 },
  providerVolume: { type: Decimal128, default: null },
  complete: { type: Boolean, default: true },
  synthetic: { type: Boolean, default: false },
  source: { type: String, enum: ['LIVE', 'SYNTHETIC', 'BACKFILL'], default: 'LIVE' },
  provider: { type: String, default: null },
  expiresAt: { type: Date, default: null },
}, {
  timestamps: true,
  versionKey: false,
});

candleSchema.index({ symbol: 1, timeframe: 1, openTime: 1 }, { unique: true });
candleSchema.index({ symbol: 1, timeframe: 1, openTime: -1 });
candleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Candle = mongoose.models.Candle || mongoose.model('Candle', candleSchema);

module.exports = { Candle, candleSchema };
