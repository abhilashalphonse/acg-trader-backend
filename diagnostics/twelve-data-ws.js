'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const SYMBOLS = (process.env.TWELVE_DATA_SYMBOLS || 'EUR/USD,XAU/USD')
  .split(',')
  .map((symbol) => symbol.trim())
  .filter(Boolean);
const TEST_MINUTES = Number(process.env.TWELVE_DATA_TEST_MINUTES || 15);
const TEST_DURATION_MS = TEST_MINUTES * 60 * 1000;
const HEARTBEAT_MS = 10_000;

if (!API_KEY || API_KEY === 'your_api_key_here') {
  console.error('Missing TWELVE_DATA_API_KEY. Copy .env.example to .env and add your real key.');
  process.exit(1);
}

if (!Number.isFinite(TEST_MINUTES) || TEST_MINUTES <= 0) {
  console.error('TWELVE_DATA_TEST_MINUTES must be a positive number.');
  process.exit(1);
}

const wsUrl = `wss://ws.twelvedata.com/v1/quotes/price?apikey=${encodeURIComponent(API_KEY)}`;
const logDirectory = path.join(process.cwd(), 'logs');
fs.mkdirSync(logDirectory, { recursive: true });
const logPath = path.join(logDirectory, `twelve-data-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const logStream = fs.createWriteStream(logPath, { flags: 'a' });

const stats = new Map(
  SYMBOLS.map((symbol) => [
    symbol,
    {
      events: 0,
      priceChanges: 0,
      duplicates: 0,
      intervals: [],
      lastArrivalNs: null,
      lastPrice: null,
      firstArrivalNs: null,
      finalArrivalNs: null,
      firstProviderTimestamp: null,
      finalProviderTimestamp: null,
    },
  ])
);

let heartbeatTimer = null;
let stopTimer = null;
let finishing = false;
let connectedAtNs = null;

console.log('============================================================');
console.log(' ACG Trader - Twelve Data WebSocket Diagnostic');
console.log('============================================================');
console.log(`Symbols : ${SYMBOLS.join(', ')}`);
console.log(`Duration: ${TEST_MINUTES} minute(s)`);
console.log(`Raw log : ${logPath}`);
console.log('============================================================\n');

const ws = new WebSocket(wsUrl);

ws.on('open', () => {
  connectedAtNs = process.hrtime.bigint();
  console.log('Connected to Twelve Data WebSocket.');

  const subscription = {
    action: 'subscribe',
    params: { symbols: SYMBOLS.join(',') },
  };

  ws.send(JSON.stringify(subscription));
  console.log(`Subscription sent for ${SYMBOLS.join(', ')}.\n`);

  heartbeatTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'heartbeat' }));
    }
  }, HEARTBEAT_MS);

  stopTimer = setTimeout(() => finish('Test duration reached.'), TEST_DURATION_MS);
});

ws.on('message', (buffer) => {
  // Capture the local arrival time before parsing/printing so diagnostic work does
  // not distort the interval measurement. hrtime is monotonic; Date is wall clock.
  const arrivalNs = process.hrtime.bigint();
  const arrivalWallMs = Date.now();
  const raw = buffer.toString();

  logStream.write(`${JSON.stringify({
    localArrivalIso: new Date(arrivalWallMs).toISOString(),
    localArrivalUnixMs: arrivalWallMs,
    localArrivalMonotonicNs: arrivalNs.toString(),
    raw,
  })}\n`);

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    console.log(`${formatWallTime(arrivalWallMs)} NON-JSON ${raw}`);
    return;
  }

  if (data.event !== 'price') {
    console.log(`${formatWallTime(arrivalWallMs)} WS EVENT ${raw}`);
    return;
  }

  const symbol = data.symbol;
  const symbolStats = stats.get(symbol);
  if (!symbolStats) return;

  const price = Number(data.price);
  if (!Number.isFinite(price)) return;

  if (symbolStats.firstArrivalNs === null) symbolStats.firstArrivalNs = arrivalNs;

  let intervalMs = null;
  if (symbolStats.lastArrivalNs !== null) {
    intervalMs = Number(arrivalNs - symbolStats.lastArrivalNs) / 1e6;
    symbolStats.intervals.push(intervalMs);
  }

  symbolStats.events += 1;
  if (symbolStats.lastPrice === null || price !== symbolStats.lastPrice) {
    symbolStats.priceChanges += 1;
  } else {
    symbolStats.duplicates += 1;
  }

  if (data.timestamp != null) {
    const providerTimestamp = Number(data.timestamp);
    if (Number.isFinite(providerTimestamp)) {
      if (symbolStats.firstProviderTimestamp === null) symbolStats.firstProviderTimestamp = providerTimestamp;
      symbolStats.finalProviderTimestamp = providerTimestamp;
    }
  }

  symbolStats.lastArrivalNs = arrivalNs;
  symbolStats.finalArrivalNs = arrivalNs;
  symbolStats.lastPrice = price;

  const intervalText = intervalMs === null ? '' : ` +${intervalMs.toFixed(1)}ms`;
  console.log(`${formatWallTime(arrivalWallMs)} ${symbol.padEnd(8)} ${String(data.price).padEnd(14)}${intervalText}`);
});

ws.on('error', (error) => {
  console.error(`\nWebSocket error: ${error.message}`);
});

ws.on('close', (code, reason) => {
  console.log(`\nWebSocket closed: ${code}${reason?.length ? ` ${reason.toString()}` : ''}`);
  if (!finishing) finish('Connection closed before the requested duration.', false);
});

function formatWallTime(timestampMs) {
  const date = new Date(timestampMs);
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (percentileValue / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function median(values) {
  return percentile(values, 50);
}

function secondsBetween(startNs, endNs) {
  if (startNs === null || endNs === null || endNs <= startNs) return 0;
  return Number(endNs - startNs) / 1e9;
}

function printReport() {
  console.log('\n============================================================');
  console.log(' FINAL REPORT');
  console.log('============================================================');

  for (const symbol of SYMBOLS) {
    const s = stats.get(symbol);
    console.log(`\n${symbol}\n`);

    if (!s || s.events === 0) {
      console.log('No price events received.');
      continue;
    }

    // Use the actual observation window. For a single tick, fall back to elapsed
    // connection time so Events/sec does not divide by zero.
    let observedSeconds = secondsBetween(s.firstArrivalNs, s.finalArrivalNs);
    if (observedSeconds === 0 && connectedAtNs !== null) {
      observedSeconds = secondsBetween(connectedAtNs, process.hrtime.bigint());
    }

    const eventsPerSecond = observedSeconds > 0 ? s.events / observedSeconds : 0;
    const comparableEvents = Math.max(0, s.events - 1);
    const duplicatePercentage = comparableEvents > 0 ? (s.duplicates / comparableEvents) * 100 : 0;
    const longestGap = s.intervals.length ? Math.max(...s.intervals) : 0;

    console.log(`Events received       ${s.events.toLocaleString()}`);
    console.log(`Price changes         ${s.priceChanges.toLocaleString()}`);
    console.log(`Events/sec            ${eventsPerSecond.toFixed(2)}`);
    console.log(`Median interval       ${median(s.intervals).toFixed(1)} ms`);
    console.log(`Average interval      ${average(s.intervals).toFixed(1)} ms`);
    console.log(`P95 interval          ${percentile(s.intervals, 95).toFixed(1)} ms`);
    console.log(`P99 interval          ${percentile(s.intervals, 99).toFixed(1)} ms`);
    console.log(`Longest gap           ${(longestGap / 1000).toFixed(3)} sec`);
    console.log(`Duplicates            ${duplicatePercentage.toFixed(2)}%`);

    if (s.firstProviderTimestamp !== null) {
      console.log(`Provider timestamp    ${s.firstProviderTimestamp} -> ${s.finalProviderTimestamp}`);
    }
  }

  console.log('\n============================================================');
  console.log(`Raw JSONL log: ${logPath}`);
  console.log('============================================================\n');
}

function finish(message, closeSocket = true) {
  if (finishing) return;
  finishing = true;
  console.log(`\n${message}`);

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (stopTimer) clearTimeout(stopTimer);

  printReport();
  logStream.end();

  if (closeSocket && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'diagnostic complete');
  }

  // Give stdout/log stream a moment to flush on normal/manual termination.
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => finish('Manual stop requested.'));
process.on('SIGTERM', () => finish('Termination requested.'));
