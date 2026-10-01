'use strict';

require('dotenv').config();

const { AccelpixAdapter } = require('../src/modules/market-data/adapters/accelpix.adapter');

const apiKey = process.env.ACCELPIX_API_KEY;
const host = process.env.ACCELPIX_HOST || 'apidata.accelpix.in';
const symbols = (process.env.ACCELPIX_DIAGNOSTIC_SYMBOLS || 'RELIANCE,TCS,HDFCBANK,INFY,SBIN')
  .split(',').map(s => s.trim()).filter(Boolean);
const durationMs = Number(process.env.ACCELPIX_DIAGNOSTIC_MS || 60000);

if (!apiKey) throw new Error('ACCELPIX_API_KEY is missing');

const stats = new Map(symbols.map(symbol => [symbol, {
  trade: 0,
  snapshot: 0,
  best: 0,
  priceChanges: 0,
  lastPrice: null,
  firstArrival: null,
  lastArrival: null,
  firstProvider: null,
  lastProvider: null,
}]));

const adapter = new AccelpixAdapter({
  apiKey,
  host,
  maxSymbols: 100,
});

adapter.on('connection', event => console.log('CONNECTION', event.state, event.reason || ''));
adapter.on('adapter-error', error => console.error('ADAPTER ERROR', error?.message || error));
adapter.on('subscription-status', event => console.log('SUBSCRIPTION', event.status, event.success || []));

adapter.on('price', quote => {
  const s = stats.get(quote.symbol);
  if (!s) return;

  const now = Date.now();
  s.firstArrival ??= now;
  s.lastArrival = now;

  if (quote.quoteOnly) s.best += 1;
  else if (quote.raw?.snapshot) s.snapshot += 1;
  else s.trade += 1;

  if (Number.isFinite(Number(quote.providerTimestampMs))) {
    const ts = Number(quote.providerTimestampMs);
    s.firstProvider ??= ts;
    s.lastProvider = ts;
  }

  if (Number.isFinite(Number(quote.price))) {
    if (s.lastPrice == null || s.lastPrice !== quote.price) s.priceChanges += 1;
    s.lastPrice = quote.price;
  }

  const total = s.trade + s.snapshot + s.best;
  if (total <= 6) {
    console.log(quote.quoteOnly ? 'BEST' : quote.raw?.snapshot ? 'SNAPSHOT' : 'TRADE', quote.symbol, {
      price: quote.price,
      bid: quote.bid,
      ask: quote.ask,
      volume: quote.dayVolume,
      providerUtc: quote.providerTimestampMs ? new Date(quote.providerTimestampMs).toISOString() : null,
      arrivalUtc: new Date(now).toISOString(),
    });
  }
});

async function finish() {
  await adapter.stop().catch(() => undefined);

  console.log('\n========== LIVE RESULT ==========');
  for (const symbol of symbols) {
    const s = stats.get(symbol);
    const seconds = s.firstArrival && s.lastArrival
      ? Math.max(0.001, (s.lastArrival - s.firstArrival) / 1000)
      : durationMs / 1000;
    const liveEvents = s.trade + s.best;

    console.log('\n' + symbol);
    console.table({
      trade: s.trade,
      tradeSnapshot: s.snapshot,
      best: s.best,
      liveEvents,
      eventsPerSecond: Number((liveEvents / seconds).toFixed(2)),
      priceChanges: s.priceChanges,
    });
    console.log('Provider UTC:', s.firstProvider ? new Date(s.firstProvider).toISOString() : null,
      '->', s.lastProvider ? new Date(s.lastProvider).toISOString() : null);
  }

  console.log('\n========== CHECKS ==========');
  for (const symbol of symbols) {
    const s = stats.get(symbol);
    console.log(symbol,
      'trade=' + ((s.trade + s.snapshot) > 0 ? 'PASS' : 'FAIL'),
      'bid/ask=' + (s.best > 0 ? 'PASS' : 'FAIL'));
  }
}

(async () => {
  console.log('Testing direct SignalR:', symbols.join(', '));
  console.log('Duration:', Math.round(durationMs / 1000), 'seconds');

  await adapter.start(symbols.map(symbol => ({
    symbol,
    provider: 'accelpix',
    providerSymbol: symbol,
  })));

  await new Promise(resolve => setTimeout(resolve, durationMs));
  await finish();
})().catch(error => {
  console.error('FAIL:', error?.message || error);
  process.exitCode = 1;
});
