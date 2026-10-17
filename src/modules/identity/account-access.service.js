'use strict';

const { AppError } = require('../../shared/errors/app-error');
const { User } = require('./user.model');
const { Tenant } = require('../tenancy/tenant.model');
const { TradingAccount } = require('../accounts/trading-account.model');
const { AccountAccessGrant } = require('./account-access-grant.model');

const PERMISSIONS = new Set(['VIEW', 'TRADE', 'MANAGE']);

class AccountAccessService {
  constructor({ userModel = User, tenantModel = Tenant, accountModel = TradingAccount, grantModel = AccountAccessGrant, now = () => new Date() } = {}) {
    Object.assign(this, { userModel, tenantModel, accountModel, grantModel, now });
  }

  // No rights are inferred from matching email, tenant membership, profile, or account ownership references.
  // This service is not used by legacy sessions until the separate session-migration PR.
  async requireGrant({ userId, tenantId, accountId, permission }) {
    if (!PERMISSIONS.has(permission) || !userId || !tenantId || !accountId) throw forbidden();
    const [user, tenant, account, grant] = await Promise.all([
      this.userModel.findOne({ _id: userId, status: 'ACTIVE' }).lean(),
      this.tenantModel.findOne({ _id: tenantId, status: 'ACTIVE' }).lean(),
      this.accountModel.findOne({ _id: accountId, tenantId }).select('_id tenantId status').lean(),
      this.grantModel.findOne({
        tenantId, accountId, userId, status: 'ACTIVE', revokedAt: null, permissions: permission,
        $or: [{ expiresAt: null }, { expiresAt: { $gt: this.now() } }],
      }).lean(),
    ]);
    if (!user || !tenant || !account || !grant || String(account.tenantId) !== String(tenantId) || ['DISABLED', 'CLOSED'].includes(account.status)) throw forbidden();
    return { userId: String(user._id), tenantId: String(tenant._id), accountId: String(account._id), permission };
  }
}

function forbidden() {
  return new AppError('Account access is not authorized', { statusCode: 403, code: 'ACCOUNT_ACCESS_FORBIDDEN' });
}

module.exports = { AccountAccessService };
