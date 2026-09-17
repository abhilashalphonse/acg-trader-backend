'use strict';

const mongoose = require('mongoose');

const { Schema } = mongoose;

const federationTicketSchema = new Schema({
  tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, immutable: true, index: true },
  tokenHash: { type: String, required: true, unique: true, immutable: true, index: true },
  ownerExternalRef: { type: String, required: true, immutable: true, index: true },
  accountIds: [{ type: Schema.Types.ObjectId, ref: 'TradingAccount', required: true }],
  expiresAt: { type: Date, required: true },
  consumedAt: { type: Date, default: null },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, {
  timestamps: true,
  versionKey: false,
});

federationTicketSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const FederationTicket = mongoose.models.FederationTicket || mongoose.model('FederationTicket', federationTicketSchema);

module.exports = { FederationTicket, federationTicketSchema };
