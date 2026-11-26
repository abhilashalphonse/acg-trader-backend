'use strict';

// Read-only Twelve Data time-series audit for proposed commodity schedules.
// Does not load MongoDB, mutate chart state, subscribe to another WebSocket,
// change order routing or print API credentials.
// Exit 0 = no mismatch within the sampled interval; NOT a production release
// approval. Run across multiple regular/holiday/DST/overnight dates before
// accepting a schedule for any spot/aggregate symbol.

const { ACG_INSTRUMENT_CATALOG } = require('../src/modules/instruments/instrument-catalog');
const { TIMEFRAME_MS } = require('../src/modules/market-data/market.constants');
const { candleOverlapsInstrumentSession } = require('../src/modules/instruments/session-calendar');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const commodityList = ACG_INSTRUMENT_CATALOG.filter(item =>
  ['METAL', 'ENERGY', 'OTHER'].includes(item.assetClass));

function resolveSymbols(env = process.env) {
  const selected = String(env.ACG_COMMODITY_AUDIT_SYMBOLS || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
  const list = selected.length ? selected : commodityList.map(item => item.symbol);
  const unique = [...new Set(list)];
  const all = new Map(commodityList.map(item => [item.symbol, item]));
  for (const symbol of unique) if (!all.has(symbol)) throw Error('Unknown commodity ' + symbol);
  return unique.map(symbol => all.get(symbol));
}

function isValidRange(env = process.env) {
  const startMs = Date.parse(env.ACG_COMMODITY_AUDIT_START || '2026-11-25T21:45:00Z');
  const endMs = Date.parse(env.ACG_COMMODITY_AUDIT_END || '2026-11-25T23:15:00Z');
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs
    || endMs - startMs > 7 * 24 * 60 * 60 * 1000) {
    throw Error('Audit requires a valid UTC date range of at most 7 days');
  }
  return { startMs, endMs };
}
function utcApiTime(ms) { return new Date(ms).toISOString().slice(0, 19); }
function maskedError(value, key) {
  const msg = String(value ?? '').slice(0, 400);
  return key ? msg.replaceAll(key, '[redacted]') : msg;
}
function compareRows({ bars, instrument, startMs, endMs, stepMs = TIMEFRAME_MS['5m'] }) {
  const details = {
    symbol: instrument.symbol,
    providerSymbol: instrument.providerMappings.twelveData,
    timezone: instrument.timezone,
    rows: 0,
    openRows: 0,
    closedRows: 0,
    flatClosedRows: 0,
    invalidRows: 0,
    firstOpenTime: null,
    lastOpenTime: null,
  };
  for (const row of bars) {
    const ms = Number(row.openTimeMs);
    const prices = [row.open, row.high, row.low, row.close].map(Number);
    if (!Number.isFinite(ms) || ms < startMs || ms > endMs
      || prices.some(p => !Number.isFinite(p) || p <= 0)) {
      details.invalidRows += 1;
      continue;
    }
    details.rows += 1;
    const valid = candleOverlapsInstrumentSession(instrument, ms, ms + stepMs);
    if (valid) details.openRows += 1;
    else {
      details.closedRows += 1;
      if (prices.every(p => p === prices[0])) details.flatClosedRows += 1;
    }
    const iso = new Date(ms).toISOString();
    details.firstOpenTime ??= iso;
    details.lastOpenTime = iso;
  }
  details.result = details.closedRows > 0 ? 'SESSION_MISMATCH'
    : details.invalidRows > 0 ? 'INVALID_PROVIDER_ROWS'
      : details.openRows > 0 ? 'NO_CLOSED_SESSION_BARS_IN_SAMPLE'
        : 'INCONCLUSIVE_NO_OPEN_SESSION_BARS';
  return details;
}

async function fetchBars({ instrument, apiKey, apiBase, startMs, endMs, fetchImpl = fetch }) {
  const query = new URLSearchParams({
    symbol: instrument.providerMappings.twelveData,
    interval: '5min',
    timezone: 'UTC',
    start_date: utcApiTime(startMs),
    end_date: utcApiTime(endMs),
    order: 'asc',
    outputsize: '5000',
    apikey: apiKey,
  });
  const endpoint = String(apiBase || 'https://api.twelvedata.com').replace(/\/$/, '') + '/time_series';
  const response = await fetchImpl(endpoint + '?' + query);
  const json = await response.json();
  if (!response.ok || json?.status === 'error') {
    const code = json?.code ?? response.status;
    throw Error('Twelve Data request failed (' + code + '): ' + maskedError(json?.message, apiKey));
  }
  if (!Array.isArray(json?.values)) throw Error('Missing values array from Twelve Data');
  const bars = json.values.map(item => ({
    // Parse UTC values only; never infer a host-local timezone.
    openTimeMs: Date.parse(String(item.datetime).replace(' ', 'T') + 'Z'),
    open: item.open, high: item.high, low: item.low, close: item.close,
  }));
  return bars;
}

async function run(env = process.env, fetchImpl = fetch) {
  const apiKey = String(env.TWELVE_DATA_API_KEY || '').trim();
  if (!apiKey || apiKey === 'your_api_key_here') {
    throw Error('TWELVE_DATA_API_KEY is required; no secret values are printed');
  }
  const instruments = resolveSymbols(env);
  const { startMs, endMs } = isValidRange(env);
  const delayMs = Math.min(30000, Math.max(0, Number(env.ACG_COMMODITY_AUDIT_DELAY_MS ?? 1000) || 0));
  const results = [];
  for (const instrument of instruments) {
    try {
      const bars = await fetchBars({
        instrument, apiKey,
        apiBase: env.TWELVE_DATA_API_BASE,
        startMs, endMs, fetchImpl,
      });
      results.push(compareRows({ bars, instrument, startMs, endMs }));
    } catch (error) {
      results.push({ symbol: instrument.symbol, providerSymbol: instrument.providerMappings.twelveData,
        result: 'PROVIDER_ERROR', message: maskedError(error.message, apiKey) });
    }
    if (delayMs > 0) await sleep(delayMs);
  }
  const failed = results.filter(r => r.result === 'SESSION_MISMATCH'
    || r.result === 'PROVIDER_ERROR' || r.result === 'INVALID_PROVIDER_ROWS');
  const inconclusive = results.filter(r => r.result === 'INCONCLUSIVE_NO_OPEN_SESSION_BARS');
  const report = { audit: 'commodity_provider_session_readonly', from: new Date(startMs).toISOString(),
    to: new Date(endMs).toISOString(), symbolsChecked: results.length,
    mismatches: failed.length, inconclusive: inconclusive.length, results,
    releaseApproved: false,
    note: 'A single read-only time-series sample cannot approve trading hours, holidays or live tick cutover.' };
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (failed.length || inconclusive.length) process.exitCode = 1;
  return report;
}

if (require.main === module) run().catch(error => {
  process.stderr.write('Read-only commodity audit failed: ' + maskedError(error.message, process.env.TWELVE_DATA_API_KEY) + '\n');
  process.exitCode = 2;
});

module.exports = { compareRows, fetchBars, resolveSymbols, isValidRange, run };
