'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  AccelpixAdapter,
  normalizeAccelpixLiveTimestampMs,
  parseAccelpixIntradayTimeMs,
  parseAccelpixEodTimeMs,
  nseIntradayBucketOpenTimeMs,
  aggregateNseIntradayBars,
  aggregateWeeklyEodBars,
  marketPrice,
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
  assert.equal(prices[1].quoteOnly, true);

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


test('NSE M30 aggregation uses the 09:15 IST session anchor', () => {
  const bars = [
    { openTimeMs: Date.parse('2026-10-01T03:45:00.000Z'), open: 100, high: 101, low: 99, close: 100.5, providerVolume: 10 },
    { openTimeMs: Date.parse('2026-10-01T03:46:00.000Z'), open: 100.5, high: 102, low: 100, close: 101.5, providerVolume: 20 },
    { openTimeMs: Date.parse('2026-10-01T04:14:00.000Z'), open: 101.5, high: 103, low: 101, close: 102.5, providerVolume: 30 },
    { openTimeMs: Date.parse('2026-10-01T04:15:00.000Z'), open: 102.5, high: 104, low: 102, close: 103.5, providerVolume: 40 },
  ];

  assert.equal(
    nseIntradayBucketOpenTimeMs(Date.parse('2026-10-01T04:02:00.000Z'), '30m'),
    Date.parse('2026-10-01T03:45:00.000Z'),
  );

  const aggregated = aggregateNseIntradayBars(bars, '30m');
  assert.equal(aggregated.length, 2);
  assert.equal(aggregated[0].openTimeMs, Date.parse('2026-10-01T03:45:00.000Z'));
  assert.equal(aggregated[0].open, 100);
  assert.equal(aggregated[0].high, 103);
  assert.equal(aggregated[0].low, 99);
  assert.equal(aggregated[0].close, 102.5);
  assert.equal(aggregated[0].providerVolume, 60);
});

test('weekly EOD aggregation anchors to Monday', () => {
  const aggregated = aggregateWeeklyEodBars([
    { openTimeMs: Date.parse('2026-09-28T00:00:00.000Z'), open: 100, high: 103, low: 99, close: 102, providerVolume: 10 },
    { openTimeMs: Date.parse('2026-09-29T00:00:00.000Z'), open: 102, high: 105, low: 101, close: 104, providerVolume: 20 },
    { openTimeMs: Date.parse('2026-10-01T00:00:00.000Z'), open: 104, high: 106, low: 103, close: 105, providerVolume: 30 },
  ]);

  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].openTimeMs, Date.parse('2026-09-28T00:00:00.000Z'));
  assert.equal(aggregated[0].open, 100);
  assert.equal(aggregated[0].high, 106);
  assert.equal(aggregated[0].low, 99);
  assert.equal(aggregated[0].close, 105);
  assert.equal(aggregated[0].providerVolume, 60);
});


test('normalizes Accelpix float32 price artifacts', () => {
  assert.equal(marketPrice(1174.9000244140625), 1174.9);
  assert.equal(marketPrice(1186.800048828125), 1186.8);
});


test('latest intraday history overlays the current NSE session even when the long range ends yesterday', async () => {
  const requests = [];
  const fetchImpl = async url => {
    const requestUrl = String(url);
    requests.push(requestUrl);
    const path = new URL(requestUrl).pathname;
    const parts = path.split('/').filter(Boolean);
    const start = parts.at(-3);
    const end = parts.at(-2);
    const isSingleDayMinuteRequest = parts.at(-1) === '1' && start === end;

    return {
      ok: true,
      status: 200,
      async json() {
        if (isSingleDayMinuteRequest) {
          return [
            { tkr: 'RELIANCE', td: '2026-10-01 09:15:00', op: 1170, hp: 1172, lp: 1169, cp: 1171, vol: 100 },
            { tkr: 'RELIANCE', td: '2026-10-01 09:16:00', op: 1171, hp: 1173, lp: 1170, cp: 1172, vol: 120 },
          ];
        }
        return [
          { tkr: 'RELIANCE', td: '2026-09-30 15:29:00', op: 1160, hp: 1161, lp: 1159, cp: 1160.5, vol: 80 },
        ];
      },
    };
  };

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

  assert.equal(requests.length, 2);
  assert.equal(bars.at(-1).openTimeMs, Date.parse('2026-10-01T03:46:00.000Z'));
  assert.equal(bars.at(-1).close, 1172);
});

test('latest D1 history builds today from current-session minute aggregation when EOD has no current day', async () => {
  const fetchImpl = async url => {
    const path = new URL(String(url)).pathname;
    const parts = path.split('/').filter(Boolean);
    const isMinuteRequest = parts.at(-1) === '1';

    return {
      ok: true,
      status: 200,
      async json() {
        if (isMinuteRequest) {
          return [
            { tkr: 'RELIANCE', td: '2026-10-01 09:15:00', op: 1170, hp: 1172, lp: 1169, cp: 1171, vol: 100 },
            { tkr: 'RELIANCE', td: '2026-10-01 10:00:00', op: 1171, hp: 1175, lp: 1170, cp: 1174, vol: 200 },
          ];
        }
        return [
          { tkr: 'RELIANCE', td: '2026-09-30 00:00:00', op: 1160, hp: 1170, lp: 1150, cp: 1165, vol: 1000 },
        ];
      },
    };
  };

  const adapter = new AccelpixAdapter({
    apiKey: 'secret',
    fetchImpl,
    clientFactory: () => fakeClient(),
  });

  const bars = await adapter.fetchHistorical({
    providerSymbol: 'RELIANCE',
    timeframe: '1d',
    limit: 10,
  });

  const today = bars.find(bar => bar.openTimeMs === Date.parse('2026-10-01T00:00:00.000Z'));
  assert.ok(today);
  assert.equal(today.open, 1170);
  assert.equal(today.high, 1175);
  assert.equal(today.low, 1169);
  assert.equal(today.close, 1174);
  assert.equal(today.providerVolume, 300);
});


