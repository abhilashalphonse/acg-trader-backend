'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeTradePacket,
  decodeBestPacket,
  decodeRefsPacket,
  rawProviderDate,
} = require('../../src/modules/market-data/adapters/accelpix-signalr.client');

test('decodes Accelpix trade packet wire format', () => {
  const seconds = (Date.parse('2026-10-01T12:03:20.000Z') - Date.UTC(1980, 0, 1)) / 1000;
  const trade = decodeTradePacket([
    7,
    'RELIANCE',
    1,
    seconds,
    1174.9000244140625,
    23,
    6963338,
    0,
    'T'.charCodeAt(0),
  ]);

  assert.equal(trade.id, 7);
  assert.equal(trade.ticker, 'RELIANCE');
  assert.equal(trade.segmentId, 1);
  assert.equal(trade.time.toISOString(), '2026-10-01T12:03:20.000Z');
  assert.equal(trade.price, 1174.9000244140625);
  assert.equal(trade.qty, 23);
  assert.equal(trade.volume, 6963338);
  assert.equal(trade.kind, 'T');
  assert.equal(trade.snapshot, false);
});

test('marks _t trade packets as snapshots', () => {
  const trade = decodeTradePacket([
    0, 'TCS', 1, 0, 3000, 1, 100, 0, 'T'.charCodeAt(0),
  ], { snapshot: true });
  assert.equal(trade.snapshot, true);
});

test('decodes Accelpix best packet and preserves zero timestamp sentinel', () => {
  const best = decodeBestPacket([
    'RELIANCE',
    1,
    'B'.charCodeAt(0),
    1174.9,
    832,
    1175,
    611,
    0,
  ]);

  assert.equal(best.ticker, 'RELIANCE');
  assert.equal(best.segmentId, 1);
  assert.equal(best.kind, 'B');
  assert.equal(best.bidPrice, 1174.9);
  assert.equal(best.bidQty, 832);
  assert.equal(best.askPrice, 1175);
  assert.equal(best.askQty, 611);
  assert.equal(best.time.toISOString(), '1980-01-01T00:00:00.000Z');
});

test('decodes Accelpix reference packet shapes', () => {
  const live = decodeRefsPacket(['A'.charCodeAt(0), 'RELIANCE', 1, 1179.52]);
  assert.deepEqual(live, {
    kind: 'A',
    ticker: 'RELIANCE',
    segmentId: 1,
    price: 1179.52,
    snapshot: false,
  });

  const snapshot = decodeRefsPacket([
    'V'.charCodeAt(0),
    'RELIANCE',
    1,
    1182,
    1182,
    1196.5,
    1181.7,
    1189.53,
    0,
    1300.2,
    1063.8,
    0,
  ], { snapshot: true });

  assert.equal(snapshot.kind, 'V');
  assert.equal(snapshot.open, 1182);
  assert.equal(snapshot.high, 1196.5);
  assert.equal(snapshot.lowerBand, 1063.8);
  assert.equal(snapshot.snapshot, true);
});

test('raw provider date uses the Accelpix 1980 epoch representation', () => {
  assert.equal(rawProviderDate(0).toISOString(), '1980-01-01T00:00:00.000Z');
  assert.equal(rawProviderDate('bad'), null);
});
