'use strict';

const LEVERAGE_POLICY_VERSION = 2;

// GLOBAL-MARKETS-M1 approved leverage framework.
// Existing open positions keep their stored margin. These limits apply to
// newly created/increased exposure after the catalog policy is migrated.
const ACG_ASSET_CLASS_LEVERAGE = Object.freeze({
  FOREX: 100,
  METAL: 50,
  ENERGY: 50,
  OTHER: 50,
  INDEX: 20,
  EQUITY: 10,
  CRYPTO: 2,
});

function leverageForAssetClass(assetClass) {
  const key = String(assetClass || '').trim().toUpperCase();
  const leverage = ACG_ASSET_CLASS_LEVERAGE[key];
  if (!Number.isFinite(leverage) || leverage <= 0) {
    throw new TypeError(`Unsupported leverage asset class: ${assetClass}`);
  }
  return leverage;
}

module.exports = {
  LEVERAGE_POLICY_VERSION,
  ACG_ASSET_CLASS_LEVERAGE,
  leverageForAssetClass,
};