test('NSE history recovers a full October 15 session from independent native 5m bars', async () => {
  const nowMs = Date.parse('2026-10-15T08:45:00.000Z'); // 14:15 IST
  const calls = [];
  const fixture = (minute, duration, day = 15) => {
    const iso = new Date(Date.UTC(2026, 9, day, 9, 15 + minute)).toISOString().slice(0, 19);
    return { tkr: 'TCS', td: iso, op: 100 + minute / 5,
      hp: 101 + minute / 5, lp: 99 + minute / 5,
      cp: 100.5 + minute / 5, vol: duration };
  };
  const fetchImpl = async url => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean);
    const resolution = parts.at(-1);
    calls.push(resolution);
    return {
      ok: true, status: 200,
      async json() {
        if (resolution === '5') {
          return Array.from({ length: 60 }, (_, index) => fixture(index * 5, 100));
        }
        if (parts.at(-3) === parts.at(-2)) {
          // Provider responds with only the last minute, not this morning.
          return [fixture(299, 1)];
        }
        return [fixture(350, 5, 14)];
      },
    };
  };
  const adapter = new AccelpixAdapter({
    apiKey: 'secret', fetchImpl, now: () => nowMs,
    clientFactory: () => fakeClient(), logger: { warn() {} },
  });
  const bars = await adapter.fetchHistorical({
    providerSymbol: 'TCS', timeframe: '15m', limit: 160,
  });
  const start = Date.parse('2026-10-15T03:45:00.000Z');
  const today = bars.filter(bar => bar.openTimeMs >= start);
  assert.equal(calls.length, 3);
  assert.equal(calls.at(-1), '5');
  assert.equal(today.length, 20); // 09:15 through 14:15 IST
  assert.equal(today[0].openTimeMs, start);
  assert.equal(today.at(-1).openTimeMs, Date.parse('2026-10-15T08:30:00.000Z'));
  assert.ok(today.every((bar, index) => index === 0
    || bar.openTimeMs - today[index - 1].openTimeMs === 15 * 60_000));
  assert.equal(today[0].providerVolume, 300);
  assert.equal(today.at(-1).providerVolume, 300);
});

test('native 5m recovery never invents missing 1m candles', async () => {
  const calls = [];
  const fetchImpl = async url => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean);
    const resolution = parts.at(-1);
    calls.push(resolution);
    return {
      ok: true, status: 200,
      async json() {
        if (parts.at(-3) === parts.at(-2)) {
          return [{ td: '2026-10-15T14:14:00', op: 100, hp: 101, lp: 99, cp: 100.5, vol: 10 }];
        }
        return [];
      },
    };
  };
  const adapter = new AccelpixAdapter({
    apiKey: 'secret', fetchImpl, now: () => Date.parse('2026-10-15T08:45:00.000Z'),
    clientFactory: () => fakeClient(),
  });
  const bars = await adapter.fetchHistorical({
    providerSymbol: 'TCS', timeframe: '1m', limit: 160,
  });
  assert.equal(calls.length, 2);
  assert.equal(bars.length, 1);
  assert.equal(bars[0].openTimeMs, Date.parse('2026-10-15T08:44:00.000Z'));
});

test('weekly NSE current-day recovery does not double count a prior day', async () => {
  const fetchImpl = async url => {
    const parts = new URL(String(url)).pathname.split('/').filter(Boolean);
    const resolution = parts.at(-1);
    return {
      ok: true, status: 200,
      async json() {
        if (resolution === '5') {
          return Array.from({ length: 60 }, (_, index) => ({
            td: new Date(Date.UTC(2026, 9, 15, 9, 15 + index * 5)).toISOString().slice(0, 19),
            op: 120, hp: 130, lp: 110, cp: 125, vol: 10,
          }));
        }
        if (resolution === '1') return [];
        return [
          { td: '2026-10-14T00:00:00', op: 100, hp: 110, lp: 90, cp: 105, vol: 200 },
        ];
      },
    };
  };
  const adapter = new AccelpixAdapter({
    apiKey: 'secret', fetchImpl, now: () => Date.parse('2026-10-15T08:45:00.000Z'),
    clientFactory: () => fakeClient(), logger: { warn() {} },
  });
  const daily = await adapter.fetchHistorical({ providerSymbol: 'TCS', timeframe: '1d', limit: 20 });
  const weekly = await adapter.fetchHistorical({ providerSymbol: 'TCS', timeframe: '1w', limit: 20 });
  assert.equal(daily.length, 2);
  assert.equal(daily.at(-1).openTimeMs, Date.parse('2026-10-15T00:00:00.000Z'));
  assert.equal(daily.at(-1).providerVolume, 600);
  assert.equal(weekly.length, 1);
  assert.equal(weekly[0].openTimeMs, Date.parse('2026-10-12T00:00:00.000Z'));
  assert.equal(weekly[0].open, 100);
  assert.equal(weekly[0].high, 130);
  assert.equal(weekly[0].providerVolume, 800);
});

test('NSE wall-clock dates are stable across US and European DST transitions', () => {
  for (const date of ['2026-03-27', '2026-03-30', '2026-10-15', '2026-10-26']) {
    assert.equal(
      parseAccelpixIntradayTimeMs(date + ' 09:15:00'),
      Date.parse(date + 'T03:45:00.000Z'),
    );
  }
});
