'use strict';
const mongoose = require('mongoose');
const { AiReadGrant } = require('./ai-read-grant.model');
const { TradingAccount } = require('../accounts/trading-account.model');
const { AccountAccessGrant } = require('../identity/account-access-grant.model');
const { Position } = require('../trading/position.model');
const { Order } = require('../trading/order.model');

const read = q => q.read('primary').readConcern('majority').maxTimeMS(2000).lean();
const accountScope = s => ({ tenantId: s.tenantId, accountId: s.accountId });
function createAiReadStore() {
  return {
    async account(s, nowMs) {
      const grant = await read(AccountAccessGrant.findOne({ ...accountScope(s), userId: s.actorId,
        source: 'PERSONAL', status: 'ACTIVE', revokedAt: null, permissions: 'VIEW',
        $or: [{ expiresAt: null }, { expiresAt: mongoose.trusted({ $gt: new Date(nowMs) }) }],
      }).select('_id'));
      if (!grant) return null;
      return read(TradingAccount.findOne({ _id: s.accountId, tenantId: s.tenantId, userId: s.actorId,
        accountType: 'DEMO', 'metadata.product': 'DEFAULT_DEMO_V1',
        'metadata.ownership': 'ACG_TRADER_PERSONAL_V1',
        status: mongoose.trusted({ $nin: ['DISABLED','CLOSED'] }),
      }).select('state currency financialRevision updatedAt'));
    },
    getGrant(id) { return read(AiReadGrant.findById(id)); },
    async createGrant(doc) {
      try { await AiReadGrant.create(doc); return true; }
      catch (error) { if (error?.code === 11000) return false; throw error; }
    },
    async revokeGrant(id, connectionId) {
      const result = await AiReadGrant.updateOne({ _id: id, connectionId, status: 'ACTIVE' },
        { $set: { status: 'REVOKED', revokedAt: new Date() } }, { maxTimeMS: 2000, writeConcern: { w: 'majority' } });
      return result.matchedCount === 1;
    },
    positions(s, limit) {
      return read(Position.find({ ...accountScope(s), status: 'OPEN' })
        .select('symbol side openVolume entryPrice stopLoss takeProfit openedAt updatedAt').sort({ openedAt: -1, _id: -1 }).limit(limit));
    },
    orders(s, limit) {
      return read(Order.find({ ...accountScope(s), status: mongoose.trusted({ $in: ['PENDING','TRIGGERED'] }) })
        .select('symbol side type status requestedVolume limitPrice stopPrice stopLoss takeProfit expiresAt').sort({ createdAt: -1, _id: -1 }).limit(limit));
    },
  };
}
module.exports = { createAiReadStore };
