'use strict';

const { AppError } = require('../shared/errors/app-error');
const mongoose = require('mongoose');
const { TradingAccount } = require('../modules/accounts/trading-account.model');
const { Order } = require('../modules/trading/order.model');
const { Position } = require('../modules/trading/position.model');
const { Deal } = require('../modules/trading/deal.model');
const {
  serializeAccount,
  serializeOrder,
  serializePosition,
  serializeDeal,
} = require('../modules/trading/trading.serializer');

class TraderStateService {
  constructor({
    valuationEngine,
    accountModel = TradingAccount,
    orderModel = Order,
    positionModel = Position,
    dealModel = Deal,
    recentOrderLimit = 100,
    recentDealLimit = 100,
    readTransaction = work => mongoose.connection.transaction(work, { readConcern: { level: 'snapshot' }, readPreference: 'primary' }),
  } = {}) {
    if (!valuationEngine) throw new Error('valuationEngine is required');
    Object.assign(this, {
      valuationEngine,
      accountModel,
      orderModel,
      positionModel,
      dealModel,
      recentOrderLimit,
      recentDealLimit,
      readTransaction,
    });
  }

  async snapshotAccount({ tenantId, accountId }) {
    const id = String(accountId || '').trim();
    const tenant = String(tenantId || '').trim();
    if (!id || !tenant) throw invalidGrant();

    const { account, orders, positions, deals } = await this.readTransaction(async session => {
      const account = await this.accountModel.findOne({ _id: id, tenantId: tenant }).session(session).lean();
      if (!account) {
        throw new AppError('Trading account was not found for this session', {
          statusCode: 404,
          code: 'ACCOUNT_NOT_FOUND',
        });
      }

      // Use one database snapshot. Parallel commands on the same session are unsupported.
      const orders = await this.orderModel.find({ accountId: id }).sort({ createdAt: -1, _id: -1 }).limit(this.recentOrderLimit).session(session).lean();
      const positions = await this.positionModel.find({ accountId: id, status: 'OPEN' }).sort({ openedAt: 1, _id: 1 }).session(session).lean();
      const deals = await this.dealModel.find({ accountId: id }).sort({ executedAt: -1, _id: -1 }).limit(this.recentDealLimit).session(session).lean();
      return { account, orders, positions, deals };
    });
    const { valuation, positionValuations } = this.valuationEngine.valueAccountState(account, positions);

    return {
      account: serializeAccount(account),
      valuation,
      positionValuations,
      positions: positions.map(serializePosition),
      orders: orders.map(serializeOrder),
      fills: deals.map(serializeDeal),
    };
  }

  async snapshotAccounts({ tenantId, accountIds }) {
    const ids = [...new Set((accountIds || []).map(value => String(value)).filter(Boolean))];
    return Promise.all(ids.map(accountId => this.snapshotAccount({ tenantId, accountId })));
  }
}

function invalidGrant() {
  return new AppError('Tenant and account grants are required', {
    statusCode: 400,
    code: 'ACCOUNT_GRANT_REQUIRED',
  });
}

module.exports = { TraderStateService };
