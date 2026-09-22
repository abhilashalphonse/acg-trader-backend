'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateMarketReadiness } = require('../../src/modules/health/health.routes');

test('market readiness stays healthy when some configured markets are closed or stale', () => {
  const result = evaluateMarketReadiness({
    enabled: true,
    state: 'LIVE',
    symbols: [
      { symbol: 'EURUSD', state: 'LIVE', isStale: false },
      { symbol: 'AAPL', state: 'WAITING', isStale: true },
      { symbol: 'GER40', state: 'STALE', isStale: true },
    ],
  });

  assert.equal(result.operational, true);
  assert.equal(result.gatewayLive, true);
  assert.equal(result.symbolsConfigured, true);
  assert.equal(result.subscriptionErrorCount, 0);
});

test('market readiness allows partial provider mapping failures without taking down the platform', () => {
  const result = evaluateMarketReadiness({
    enabled: true,
    state: 'LIVE',
    symbols: [
      { symbol: 'EURUSD', state: 'LIVE', isStale: false },
      { symbol: 'UNSUPPORTED', state: 'SUBSCRIPTION_ERROR', isStale: true },
    ],
  });

  assert.equal(result.operational, true);
  assert.equal(result.subscriptionErrorCount, 1);
});

test('market readiness fails when the provider gateway is disconnected', () => {
  const result = evaluateMarketReadiness({
    enabled: true,
    state: 'DISCONNECTED',
    symbols: [{ symbol: 'EURUSD', state: 'DISCONNECTED', isStale: true }],
  });
  assert.equal(result.operational, false);
});

test('market readiness fails when every configured provider subscription is rejected', () => {
  const result = evaluateMarketReadiness({
    enabled: true,
    state: 'LIVE',
    symbols: [
      { symbol: 'ONE', state: 'SUBSCRIPTION_ERROR', isStale: true },
      { symbol: 'TWO', state: 'SUBSCRIPTION_ERROR', isStale: true },
    ],
  });
  assert.equal(result.operational, false);
  assert.equal(result.subscriptionErrorCount, 2);
});

test('disabled market gateway blocks trading readiness', () => {
  const result = evaluateMarketReadiness({ enabled: false, state: 'DISABLED', symbols: [] });
  assert.equal(result.operational, false);
  assert.equal(result.gatewayLive, false);
  assert.equal(result.symbolsConfigured, false);
});
