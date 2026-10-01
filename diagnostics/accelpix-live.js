'use strict';

require('dotenv').config();

const apidata = require('pix-apidata');

const API_KEY = process.env.ACCELPIX_API_KEY;
const HOST = process.env.ACCELPIX_HOST || 'apidata.accelpix.in';
const SYMBOLS = (process.env.ACCELPIX_DIAGNOSTIC_SYMBOLS || 'RELIANCE,TCS,HDFCBANK,INFY,SBIN')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const DURATION_MS = Number(process.env.ACCELPIX_DIAGNOSTIC_MS || 60000);

if (!API_KEY) {
  console.error('Missing ACCELPIX_API_KEY.');
  process.exit(1);
}

const stats = new Map(SYMBOLS.map((symbol) => [symbol, {
  trade: 0,
  tradeSnapshot: 0,
  best: 0,
  refs: 0,
  refsSnapshot: 0,
  firstArrivalMs: null,
  lastArrivalMs: null,
  firstProviderTime: null,
  lastProviderTime: null,
  lastPrice: null,
  priceChanges: 0,
  duplicates: 0,
  bad1980Times: 0,
}]));

let connected = 0;
let closed = 0;
let finished = false;

function resolveTicker(msg) {
  return msg?.ticker || msg?.tkr || null;
}

function resolveProviderTime(msg) {
  const value = msg?.time ?? msg?.tm ?? msg?.td ?? null;
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const d = new Date(value);
  if (Number.isFinite(d.getTime())) return d.toISOString();
  return String(value);
}

function record(kind, msg) {
  const ticker = resolveTicker(msg);
  const s = stats.get(ticker);
  if (!s) return;

  const now = Date.now();
  if (s.firstArrivalMs == null) s.firstArrivalMs = now;
  s.lastArrivalMs = now;
  s[kind] += 1;

  const providerTime = resolveProviderTime(msg);
  if (providerTime) {
    if (s.firstProviderTime == null) s.firstProviderTime = providerTime;
    s.lastProviderTime = providerTime;
    if (String(providerTime).startsWith('1980-01-01')) s.bad1980Times += 1;
  }

  const price = Number(msg?.price ?? msg?.pr);
  if (Number.isFinite(price)) {
    if (s.lastPrice == null || price !== s.lastPrice) s.priceChanges += 1;
    else s.duplicates += 1;
    s.lastPrice = price;
  }

  const total = s.trade + s.tradeSnapshot + s.best + s.refs + s.refsSnapshot;
  if (total <= 8) {
    console.log(kind.toUpperCase(), ticker, {
      price: msg?.price ?? msg?.pr,
      bidPrice: msg?.bidPrice ?? msg?.bp,
      askPrice: msg?.askPrice ?? msg?.ap,
      bidQty: msg?.bidQty ?? msg?.bq,
      askQty: msg?.askQty ?? msg?.aq,
      volume: msg?.volume ?? msg?.vol,
      qty: msg?.qty,
      providerTime,
      localArrival: new Date(now).toISOString(),
    });
  }
}

apidata.callbacks.onConnected(() => {
  connected += 1;
  console.log('CONNECTED');
});

apidata.callbacks.onClosed((err) => {
  closed += 1;
  console.log('CLOSED', err?.message || err || '');
});

apidata.callbacks.onTrade((msg) => record('trade', msg));
apidata.callbacks.onTradeSnapshot((msg) => record('tradeSnapshot', msg));
apidata.callbacks.onBest((msg) => record('best', msg));
apidata.callbacks.onRefs((msg) => record('refs', msg));
apidata.callbacks.onRefsSnapshot((msg) => record('refsSnapshot', msg));

async function finish() {
  if (finished) return;
  finished = true;

  try {
    await apidata.stream.unsubscribeAll(SYMBOLS);
  } catch {
    // Best-effort cleanup.
  }

  console.log('\n================ LIVE RESULT ================');
  console.log('Connected callbacks:', connected);
  console.log('Closed callbacks:', closed);

  for (const symbol of SYMBOLS) {
    const s = stats.get(symbol);
    const liveEvents = s.trade + s.best + s.refs;
    const durationSec = s.firstArrivalMs && s.lastArrivalMs
      ? Math.max(0.001, (s.lastArrivalMs - s.firstArrivalMs) / 1000)
      : DURATION_MS / 1000;

    console.log(`\n${symbol}`);
    console.table({
      trade: s.trade,
      tradeSnapshot: s.tradeSnapshot,
      best: s.best,
      refs: s.refs,
      refsSnapshot: s.refsSnapshot,
      liveEvents,
      eventsPerSecond: Number((liveEvents / durationSec).toFixed(2)),
      priceChanges: s.priceChanges,
      duplicates: s.duplicates,
      bad1980Times: s.bad1980Times,
    });
    console.log('Provider time:', s.firstProviderTime, '->', s.lastProviderTime);
    console.log('Local arrival:', s.firstArrivalMs ? new Date(s.firstArrivalMs).toISOString() : null,
      '->', s.lastArrivalMs ? new Date(s.lastArrivalMs).toISOString() : null);
  }

  console.log('\nChecks:');
  for (const symbol of SYMBOLS) {
    const s = stats.get(symbol);
    const live = s && (s.trade + s.best + s.refs) > 0;
    console.log(`${symbol} realtime packets:`, live ? 'PASS' : 'FAIL');
  }
  console.log('=============================================\n');

  process.exit(0);
}

(async () => {
  console.log('============================================================');
  console.log(' ACG Trader - Accelpix Market-Open Diagnostic');
  console.log('============================================================');
  console.log('Symbols:', SYMBOLS.join(', '));
  console.log('Duration:', Math.round(DURATION_MS / 1000), 'seconds');
  console.log('API key: configured (value hidden)');
  console.log('============================================================');

  await apidata.initialize(API_KEY, HOST, 'https');
  console.log('INITIALIZED');

  await apidata.stream.subscribeAll(SYMBOLS);
  console.log('SUBSCRIBED');

  setTimeout(() => {
    finish().catch((error) => {
      console.error('Finish failed:', error?.message || error);
      process.exit(1);
    });
  }, DURATION_MS);
})().catch((error) => {
  console.error('Accelpix live diagnostic failed:', error?.message || error);
  process.exit(1);
});

process.on('SIGINT', () => finish());
process.on('SIGTERM', () => finish());
