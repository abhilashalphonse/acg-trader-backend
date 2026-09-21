'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TwelveDataAdapter } = require('../../src/modules/market-data/adapters/twelve-data.adapter');

function createAdapter() {
  return new TwelveDataAdapter({
    apiKey: 'test-key',
    wsUrl: 'wss://example.test/ws',
    apiBase: 'https://example.test',
    heartbeatMs: 10000,
    reconnectMinMs: 1000,
    reconnectMaxMs: 10000,
    httpTimeoutMs: 5000,
    logger: { warn() {}, info() {}, debug() {} },
  });
}

function response(values) {
  return {
    ok: true,
    status: 200,
    async json() { return { values }; },
  };
}

test('historical cursor is exclusive and forwarded as Twelve Data end_date', async () => {
  const originalFetch = global.fetch;
  const urls = [];
  global.fetch = async url => {
    urls.push(String(url));
    return response([
      { datetime: '2026-09-21 20:00:00', open: '4300', high: '4301', low: '4299', close: '4300.5', volume: '10' },
      { datetime: '2026-09-21 20:05:00', open: '4300.5', high: '4302', low: '4300', close: '4301', volume: '12' },
    ]);
  };

  try {
    const beforeMs = Date.UTC(2026, 8, 21, 20, 10, 0);
    const bars = await createAdapter().fetchHistorical({
      providerSymbol: 'XAU/USD',
      timeframe: '5m',
      limit: 2,
      beforeMs,
    });

    assert.equal(bars.length, 2);
    const url = new URL(urls[0]);
    assert.equal(url.searchParams.get('interval'), '5min');
    assert.equal(url.searchParams.get('outputsize'), '2');
    assert.equal(url.searchParams.get('end_date'), '2026-09-21T20:09:59');
  } finally {
    global.fetch = originalFetch;
  }
});

test('canonical D1 pagination remains based on UTC 4h source bars before the cursor', async () => {
  const originalFetch = global.fetch;
  const urls = [];
  global.fetch = async url => {
    urls.push(String(url));
    return response([
      { datetime: '2026-09-20 20:00:00', open: '4300', high: '4302', low: '4299', close: '4301', volume: '10' },
      { datetime: '2026-09-21 00:00:00', open: '4301', high: '4303', low: '4300', close: '4302', volume: '11' },
    ]);
  };

  try {
    const beforeMs = Date.UTC(2026, 8, 21, 0, 0, 0);
    const bars = await createAdapter().fetchHistorical({
      providerSymbol: 'XAU/USD',
      timeframe: '1d',
      limit: 2,
      beforeMs,
    });

    assert.ok(Array.isArray(bars));
    const url = new URL(urls[0]);
    assert.equal(url.searchParams.get('interval'), '4h');
    assert.equal(url.searchParams.get('end_date'), '2026-09-20T23:59:59');
  } finally {
    global.fetch = originalFetch;
  }
});
