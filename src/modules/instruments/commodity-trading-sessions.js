'use strict';

// Reference-market sessions for ACG's simulated commodity catalog, NOT a claim
// about Twelve Data's aggregate/spot quote uptime. The sessions are deliberately
// instrument-specific; a single FX calendar is unsafe for metals, energy and
// exchange-traded agricultural instruments.
//
// Weekday numbering uses UTC JavaScript getUTCDay conventions (Sun=0), applied
// to each profile's IANA local time zone. The session-calendar module converts
// those local wall-clock sessions across US DST changes.
// Holidays / early closes require per-date tradingHolidays or sessionOverrides.
// Before enabling these rules in production, compare each Twelve Data symbol
// with the mapped reference market and check any exceptions.

function sessions(entries) {
  return Object.freeze(entries.map(([days, open, close]) => Object.freeze({
    days: Object.freeze(days.slice()), open, close,
  })));
}
function profile(timezone, entries) {
  return Object.freeze({ timezone, tradingSessions: sessions(entries) });
}

const NY_OVERNIGHT = profile('America/New_York', [
  [[0, 1, 2, 3, 4], '18:00', '17:00'],
]);
const ICE_BRENT = profile('America/New_York', [
  // ICE quotes a Sunday open at 23:00 London (normally 18:00 NY); the
  // weekday session opens at 20:00 NY. Explicit Sunday/Monday segments avoid
  // the unsupported open===close 24-hour session representation.
  [[0], '18:00', '23:59'],
  [[1], '00:00', '18:00'],
  [[1, 2, 3, 4], '20:00', '18:00'],
]);
const CBOT_GRAINS = profile('America/Chicago', [
  [[0, 1, 2, 3, 4], '19:00', '07:45'],
  [[1, 2, 3, 4, 5], '08:30', '13:20'],
]);
const ICE_SUGAR = profile('America/New_York', [
  [[1, 2, 3, 4, 5], '03:30', '13:00'],
]);
const ICE_COFFEE = profile('America/New_York', [
  [[1, 2, 3, 4, 5], '04:15', '13:30'],
]);
const ICE_COCOA = profile('America/New_York', [
  [[1, 2, 3, 4, 5], '04:45', '13:30'],
]);
const ICE_COTTON = profile('America/New_York', [
  [[0, 1, 2, 3, 4], '21:00', '14:20'],
]);
const CME_LIVESTOCK = profile('America/Chicago', [
  [[1, 2, 3, 4, 5], '08:30', '13:05'],
]);

const reference = (schedule, sourceUrl) => Object.freeze({
  ...schedule,
  referenceUrl: sourceUrl,
});

// Each catalog symbol has an independently identified reference contract.
// The reference is used to define a session *boundary*, not to equate the
// CFD/spot instrument or Twelve Data's aggregate price with the future.
const COMMODITY_SESSIONS = Object.freeze({
  XAUUSD: reference(NY_OVERNIGHT, 'https://www.cmegroup.com/markets/metals/precious/gold/specs'),
  XAGUSD: reference(NY_OVERNIGHT, 'https://www.cmegroup.com/markets/metals/precious/silver/specs'),
  XPTUSD: reference(NY_OVERNIGHT, 'https://www.cmegroup.com/markets/metals/precious/platinum/specs'),
  XPDUSD: reference(NY_OVERNIGHT, 'https://www.cmegroup.com/markets/metals/precious/palladium/specs'),
  WTIUSD: reference(NY_OVERNIGHT, 'https://www.cmegroup.com/education/courses/introduction-to-energy/introduction-to-crude-oil/wti-overview'),
  XBRUSD: reference(ICE_BRENT, 'https://www.ice.com/products/219/Brent-Crude-Futures'),
  NGASUSD: reference(NY_OVERNIGHT, 'https://www.cmegroup.com/articles/faqs/micro-henry-hub-natural-gas-futures-and-options-frequently-asked-questions.html'),
  COPPER: reference(NY_OVERNIGHT, 'https://www.cmegroup.com/markets/metals/base/copper/specs'),
  CORN: reference(CBOT_GRAINS, 'https://www.cmegroup.com/markets/agriculture/grains/corn/specs'),
  WHEAT: reference(CBOT_GRAINS, 'https://www.cmegroup.com/markets/agriculture/grains/wheat/specs'),
  SOYBEAN: reference(CBOT_GRAINS, 'https://www.cmegroup.com/markets/agriculture/oilseeds/soybean/specs'),
  SUGAR: reference(ICE_SUGAR, 'https://www.ice.com/products/23/Sugar-No-11-Futures'),
  COFFEE: reference(ICE_COFFEE, 'https://www.ice.com/products/15/Coffee'),
  COCOA: reference(ICE_COCOA, 'https://www.ice.com/products/7/Cocoa-Futures'),
  COTTON: reference(ICE_COTTON, 'https://www.ice.com/products/254/cotton-no-2-futures/specs'),
  CATTLE: reference(CME_LIVESTOCK, 'https://www.cmegroup.com/markets/agriculture/livestock/live-cattle/specs'),
  HOGS: reference(CME_LIVESTOCK, 'https://www.cmegroup.com/markets/agriculture/livestock/lean-hogs/specs'),
  GASOLINE: reference(NY_OVERNIGHT, 'https://www.cmegroup.com/markets/energy/refined-products/rbob-gasoline'),
  HEATOIL: reference(NY_OVERNIGHT, 'https://www.cmegroup.com/markets/energy/refined-products/heating-oil'),
  ALUMINUM: reference(NY_OVERNIGHT, 'https://www.cmegroup.com/markets/metals/base/aluminum/specs'),
});

function sessionForCommodity(symbol) {
  const rule = COMMODITY_SESSIONS[String(symbol || '').toUpperCase()];
  if (!rule) throw new Error(`Missing verified commodity session: ${symbol}`);
  return rule;
}

module.exports = { COMMODITY_SESSIONS, sessionForCommodity };
