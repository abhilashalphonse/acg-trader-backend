'use strict';

// Read-only comparison. Run against a backend containing the reconciler change.
require('dotenv').config();
const { TwelveDataAdapter } = require('../src/modules/market-data/adapters/twelve-data.adapter');

async function main() {
  const symbol = String(process.argv[2] || 'GBPUSD').replace('/', '').toUpperCase();
  if (!/^[A-Z]{6}$/.test(symbol)) throw new Error('Use a six-letter forex symbol, e.g. GBPUSD');
  if (!process.env.TWELVE_DATA_API_KEY) throw new Error('TWELVE_DATA_API_KEY is required');
  const base = process.env.ACG_TRADER_API_BASE || 'http://127.0.0.1:4000';
  const url = new URL('/v1/market/candles', base);
  url.search = new URLSearchParams({ symbol, timeframe: '5m', limit: '12' }).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`ACG history returned HTTP ${response.status}`);
  const acg = await response.json();
  const adapter = new TwelveDataAdapter({ apiKey: process.env.TWELVE_DATA_API_KEY,
    apiBase: process.env.TWELVE_DATA_API_BASE || 'https://api.twelvedata.com', httpTimeoutMs: 15_000 });
  const provider = await adapter.fetchHistorical({ providerSymbol: `${symbol.slice(0, 3)}/${symbol.slice(3)}`,
    timeframe: '5m', limit: 12 });
  const byTime = new Map(provider.map(bar => [Number(bar.openTimeMs), bar]));
  const cutoff = Date.now() - 90_000;
  const fields = ['open', 'high', 'low', 'close'];
  const eligible = (acg.candles || []).filter(bar => bar.complete && Number(bar.openTimeMs) + 300_000 <= cutoff).slice(-6);
  if (!eligible.length) throw new Error('No sufficiently old completed ACG M5 candles to compare');
  const result = eligible.map(bar => {
    const expected = byTime.get(Number(bar.openTimeMs));
    const differences = expected ? fields.filter(field => Number(bar[field]) !== Number(expected[field])) : ['missing provider candle'];
    return { time: new Date(Number(bar.openTimeMs)).toISOString(), matches: differences.length === 0,
      differences, acg: Object.fromEntries(fields.map(field => [field, Number(bar[field])])),
      provider: expected ? Object.fromEntries(fields.map(field => [field, Number(expected[field])])) : null };
  });
  console.log(JSON.stringify({ symbol, timeframe: '5m', compared: result.length,
    mismatches: result.filter(row => !row.matches).length, result }, null, 2));
  if (result.some(row => !row.matches)) process.exitCode = 1;
}

main().catch(error => { console.error(`Candle parity check failed: ${error.message}`); process.exitCode = 1; });
