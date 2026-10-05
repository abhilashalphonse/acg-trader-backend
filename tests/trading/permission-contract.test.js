'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { assertPermissionContract, applyPermissionUpdate } = require('../../src/modules/trading/trading-permission-contract');
const { amendmentIncreasesRisk } = require('../../src/modules/trading/pending-amendment-policy');

test('permission contracts reject missing fields, stale versions and conflicting replays', () => {
  for (const [permissions, version] of [[{}, 1], [{ newsTrading: true }, 1], [{ newsTrading: false, weekendHolding: false }, 0]]) {
    assert.throws(() => assertPermissionContract(permissions, version), { code: 'PROVISIONING_CONTRACT_INVALID' });
  }
  const permissions = { newsTrading: false, weekendHolding: true };
  const account = { tradingPermissions: permissions, tradingPermissionsVersion: 2 };
  assert.equal(applyPermissionUpdate(account, permissions, 2), false);
  assert.throws(() => applyPermissionUpdate(account, permissions, 1), { code: 'TRADING_PERMISSION_VERSION_STALE' });
  assert.throws(() => applyPermissionUpdate(account, { ...permissions, weekendHolding: false }, 2), { code: 'TRADING_PERMISSION_VERSION_CONFLICT' });
  assert.equal(applyPermissionUpdate(account, { ...permissions, weekendHolding: false }, 3), true);
  assert.equal(account.tradingPermissionsVersion, 3);
});

test('pending risk classification allows reductions/protection tightening but gates extra exposure', () => {
  for (const side of ['BUY', 'SELL']) {
    const order = { side, requestedVolume: '1', limitPrice: '100', stopPrice: null, stopLoss: side === 'BUY' ? '90' : '110', expiresAt: '2026-10-05T00:00:00Z' };
    const amended = { ...order, volume: '0.5' };
    assert.equal(amendmentIncreasesRisk(order, amended), false);
    assert.equal(amendmentIncreasesRisk(order, { ...amended, stopLoss: side === 'BUY' ? '95' : '105' }), false);
    for (const patch of [{ volume: '2' }, { limitPrice: '101' }, { stopLoss: null }, { stopLoss: side === 'BUY' ? '85' : '115' }, { expiresAt: null }, { expiresAt: '2026-10-06T00:00:00Z' }]) {
      assert.equal(amendmentIncreasesRisk(order, { ...amended, ...patch }), true);
    }
  }
});
