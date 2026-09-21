'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ProviderHistoryCache } = require('../../src/modules/market-data/history-cache');

function bars(count, start = 0) {
  return Array.from({ length: count }, (_, index) => ({
    openTimeMs: start + index * 60_000,
    open: index,
    high: index + 1,
    low: index - 1,
    close: index + 0.5,
  }));
}

test('serves repeated history requests from TTL cache', async () => {
  let now = 1_000;
  let loads = 0;
  const cache = new ProviderHistoryCache({
    now: () => now,
    ttlByTimeframe: { '5m': 30_000 },
  });

  const load = async () => {
    loads += 1;
    return bars(160);
  };

  const first = await cache.getOrLoad({ key: 'XAU/USD:5m', timeframe: '5m', limit: 160, load });
  const second = await cache.getOrLoad({ key: 'XAU/USD:5m', timeframe: '5m', limit: 160, load });

  assert.equal(first.length, 160);
  assert.equal(second.length, 160);
  assert.equal(loads, 1);
  assert.equal(cache.stats().hits, 1);

  now += 30_001;
  await cache.getOrLoad({ key: 'XAU/USD:5m', timeframe: '5m', limit: 160, load });
  assert.equal(loads, 2);
  assert.equal(cache.stats().expirations, 1);
});

test('deduplicates concurrent provider history loads', async () => {
  let loads = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const cache = new ProviderHistoryCache();

  const load = async () => {
    loads += 1;
    await gate;
    return bars(160);
  };

  const first = cache.getOrLoad({ key: 'XAU/USD:5m', timeframe: '5m', limit: 160, load });
  const second = cache.getOrLoad({ key: 'XAU/USD:5m', timeframe: '5m', limit: 160, load });
  const third = cache.getOrLoad({ key: 'XAU/USD:5m', timeframe: '5m', limit: 160, load });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loads, 1);
  assert.equal(cache.stats().inFlight, 1);

  release();
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(results.map(result => result.length), [160, 160, 160]);
  assert.equal(loads, 1);
  assert.equal(cache.stats().deduped, 2);
  assert.equal(cache.stats().inFlight, 0);
});

test('refetches when a later request needs more history than cached', async () => {
  let loads = 0;
  const cache = new ProviderHistoryCache();
  const load160 = async () => {
    loads += 1;
    return bars(160);
  };
  const load500 = async () => {
    loads += 1;
    return bars(500);
  };

  await cache.getOrLoad({ key: 'EUR/USD:1h', timeframe: '1h', limit: 160, load: load160 });
  const larger = await cache.getOrLoad({ key: 'EUR/USD:1h', timeframe: '1h', limit: 500, load: load500 });

  assert.equal(larger.length, 500);
  assert.equal(loads, 2);

  const smaller = await cache.getOrLoad({
    key: 'EUR/USD:1h',
    timeframe: '1h',
    limit: 100,
    load: async () => { throw new Error('should be cached'); },
  });
  assert.equal(smaller.length, 100);
  assert.equal(loads, 2);
});

test('keeps the cache bounded by both entry count and bar count', async () => {
  const cache = new ProviderHistoryCache({ maxEntries: 2, maxBars: 250 });

  await cache.getOrLoad({ key: 'A:5m', timeframe: '5m', limit: 100, load: async () => bars(100) });
  await cache.getOrLoad({ key: 'B:5m', timeframe: '5m', limit: 100, load: async () => bars(100, 10_000_000) });
  await cache.getOrLoad({ key: 'C:5m', timeframe: '5m', limit: 100, load: async () => bars(100, 20_000_000) });

  const stats = cache.stats();
  assert.equal(stats.entries, 2);
  assert.equal(stats.bars, 200);
  assert.equal(stats.evictions, 1);
});

test('does not cache failed provider requests', async () => {
  let attempts = 0;
  const cache = new ProviderHistoryCache();

  await assert.rejects(
    cache.getOrLoad({
      key: 'XAU/USD:1d',
      timeframe: '1d',
      limit: 160,
      load: async () => {
        attempts += 1;
        throw new Error('provider failure');
      },
    }),
    /provider failure/,
  );

  const recovered = await cache.getOrLoad({
    key: 'XAU/USD:1d',
    timeframe: '1d',
    limit: 160,
    load: async () => {
      attempts += 1;
      return bars(160);
    },
  });

  assert.equal(recovered.length, 160);
  assert.equal(attempts, 2);
  assert.equal(cache.stats().entries, 1);
});
