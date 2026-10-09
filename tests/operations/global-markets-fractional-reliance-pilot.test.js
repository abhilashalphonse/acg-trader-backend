'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ACG_INDIA_PILOT_CATALOG } = require('../../src/modules/instruments/india-pilot-catalog');
const { sizeMarketOrder } = require('../../src/modules/trading/order-sizing');
const { multiplyDecimal, compareDecimal } = require('../../src/shared/decimal/decimal');

test('RELIANCE simulated staging pilot supports fractional 0.001 unit without enabling customer execution', () => {
  const reliance = ACG_INDIA_PILOT_CATALOG.find(instrument => instrument.symbol === 'RELIANCE');
  assert.ok(reliance);
  assert.equal(reliance.volumeStep, '0.001');
  assert.equal(reliance.minVolume, '0.001');
  assert.equal(reliance.contractSize, '1');
  assert.equal(reliance.executionEnabled, false);
  assert.equal(reliance.quoteCurrency, 'INR');
  assert.equal(reliance.pnlCurrency, 'INR');
  assert.equal(reliance.marginCurrency, 'INR');
  assert.equal(reliance.defaultLeverage, 10);
  assert.equal(reliance.corporateActionPolicy, 'UNSUPPORTED');
});

test('Other India chart-only symbols retain whole-share quantities until separately approved', () => {
  for (const item of ACG_INDIA_PILOT_CATALOG.filter(x => x.symbol !== 'RELIANCE')) {
    assert.equal(item.volumeStep, '1', item.symbol);
    assert.equal(item.minVolume, '1', item.symbol);
    assert.equal(item.executionEnabled, false, item.symbol);
  }
});

test('catalog-specified RELIANCE step allows the original $50 risk fixture without exceeding budget', () => {
  const instrument = ACG_INDIA_PILOT_CATALOG.find(x => x.symbol === 'RELIANCE');
  const budget = '50';
  const result = sizeMarketOrder({
    mode: 'RISK', amount: budget, instrument,
    evaluate: volume => ({
      volume,
      riskAmount: multiplyDecimal(volume, '4.021'),
      exposureAccountCurrency: multiplyDecimal(volume, '15.83'),
    }),
  });
  assert.equal(result.volume, '12.434');
  assert.ok(compareDecimal(result.actualAmount, budget) <= 0);
  assert.ok(compareDecimal(multiplyDecimal('12.435', '4.021'), budget) > 0);
});
