'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TickSanityFilter } = require('../../src/modules/market-data/tick-sanity-filter');

const metal = {
  assetClass: 'METAL',
  tickSize: 0.01,
};

function raw(price, providerTimestampMs, source = 'twelve-data') {
  return {
    symbol: 'XAUUSD',
    price,
    providerTimestampMs,
    source,
  };
}

test('passes normal market ticks immediately', () => {
  const filter = new TickSanityFilter();
  const first = filter.inspect({
    symbol: 'XAUUSD',
    raw: raw(4345, 1000),
    instrument: metal,
    receivedAtMs: 1000,
  });
  const second = filter.inspect({
    symbol: 'XAUUSD',
    raw: raw(4345.2, 1100),
    instrument: metal,
    receivedAtMs: 1100,
  });

  assert.equal(first.accepted.length, 1);
  assert.equal(second.accepted.length, 1);
  assert.equal(second.reason, 'NORMAL');
  assert.equal(filter.snapshot('XAUUSD').pending, false);
});

test('quarantines and rejects an isolated one-tick spike', () => {
  const filter = new TickSanityFilter();
  filter.inspect({
    symbol: 'XAUUSD',
    raw: raw(4345, 1000),
    instrument: metal,
    receivedAtMs: 1000,
  });

  const spike = filter.inspect({
    symbol: 'XAUUSD',
    raw: raw(4355, 1100),
    instrument: metal,
    receivedAtMs: 1100,
  });
  assert.equal(spike.accepted.length, 0);
  assert.equal(spike.reason, 'QUARANTINED');
  assert.equal(filter.snapshot('XAUUSD').pending, true);

  const recovery = filter.inspect({
    symbol: 'XAUUSD',
    raw: raw(4345.3, 1200),
    instrument: metal,
    receivedAtMs: 1200,
  });
  assert.equal(recovery.accepted.length, 1);
  assert.equal(recovery.accepted[0].raw.price, 4345.3);
  assert.equal(recovery.reason, 'REJECTED_ISOLATED_SPIKE');

  const snapshot = filter.snapshot('XAUUSD');
  assert.equal(snapshot.pending, false);
  assert.equal(snapshot.quarantined, 1);
  assert.equal(snapshot.rejected, 1);
  assert.equal(snapshot.confirmed, 0);
});

test('releases a quarantined jump when the next tick confirms the new price region', () => {
  const filter = new TickSanityFilter();
  filter.inspect({
    symbol: 'XAUUSD',
    raw: raw(4345, 1000),
    instrument: metal,
    receivedAtMs: 1000,
  });

  const jump = filter.inspect({
    symbol: 'XAUUSD',
    raw: raw(4350, 1100),
    instrument: metal,
    receivedAtMs: 1100,
  });
  assert.equal(jump.accepted.length, 0);

  const confirmation = filter.inspect({
    symbol: 'XAUUSD',
    raw: raw(4351, 1200),
    instrument: metal,
    receivedAtMs: 1200,
  });
  assert.equal(confirmation.reason, 'CONFIRMED_JUMP');
  assert.deepEqual(confirmation.accepted.map(item => item.raw.price), [4350, 4351]);
  assert.equal(filter.snapshot('XAUUSD').confirmed, 1);
});

test('rejects materially out-of-order provider ticks', () => {
  const filter = new TickSanityFilter();
  filter.inspect({
    symbol: 'XAUUSD',
    raw: raw(4345, 10_000),
    instrument: metal,
    receivedAtMs: 10_000,
  });

  const late = filter.inspect({
    symbol: 'XAUUSD',
    raw: raw(4344.5, 8_000),
    instrument: metal,
    receivedAtMs: 10_100,
  });

  assert.equal(late.accepted.length, 0);
  assert.equal(late.reason, 'OUT_OF_ORDER');
  assert.equal(filter.snapshot('XAUUSD').rejected, 1);
});

test('trusted REST recovery can move price immediately without waiting for stream confirmation', () => {
  const filter = new TickSanityFilter();
  filter.inspect({
    symbol: 'XAUUSD',
    raw: raw(4345, 1000),
    instrument: metal,
    receivedAtMs: 1000,
  });

  const recovery = filter.inspect({
    symbol: 'XAUUSD',
    raw: raw(4360, null, 'twelve-data-rest'),
    instrument: metal,
    receivedAtMs: 2000,
  });

  assert.equal(recovery.accepted.length, 1);
  assert.equal(recovery.accepted[0].raw.price, 4360);
  assert.equal(recovery.reason, 'TRUSTED_RECOVERY');
});
