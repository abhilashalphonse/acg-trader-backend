'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MUTATION_ACK,
  assertStagingAcceptanceEnvironment,
  assertAuthoritativeSizing,
  partialCloseVolume,
  assertNativeCloseEvidence,
  assertFlatAccountAfterThreeMutations,
} = require('../../src/modules/operations/global-markets-acceptance-contract');

function config(baseUrl = 'https://discerning-presence-staging.up.railway.app') {
  return {
    baseUrl,
    deploymentEnvironment: 'staging',
    mutationAcknowledgement: MUTATION_ACK,
    accountId: '507f1f77bcf86cd799439011',
    bearer: 'staging-customer-token',
    stopLoss: '1063.60',
  };
}
const preview = {
  previewVersion: 'ACG_ORDER_PREVIEW_V1',
  accountCurrency: 'USD', symbol: 'RELIANCE',
  volume: '12.434',
  sizing: { mode: 'RISK', requestedAmount: '50', actualAmount: '49.9991' },
  risk: { amount: '49.9991' },
  exposure: {
    nativeCurrency: 'INR', nativeAmount: '17725.91',
    accountCurrency: 'USD', amount: '196.90',
    conversion: {
      fromCurrency: 'INR', toCurrency: 'USD',
      path: [{ symbol: 'USDINR', selectedSide: 'ASK', quoteRate: '90.0238' }],
    },
  },
};
const deal = {
  nativeRealizedPnl: '123.45', nativePnlCurrency: 'INR',
  realizedPnl: '1.37', accountPnlCurrency: 'USD',
  pnlConversionEvidence: {
    fromCurrency: 'INR', toCurrency: 'USD',
    path: [{ symbol: 'USDINR', quoteRate: '90.0238' }],
  },
};

test('staging financial mutation gate refuses production URLs and missing acknowledgement', () => {
  assert.equal(assertStagingAcceptanceEnvironment(config()), 'https://discerning-presence-staging.up.railway.app');
  for (const host of [
    'https://acg-trader-backend-production.up.railway.app',
    'https://acgfunded.com',
    'https://staging-production.example.org',
    'http://discerning-presence-staging.up.railway.app',
  ]) {
    assert.throws(() => assertStagingAcceptanceEnvironment(config(host)), /Refusing/);
  }
  assert.throws(() => assertStagingAcceptanceEnvironment({
    ...config(), mutationAcknowledgement: '',
  }), /acknowledgement/);
});

test('server $50 risk preview must fit account budget and quantity step', () => {
  assert.equal(assertAuthoritativeSizing(preview, {
    mode: 'RISK', budget: '50', step: '0.001',
  }), '12.434');
  assert.throws(() => assertAuthoritativeSizing({
    ...preview, sizing: { ...preview.sizing, actualAmount: '50.01' },
  }, { mode: 'RISK', budget: '50' }), /exceeds/);
  assert.throws(() => assertAuthoritativeSizing({
    ...preview, volume: '12.4345',
  }, { mode: 'RISK', budget: '50' }), /unaligned/);
});

test('USD exposure preview must contain explainable INR/USD evidence', () => {
  assert.equal(assertAuthoritativeSizing({
    ...preview,
    sizing: { mode: 'AMOUNT', requestedAmount: '196.90', actualAmount: '196.89' },
  }, { mode: 'AMOUNT', budget: '196.90' }), '12.434');
  assert.throws(() => assertAuthoritativeSizing({
    ...preview, exposure: { ...preview.exposure, conversion: { path: [] } },
  }, { mode: 'RISK', budget: '50' }), /evidence/);
});

test('partial close preserves valid remaining fractional share quantity', () => {
  assert.equal(partialCloseVolume('12.434'), '6.217');
  assert.throws(() => partialCloseVolume('0.001'), /too small/);
});

test('each close must preserve native INR and exact USD conversion path', () => {
  assert.doesNotThrow(() => assertNativeCloseEvidence(deal));
  assert.throws(() => assertNativeCloseEvidence({
    ...deal, pnlConversionEvidence: null,
  }), /conversion/);
});

test('open partial final must leave flat account with exactly three financial revisions', () => {
  assert.doesNotThrow(() => assertFlatAccountAfterThreeMutations(
    { financialRevision: 10 },
    { financialRevision: 13, positionCount: 0,
      balance: '10010', equity: '10010', floatingPnl: '0',
      usedMargin: '0', complete: true },
  ));
  assert.throws(() => assertFlatAccountAfterThreeMutations(
    { financialRevision: 10 },
    { financialRevision: 12, positionCount: 0,
      balance: '10010', equity: '10010', floatingPnl: '0',
      usedMargin: '0', complete: true },
  ), /exactly three/);
});
