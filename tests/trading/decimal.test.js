'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  ROUNDING,
  normalizeDecimal,
  addDecimal,
  subtractDecimal,
  multiplyDecimal,
  divideDecimal,
  compareDecimal,
  isStepAligned,
  quantizeToStep,
  toDecimal128,
  fromDecimal128,
} = require('../../src/shared/decimal/decimal');

test('normalizes decimal strings without floating-point drift', () => {
  assert.equal(normalizeDecimal('001.23000'), '1.23');
  assert.equal(normalizeDecimal('1e-7'), '0.0000001');
  assert.equal(addDecimal('0.1', '0.2'), '0.3');
  assert.equal(subtractDecimal('1.00001', '0.00001'), '1');
  assert.equal(multiplyDecimal('100000', '0.01'), '1000');
});

test('divides and rounds deterministically', () => {
  assert.equal(divideDecimal('1', '3', { scale: 6 }), '0.333333');
  assert.equal(divideDecimal('2', '3', { scale: 2, rounding: ROUNDING.HALF_UP }), '0.67');
  assert.equal(divideDecimal('-1', '3', { scale: 0, rounding: ROUNDING.FLOOR }), '-1');
  assert.equal(divideDecimal('-1', '3', { scale: 0, rounding: ROUNDING.CEIL }), '0');
});

test('validates and quantizes instrument volume steps exactly', () => {
  assert.equal(isStepAligned('0.37', '0.01'), true);
  assert.equal(isStepAligned('0.375', '0.01'), false);
  assert.equal(quantizeToStep('0.375', '0.01', ROUNDING.DOWN), '0.37');
  assert.equal(quantizeToStep('0.375', '0.01', ROUNDING.HALF_UP), '0.38');
  assert.equal(compareDecimal('1.000', '1'), 0);
});

test('round-trips Mongo Decimal128 using canonical decimal strings', () => {
  const value = toDecimal128('4294.6102600');
  assert.equal(fromDecimal128(value), '4294.61026');
});
