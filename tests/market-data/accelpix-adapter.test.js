'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AccelpixAdapter,
  normalizeAccelpixLiveTimestampMs,
  parseAccelpixIntradayTimeMs,
  parseAccelpixEodTimeMs,
} = require('../../src/modules/market-data/adapters/accelpix.adapter');

function fakeClient() {
  const handlers = {};
  return {
    handlers,
    callbacks: {
      onConnected(fn) { handlers.connected = fn; },
      onClosed(fn) { handlers.closed = fn; },
      onTrade(fn) { handlers.trade = fn; },
      onTradeSnapshot(fn) { handlers.tradeSnapshot = fn; },
      onBest(fn) { handlers.best = fn; },
    },
    stream: {
      subscribed: null,
      unsubscribed: null,
      async subscribeAll(symbols) {
        this.subscribed = [...symbols];
        return null;
      },
      async unsubscribeAll(symbols) {
        this.unsubscribed = [...symbols];
        return null;
      },
    },
    async initialize() {
      handlers.connected?.();
    },
  };
}

test('normalizes Accelpix IST wall-clock live time to UTC', () => {
  const arrival = Date.parse('2026-10-01T06:33:20.575Z');
  const provider = new Date('2026-10-01T12:03:20.000Z');
  assert.equal(
    normalizeAccelpixLiveTimestampMs(provider, arrival),
    Date.parse('2026-10-01T06:33:20.000Z'),
  );
});

test('rejects Accelpix sentinel/bogus best-packet timestamps', () => {
  const arrival = Date.parse('2026-10-01T06:33:20.575Z');
  assert.equal(
    normalizeAccelpixLiveTimestampMs(new Date('1980-01-01T00:00:00.000Z'), arrival),
    null,
  );
});

test('parses Accelpix intraday timestamps as Asia/Kolkata wall clock', () => {
  assert.equal(
    parseAccelpixIntradayTimeMs('2026-10-01 09:15:00'),
    Date.parse('2026-10-01T03:45:00.000Z'),
  );
});

test('preserves EOD trading date at canonical UTC midnight', () => {
  assert.equal(
    parseAccelpixEodTimeMs('2026-10-01 00:00:00'),
    Date.parse('2026-10-01T00:00:00.000Z'),
  );
});

test('merges trade LTP with later best bid/ask updates', async () => {
  const client = fakeClient();
  const adapter = new AccelpixAdapter({
    apiKey: 'test',
    host: 'apidata.accelpix.in',
    clientFactory: () => client,
    reconnectMinMs: 1,
    reconnectMaxMs: 1,
  });

  const prices = [];
  adapter.on('price', quote => prices.push(quote));

  await adapter.start([
    { symbol: 'RELIANCE', providerSymbol: 'RELIANCE' },
  ]);

  assert.deepEqual(client.stream.subscribed, ['RELIANCE']);

  client.handlers.tradeSnapshot({
    ticker: 'RELIANCE',
    price: 1174.9,
    volume: 6963315,
    time: new Date('2026-10-01T12:03:19.000Z'),
  });

  client.handlers.best({
    ticker: 'RELIANCE',
    bidPrice: 1174.9,
    askPrice: 1175,
    bidQty: 832,
    askQty: 611,
    time: new Date('1980-01-01T00:00:00.000Z'),
  });

  assert.equal(prices.length, 2);
  assert.equal(prices[0].price, 1174.9);
  assert.equal(prices[0].dayVolume, 6963315);
  assert.equal(prices[1].price, 1174.9);
  assert.equal(prices[1].bid, 1174.9);
  assert.equal(prices[1].ask, 1175);
  assert.equal(prices[1].providerTimestampMs, null);

  await adapter.stop();
});

test('enforces the 100-symbol Accelpix subscription entitlement', async () => {
  const client = fakeClient();
  const adapter = new AccelpixAdapter({
    apiKey: 'test',
    clientFactory: () => client,
    maxSymbols: 100,
  });
  adapter.on('adapter-error', () => {});

  const subscriptions = Array.from({ length: 101 }, (_, index) => ({
    symbol: `EQ${index}`,
    providerSymbol: `EQ${index}`,
  }));

  await assert.rejects(
    adapter.start(subscriptions),
    error => error?.code === 'ACCELPIX_SYMBOL_LIMIT_EXCEEDED',
  );
});

test('fetchLatestPrice uses Accelpix quote endpoint and normalizes quote fields', async () => {
  let request = null;
  const fetchImpl = async (url, options) => {
    request = { url: String(url), options };
    return {
      ok: true,
      status: 200,
      async json() {
        return [{
          tkr: 'RELIANCE',
          pr: 1175,
          bp: 1174.9,
          ap: 1175,
          vol: 7000000,
        }];
      },
    };
  };

  const adapter = new AccelpixAdapter({
    apiKey: 'secret',
    fetchImpl,
    clientFactory: () => fakeClient(),
  });

  const quote = await adapter.fetchLatestPrice({ providerSymbol: 'RELIANCE' });
  assert.match(request.url, /\/api\/fda\/rest\/quote\?/);
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.body, JSON.stringify(['RELIANCE']));
  assert.equal(quote.price, 1175);
  assert.equal(quote.bid, 1174.9);
  assert.equal(quote.ask, 1175);
  assert.equal(quote.dayVolume, 7000000);
  assert.equal(quote.source, 'accelpix-rest');
});

test('fetchHistorical converts 1-minute IST bars to UTC', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return [{
        tkr: 'RELIANCE',
        td: '2026-10-01 09:15:00',
        op: 1170,
        hp: 1172,
        lp: 1169.5,
        cp: 1171.5,
        vol: 10000,
      }];
    },
  });

  const adapter = new AccelpixAdapter({
    apiKey: 'secret',
    fetchImpl,
    clientFactory: () => fakeClient(),
  });

  const bars = await adapter.fetchHistorical({
    providerSymbol: 'RELIANCE',
    timeframe: '1m',
    limit: 10,
  });

  assert.equal(bars.length, 1);
  assert.equal(bars[0].openTimeMs, Date.parse('2026-10-01T03:45:00.000Z'));
  assert.equal(bars[0].providerVolume, 10000);
});
