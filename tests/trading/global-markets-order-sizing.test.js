'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { sizeMarketOrder } = require('../../src/modules/trading/order-sizing');
const { multiplyDecimal, compareDecimal } = require('../../src/shared/decimal/decimal');

const instrument = { minVolume: '0.001', maxVolume: '100', volumeStep: '0.001' };

function planFor(volume) {
  const riskAmount = multiplyDecimal(volume, '4.021');
  return {
    volume,
    riskAmount,
    exposureAccountCurrency: multiplyDecimal(volume, '15.83'),
  };
}

test('risk budget rounds down to supported quantity step, never upward', () => {
  const result = sizeMarketOrder({
    mode: 'RISK',
    amount: '50',
    instrument,
    evaluate: planFor,
  });
  assert.equal(result.volume, '12.434');
  assert.equal(result.actualAmount, '49.999114');
  assert.equal(compareDecimal(result.actualAmount, '50') <= 0, true);
  assert.equal(compareDecimal(planFor('12.435').riskAmount, '50') > 0, true);
});

test('amount sizing uses account-currency exposure not native price', () => {
  const result = sizeMarketOrder({
    mode: 'AMOUNT',
    amount: '196.90',
    instrument,
    evaluate: planFor,
  });
  assert.equal(result.volume, '12.438');
  assert.equal(compareDecimal(result.actualAmount, '196.90') <= 0, true);
  assert.equal(compareDecimal(planFor('12.439').exposureAccountCurrency, '196.90') > 0, true);
});

test('rejects minimum step above budget without rounding up', () => {
  assert.throws(() => sizeMarketOrder({
    mode: 'RISK',
    amount: '0.0001',
    instrument,
    evaluate: planFor,
  }), error => error.code === 'SIZING_BELOW_MIN_VOLUME');
});

test('missing FX or stale valuation errors propagate instead of being treated as unaffordable volume', () => {
  assert.throws(() => sizeMarketOrder({
    mode: 'RISK',
    amount: '50',
    instrument,
    evaluate: () => {
      const error = new Error('fx unavailable');
      error.code = 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE';
      throw error;
    },
  }), error => error.code === 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE');
});

test('insufficient margin reduces the selected quantity instead of bypassing affordability', () => {
  const result = sizeMarketOrder({
    mode: 'RISK',
    amount: '50',
    instrument,
    evaluate: volume => {
      if (compareDecimal(volume, '2') > 0) {
        const error = new Error('insufficient margin');
        error.code = 'INSUFFICIENT_MARGIN';
        throw error;
      }
      return planFor(volume);
    },
  });
  assert.equal(result.volume, '2');
});
