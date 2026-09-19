'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;
const Decimal128 = Schema.Types.Decimal128;

const sessionSchema = new Schema({
  days: [{ type: Number, min: 0, max: 6 }],
  open: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
  close: { type: String, required: true, match: /^\d{2}:\d{2}$/ },
}, { _id: false });

const identitySchema = new Schema({
  provider: { type: String, enum: ['twelve-data'], default: 'twelve-data' },
  status: { type: String, enum: ['UNKNOWN', 'READY', 'UNAVAILABLE'], default: 'UNKNOWN' },
  logoUrl: { type: String, default: null },
  baseLogoUrl: { type: String, default: null },
  quoteLogoUrl: { type: String, default: null },
  checkedAt: { type: Date, default: null },
}, { _id: false });

const instrumentSchema = new Schema({
  symbol: { type: String, required: true, unique: true, uppercase: true, trim: true },
  displaySymbol: { type: String, required: true, trim: true },
  name: { type: String, required: true, trim: true },
  assetClass: {
    type: String,
    required: true,
    enum: ['FOREX', 'METAL', 'INDEX', 'ENERGY', 'EQUITY', 'CRYPTO', 'OTHER'],
    index: true,
  },
  baseCurrency: { type: String, uppercase: true, trim: true, default: null },
  quoteCurrency: { type: String, uppercase: true, trim: true, default: null },
  pnlCurrency: { type: String, uppercase: true, trim: true, default: null },
  marginCurrency: { type: String, uppercase: true, trim: true, default: null },

  digits: { type: Number, required: true, min: 0, max: 12 },
  tickSize: { type: Decimal128, required: true },
  pipSize: { type: Decimal128, required: true },
  contractSize: { type: Decimal128, required: true },

  minVolume: { type: Decimal128, required: true },
  maxVolume: { type: Decimal128, required: true },
  volumeStep: { type: Decimal128, required: true },

  defaultLeverage: { type: Number, required: true, min: 1 },
  marginRate: { type: Decimal128, default: null },
  commissionPerLot: { type: Decimal128, default: null },
  swapLong: { type: Decimal128, default: null },
  swapShort: { type: Decimal128, default: null },

  spread: {
    mode: { type: String, enum: ['MARKET', 'FIXED', 'SYNTHETIC'], default: 'MARKET' },
    fixedPoints: { type: Decimal128, default: null },
    markupPoints: { type: Decimal128, default: '0' },
  },

  tradingSessions: { type: [sessionSchema], default: [] },
  tradingHolidays: { type: [String], default: [] },
  timezone: { type: String, default: 'UTC' },

  providerMappings: { type: Map, of: String, default: {} },
  identity: { type: identitySchema, default: undefined },
  softQuoteAgeMs: { type: Number, default: 5000, min: 100 },
  maxQuoteAgeMs: { type: Number, default: 30000, min: 500 },

  chartEnabled: { type: Boolean, default: true, index: true },
  executionEnabled: { type: Boolean, default: false, index: true },
  executionProvisionVersion: { type: Number, default: 0, min: 0 },
  status: { type: String, enum: ['ACTIVE', 'HALTED', 'MAINTENANCE', 'DISABLED'], default: 'ACTIVE', index: true },
}, {
  timestamps: true,
  versionKey: false,
});

instrumentSchema.index({ assetClass: 1, status: 1, chartEnabled: 1 });

const Instrument = mongoose.models.Instrument || mongoose.model('Instrument', instrumentSchema);

module.exports = { Instrument, instrumentSchema };
