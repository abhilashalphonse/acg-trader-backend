'use strict';

const mongoose = require('mongoose');
const { AppError } = require('../../shared/errors/app-error');
const { User } = require('./user.model');
const { Tenant } = require('../tenancy/tenant.model');
const { TradingAccount } = require('../accounts/trading-account.model');
const { AccountAccessGrant } = require('./account-access-grant.model');

// Only authenticated, tenant-scoped service credentials may call this service.
// No organization membership or matching email can authorize account access.
class AccountGrantManagementService {
  constructor({ userModel = User, tenantModel = Tenant, accountModel = TradingAccount,
    grantModel = AccountAccessGrant, now = () => new Date() } = {}) {
    Object.assign(this, { userModel, tenantModel, accountModel, grantModel, now });
  }

  async authorizeTarget({ tenantId, accountId, userId, forRevocation = false }) {
    if (![tenantId, accountId, userId].every(mongoose.isValidObjectId)) throw forbidden();
    const [tenant, account, user] = await Promise.all([
      this.tenantModel.findOne({ _id: tenantId }).select('_id status').lean(),
      this.accountModel.findOne({ _id: accountId, tenantId }).select('_id tenantId status').lean(),
      this.userModel.findOne({ _id: userId }).select('_id status').lean(),
    ]);
    if (!tenant || !account || !user || String(account.tenantId) !== String(tenantId) ||
      (!forRevocation && (tenant.status !== 'ACTIVE' || user.status !== 'ACTIVE' ||
        ['DISABLED', 'CLOSED'].includes(account.status)))) throw forbidden();
  }

  async grant({ tenantId, accountId, userId, permissions, clientId }) {
    await this.authorizeTarget({ tenantId, accountId, userId });
    const id = { tenantId, accountId, userId };
    const current = await this.grantModel.findOne(id).select('source').lean();
    if (current && current.source !== 'PARTNER') throw forbidden();
    const record = await this.grantModel.findOneAndUpdate(
      { ...id, $or: [{ source: 'PARTNER' }, { source: { $exists: false } }] },
      {
        $set: { permissions, status: 'ACTIVE', revokedAt: null, expiresAt: null, updatedByClientId: clientId },
        $setOnInsert: { source: 'PARTNER' },
      },
      { upsert: true, new: true, runValidators: true },
    ).lean();
    return { tenantId, accountId, userId, permissions: [...record.permissions], status: record.status };
  }

  async revoke({ tenantId, accountId, userId, clientId }) {
    await this.authorizeTarget({ tenantId, accountId, userId, forRevocation: true });
    const result = await this.grantModel.updateOne(
      { tenantId, accountId, userId, source: 'PARTNER', status: 'ACTIVE' },
      { $set: { status: 'REVOKED', revokedAt: this.now(), updatedByClientId: clientId } },
    );
    return { tenantId, accountId, userId, revoked: Number(result.modifiedCount || 0) > 0 };
  }
}

function forbidden() {
  return new AppError('Account grant operation is not authorized', { statusCode: 403, code: 'ACCOUNT_GRANT_FORBIDDEN' });
}

module.exports = { AccountGrantManagementService };
