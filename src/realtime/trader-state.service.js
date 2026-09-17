'use strict';

const { AppError } = require('../shared/errors/app-error');
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
    });
  }

  async snapshotAccount({ tenantId, accountId }) {
    const id = String(accountId || '').trim();
    const tenant = String(tenantId || '').trim();
    if (!id || !tenant) throw invalidGrant();

    const account = await this.accountModel.findOne({ _id: id, tenantId: tenant }).lean();
    if (!account) {
      throw new AppError('Trading account was not found for this session', {
        statusCode: 404,
        code: 'ACCOUNT_NOT_FOUND',
      });
    }

    const [orders, positions, deals, valuation] = await Promise.all([
      this.orderModel.find({ accountId: id }).sort({ createdAt: -1, _id: -1 }).limit(this.recentOrderLimit).lean(),
      this.positionModel.find({ accountId: id, status: 'OPEN' }).sort({ openedAt: 1, _id: 1 }).lean(),
      this.dealModel.find({ accountId: id }).sort({ executedAt: -1, _id: -1 }).limit(this.recentDealLimit).lean(),
      this.valuationEngine.getOrLoadAccountSnapshot(id),
    ]);

    if (!valuation) {
      throw new AppError('Trading account valuation was not found', {
        statusCode: 404,
        code: 'ACCOUNT_VALUATION_NOT_FOUND',
      });
    }

    return {
      account: serializeAccount(account),
      valuation,
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
