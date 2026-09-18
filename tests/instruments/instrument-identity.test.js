'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeLogoResponse,
  normalizeStoredIdentity,
  isFreshIdentity,
  providerSymbolFor,
} = require('../../src/modules/instruments/instrument-identity.service');

test('normalizes Twelve Data logo payload without exposing malformed URLs', () => {
  assert.deepEqual(normalizeLogoResponse({
    url: 'https://logo.example/aapl.png',
    logo_base: 'https://logo.example/eur.png',
    logo_quote: 'javascript:bad',
  }), {
    logoUrl: 'https://logo.example/aapl.png',
    baseLogoUrl: 'https://logo.example/eur.png',
    quoteLogoUrl: null,
  });
});

test('provider symbol prefers Twelve Data mapping', () => {
  assert.equal(providerSymbolFor({
    symbol: 'EURUSD',
    displaySymbol: 'EUR/USD',
    providerMappings: { twelveData: 'EUR/USD' },
  }), 'EUR/USD');
});

test('ready identities stay cached longer than unavailable identities', () => {
  const now = Date.now();
  const ready = normalizeStoredIdentity({
    provider: 'twelve-data',
    status: 'READY',
    logoUrl: 'https://logo.example/a.png',
    checkedAt: new Date(now - 7 * 24 * 60 * 60 * 1000),
  });
  const unavailable = normalizeStoredIdentity({
    provider: 'twelve-data',
    status: 'UNAVAILABLE',
    checkedAt: new Date(now - 7 * 60 * 60 * 1000),
  });
  assert.equal(isFreshIdentity(ready, now), true);
  assert.equal(isFreshIdentity(unavailable, now), false);
});
