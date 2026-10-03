'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeTradingPermissions,
  normalizeCalendarEvent,
  symbolAffectedByEvent,
  weekendStatus,
} = require('../../src/modules/trading/trading-permission-policy.service');

const ms = iso => new Date(iso).getTime();

test('historical accounts with missing permission values stay permissive', () => {
  const permissions = normalizeTradingPermissions({});
  assert.equal(permissions.newsTrading, true);
  assert.equal(permissions.weekendHolding, true);
  assert.equal(permissions.highImpactOnly, true);
  assert.equal(permissions.newsRestrictionBeforeMinutes, 5);
  assert.equal(permissions.newsRestrictionAfterMinutes, 5);
  assert.equal(permissions.closeReduceAlwaysAllowed, true);
  assert.equal(permissions.pendingEntriesBlocked, true);
  assert.equal(permissions.weekendCloseBufferMinutes, 5);
  assert.equal(permissions.weekendBreach, false);
  assert.equal(permissions.carryToMaster, true);
});

test('news mapping restricts only instruments deterministically affected by the event currency', () => {
  const usd = { currency: 'USD', title: 'US CPI' };
  const eurusd = { assetClass: 'FOREX', baseCurrency: 'EUR', quoteCurrency: 'USD' };
  const eurgbp = { assetClass: 'FOREX', baseCurrency: 'EUR', quoteCurrency: 'GBP' };

  assert.equal(symbolAffectedByEvent('EURUSD', eurusd, usd), true);
  assert.equal(symbolAffectedByEvent('EURGBP', eurgbp, usd), false);
  assert.equal(symbolAffectedByEvent('XAUUSD', { assetClass: 'METAL' }, usd), true);
  assert.equal(symbolAffectedByEvent('XAGUSD', { assetClass: 'METAL' }, usd), false);
  assert.equal(symbolAffectedByEvent('US100', { assetClass: 'INDEX' }, usd), true);
  assert.equal(symbolAffectedByEvent('GER40', { assetClass: 'INDEX' }, usd), false);
});

test('oil inventory releases map to energy instruments without becoming a blanket USD restriction', () => {
  const event = { currency: 'USD', title: 'EIA Crude Oil Inventories' };
  assert.equal(symbolAffectedByEvent('USOIL', { assetClass: 'ENERGY' }, event), true);
  assert.equal(symbolAffectedByEvent('UKOIL', { assetClass: 'ENERGY' }, event), true);
  assert.equal(symbolAffectedByEvent('NATGAS', { assetClass: 'ENERGY' }, event), false);
});

test('calendar normalization rejects non-high-impact provider events', () => {
  assert.equal(normalizeCalendarEvent({
    id: 'low-1',
    timestamp: '2026-10-04T13:30:00.000Z',
    impact: 'low',
    currency: 'USD',
    title: 'Minor release',
  }), null);

  const high = normalizeCalendarEvent({
    id: 'high-1',
    timestamp: '2026-10-04T13:30:00.000Z',
    impact: 'high',
    currency: 'USD',
    title: 'US CPI',
  });
  assert.equal(high.impact, 'HIGH');
  assert.equal(high.currency, 'USD');
});

test('weekend holding cutoff activates five minutes before the actual instrument session close', () => {
  const instrument = {
    status: 'ACTIVE',
    timezone: 'UTC',
    tradingHolidays: [],
    tradingSessions: [
      { days: [1, 2, 3, 4], open: '00:00', close: '23:59' },
      { days: [5], open: '00:00', close: '22:00' },
    ],
  };
  const permissions = normalizeTradingPermissions({ weekendHolding: false });

  const before = weekendStatus(instrument, permissions, ms('2026-10-02T21:54:00.000Z'));
  assert.equal(before.active, false);
  assert.equal(before.warning, true);
  assert.equal(before.autoCloseAt, '2026-10-02T21:55:00.000Z');

  const active = weekendStatus(instrument, permissions, ms('2026-10-02T21:56:00.000Z'));
  assert.equal(active.active, true);
  assert.equal(active.marketCloseAt, '2026-10-02T22:00:00.000Z');
});

test('weekend holding permission disables the protective cutoff entirely', () => {
  const permissions = normalizeTradingPermissions({ weekendHolding: true });
  assert.deepEqual(
    weekendStatus({ tradingSessions: [{ days: [5], open: '00:00', close: '22:00' }] }, permissions, ms('2026-10-02T21:59:00.000Z')),
    { active: false, warning: false, marketCloseAt: null, autoCloseAt: null, minutesUntilAutoClose: null },
  );
});
