'use strict';
// A read-only provider-path smoke check against the configured staging gateway.
// This is NOT execution acceptance of PR #72, which must run on the PR code.
const { setTimeout: sleep } = require('node:timers/promises');
const assert = require('node:assert/strict');

const origin = process.env.ACG_LIVE_FEED_BASE_URL;
if (!origin || !/^https:\/\//i.test(origin)) {
  console.error('LIVE_FEED_FAIL: Set an explicit HTTPS staging URL.');
  process.exit(2);
}
const symbols = ['BTCUSD', 'EURUSD'];
const quoteAgeLimitMs = 90000;
const request = async path => {
  const response = await fetch(new URL(path, origin), { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' for ' + path);
  return response.json();
};
async function sample() {
  const result = await request('/v1/market/quotes?symbols=' + symbols.join('%2C'));
  if (!Array.isArray(result.quotes)) throw new Error('No quotes array in gateway response');
  const bySymbol = new Map(result.quotes.map(q => [q.symbol, q]));
  const now = Date.now();
  return symbols.map(symbol => {
    const q = bySymbol.get(symbol);
    if (!q) throw new Error('Missing ' + symbol + ' provider quote');
    const bid = Number(q.bid), ask = Number(q.ask), receivedAt = Number(q.receivedAtMs);
    assert(Number.isFinite(bid) && bid > 0, symbol + ' has invalid bid');
    assert(Number.isFinite(ask) && ask >= bid, symbol + ' has invalid ask or inverted spread');
    assert(Number.isFinite(receivedAt) && receivedAt > 0, symbol + ' missing receive timestamp');
    const ageMs = now - receivedAt;
    assert(ageMs >= -10000 && ageMs <= quoteAgeLimitMs, symbol + ' quote age exceeds 90 seconds');
    assert(q.isStale !== true, symbol + ' explicitly stale');
    assert(q.source && !/fixture|synthetic|mock|controlled/i.test(String(q.source)), symbol + ' not traceable to live provider');
    return { symbol, source: String(q.source), receivedAt, ageMs, sequence: q.sequence ?? null };
  });
}
(async () => {
  const status = await request('/v1/market/status');
  assert(status.enabled === true, 'Staging market gateway is disabled');
  const first = await sample();
  await sleep(6500);
  const second = await sample();
  // A live market can legitimately have no new tick during a short window;
  // two independently fresh snapshots prove current gateway availability,
  // not continuous streaming or PR #72's execution integration.
  for (const a of second) {
    const prev = first.find(x => x.symbol === a.symbol);
    assert(a.receivedAt >= prev.receivedAt, a.symbol + ' timestamp regressed');
  }
  console.log('LIVE_FEED_PROVIDER_PATH_PASS', JSON.stringify({
    symbols, samples: 2, gatewayEnabled: true,
    maxQuoteAgeMs: quoteAgeLimitMs, providers: [...new Set(second.map(q=>q.source))],
    latestQuoteAgeMs: Object.fromEntries(second.map(q=>[q.symbol,q.ageMs])),
    scope: 'read-only staging gateway; not PR72 execution acceptance',
  }));
})().catch(err => {
  console.error('LIVE_FEED_PROVIDER_PATH_FAIL', err.message);
  process.exitCode = 1;
});
