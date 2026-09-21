'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseVolumeMode } = require('../../src/modules/market-data/history.service');

function bar(providerVolume, tickCount = 0, overrides = {}) {
  return {
    providerVolume,
    tickCount,
    complete: true,
    synthetic: false,
    ...overrides,
  };
}

test('keeps provider mode when recent provider volume is continuous', () => {
  const bars = Array.from({ length: 48 }, (_, index) => bar(100 + index));
  assert.equal(chooseVolumeMode(bars), 'provider');
});

test('rejects provider mode when old volume is healthy but the recent tail is zero', () => {
  const bars = [
    ...Array.from({ length: 80 }, (_, index) => bar(100 + index)),
    ...Array.from({ length: 60 }, () => bar(0)),
  ];

  assert.equal(chooseVolumeMode(bars), 'unavailable');
});

test('falls back to locally collected tick volume when recent provider volume is broken', () => {
  const bars = [
    ...Array.from({ length: 80 }, (_, index) => bar(100 + index)),
    ...Array.from({ length: 60 }, (_, index) => bar(0, index + 1)),
  ];

  assert.equal(chooseVolumeMode(bars), 'tick');
});

test('allows a short current provider-volume gap without switching the series mode', () => {
  const bars = [
    ...Array.from({ length: 22 }, (_, index) => bar(100 + index)),
    bar(0),
    bar(null),
  ];

  assert.equal(chooseVolumeMode(bars), 'provider');
});

test('ignores an incomplete current bar when assessing provider-volume continuity', () => {
  const bars = [
    ...Array.from({ length: 24 }, (_, index) => bar(100 + index)),
    bar(0, 0, { complete: false }),
  ];

  assert.equal(chooseVolumeMode(bars), 'provider');
});


test('does not select stale tick history followed by a long recent gap', () => {
  const bars = [
    ...Array.from({ length: 40 }, (_, index) => bar(0, 20 + index)),
    ...Array.from({ length: 40 }, () => bar(0, 0)),
  ];

  assert.equal(chooseVolumeMode(bars), 'unavailable');
});

test('tick volume recovers after three contiguous recent completed bars', () => {
  const bars = [
    ...Array.from({ length: 40 }, () => bar(0, 0)),
    bar(0, 12),
    bar(0, 14),
    bar(0, 11),
  ];

  assert.equal(chooseVolumeMode(bars), 'tick');
});

test('a single isolated recent tick bar after a gap is not enough to enable tick mode', () => {
  const bars = [
    ...Array.from({ length: 30 }, (_, index) => bar(0, 30 + index)),
    ...Array.from({ length: 10 }, () => bar(0, 0)),
    bar(0, 9),
  ];

  assert.equal(chooseVolumeMode(bars), 'unavailable');
});
