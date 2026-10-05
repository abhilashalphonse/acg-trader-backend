'use strict';
const { AppError } = require('../../shared/errors/app-error');

function assertPermissionContract(permissions, version) {
  if (!Number.isSafeInteger(version) || version < 1 || typeof permissions?.newsTrading !== 'boolean' || typeof permissions?.weekendHolding !== 'boolean') {
    throw new AppError('Explicit news/weekend permissions and a positive permission version are required', {
      statusCode: 400, code: 'PROVISIONING_CONTRACT_INVALID',
    });
  }
}

function applyPermissionUpdate(account, permissions, version) {
  assertPermissionContract(permissions, version);
  const current = Number(account.tradingPermissionsVersion || 0);
  if (version < current) throw new AppError('Trading permission update is older than the current contract', { statusCode: 409, code: 'TRADING_PERMISSION_VERSION_STALE' });
  if (version === current) {
    if (account.tradingPermissions?.newsTrading !== permissions.newsTrading || account.tradingPermissions?.weekendHolding !== permissions.weekendHolding) {
      throw new AppError('Trading permission version has conflicting contents', { statusCode: 409, code: 'TRADING_PERMISSION_VERSION_CONFLICT' });
    }
    return false;
  }
  account.tradingPermissions = permissions;
  account.tradingPermissionsVersion = version;
  return true;
}
module.exports = { assertPermissionContract, applyPermissionUpdate };
