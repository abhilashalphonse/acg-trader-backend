'use strict';

const { LEVERAGE_POLICY_VERSION, leverageForAssetClass } = require('./leverage-policy');

// Initial Accelpix/NSE validation universe.
//
// Keep these instruments outside the primary ACG execution catalog. The normal
// catalog has a one-time execution provisioning path; Indian equities must stay
// chart-only until product sizing, margin, commission, corporate-action and
// execution rules are explicitly approved.
//
// Tick/pip/volume fields below satisfy the common Instrument schema for display
// and chart plumbing only. executionEnabled=false is an invariant here.

const INDIA_EQUITY_SESSION = Object.freeze([
  Object.freeze({ days: [1, 2, 3, 4, 5], open: '09:15', close: '15:30' }),
]);

// NSE equity trading holidays for calendar year 2026.
//
// Session state must follow the exchange calendar, not generic Mon-Fri business
// days or provider connectivity. Weekend-only holidays do not need a duplicate
// entry because INDIA_EQUITY_SESSION already closes Saturdays and Sundays.
const NSE_EQUITY_HOLIDAYS_2026 = Object.freeze([
  '2026-01-15',
  '2026-01-26',
  '2026-03-03',
  '2026-03-26',
  '2026-03-31',
  '2026-04-03',
  '2026-04-14',
  '2026-05-01',
  '2026-05-28',
  '2026-06-26',
  '2026-09-14',
  '2026-10-02',
  '2026-10-20',
  '2026-11-10',
  '2026-11-24',
  '2026-12-25',
]);

function marketSpread() {
  return Object.freeze({
    mode: 'MARKET',
    fixedPoints: null,
    markupPoints: '0',
    normalPoints: null,
    minimumPoints: null,
    maximumPoints: null,
    rolloverMultiplier: '1',
    rolloverStartUtcMinute: null,
    rolloverEndUtcMinute: null,
    volumeBands: Object.freeze([]),
  });
}

function nseEquity({ symbol, name, providerSymbol = symbol }) {
  return Object.freeze({
    symbol,
    displaySymbol: symbol,
    name,
    assetClass: 'EQUITY',
    baseCurrency: null,
    quoteCurrency: 'INR',
    pnlCurrency: 'INR',
    marginCurrency: 'INR',

    digits: 2,
    tickSize: '0.01',
    pipSize: '0.01',
    contractSize: '1',

    minVolume: '1',
    maxVolume: '10000',
    volumeStep: '1',

    defaultLeverage: leverageForAssetClass('EQUITY'),
    leveragePolicyVersion: LEVERAGE_POLICY_VERSION,
    marginRate: null,
    commissionPerLot: '0',
    commissionPerLotPerSide: '0',
    commissionRate: '0',
    swapLong: '0',
    swapShort: '0',

    spread: marketSpread(),

    tradingSessions: INDIA_EQUITY_SESSION,
    tradingHolidays: NSE_EQUITY_HOLIDAYS_2026,
    timezone: 'Asia/Kolkata',

    providerMappings: Object.freeze({ accelpix: providerSymbol }),

    softQuoteAgeMs: 4000,
    maxQuoteAgeMs: 12000,

    chartEnabled: true,
    executionEnabled: false,
    executionProvisionVersion: 0,
    status: 'ACTIVE',
  });
}

const ACG_INDIA_PILOT_CATALOG = Object.freeze([
  nseEquity({ symbol: 'RELIANCE', name: 'Reliance Industries Ltd' }),
  nseEquity({ symbol: 'TCS', name: 'Tata Consultancy Services Ltd' }),
  nseEquity({ symbol: 'HDFCBANK', name: 'HDFC Bank Ltd' }),
  nseEquity({ symbol: 'INFY', name: 'Infosys Ltd' }),
  nseEquity({ symbol: 'SBIN', name: 'State Bank of India' }),
]);

module.exports = {
  ACG_INDIA_PILOT_CATALOG,
  INDIA_EQUITY_SESSION,
  NSE_EQUITY_HOLIDAYS_2026,
};
