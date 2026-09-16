'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const API_KEY = process.env.TWELVE_DATA_API_KEY;
const SYMBOLS = (process.env.TWELVE_DATA_SYMBOLS || 'EUR/USD,XAU/USD').split(',').map((s) => s.trim()).filter(Boolean);
const TEST_MINUTES = Number(process.env.TWELVE_DATA_TEST_MINUTES || 15);
const TEST_DURATION_MS = TEST_MINUTES * 60 * 1000;
const HEARTBEAT_MS = 10_000;
const RECONNECT_MS = 1_000;

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

const stats = new Map(SYMBOLS.map((symbol) => [symbol, {
  events: 0, priceChanges: 0, duplicates: 0, intervals: [],
  lastArrivalNs: null, lastPrice: null, firstArrivalNs: null, finalArrivalNs: null,
  firstProviderTimestamp: null, finalProviderTimestamp: null,
}]));

const startedNs = process.hrtime.bigint();
let ws = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let finishing = false;
let connectionStartedNs = null;
let connectedNs = 0n;
let disconnectedStartedNs = null;
let disconnectedNs = 0n;
let connections = 0;
let unexpectedDisconnects = 0;
let reconnects = 0;

console.log('============================================================');
console.log(' ACG Trader - Twelve Data WebSocket Diagnostic v2');
console.log('============================================================');
console.log(`Symbols : ${SYMBOLS.join(', ')}`);
console.log(`Duration: ${TEST_MINUTES} minute(s)`);
console.log(`Raw log : ${logPath}`);
console.log('============================================================\n');

const stopTimer = setTimeout(() => finish('Test duration reached.'), TEST_DURATION_MS);
connect(false);

function connect(isReconnect) {
  if (finishing) return;
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    const now = process.hrtime.bigint();
    connections += 1;
    if (isReconnect) reconnects += 1;
    if (disconnectedStartedNs !== null) {
      disconnectedNs += now - disconnectedStartedNs;
      disconnectedStartedNs = null;
    }
    connectionStartedNs = now;
    console.log(`${isReconnect ? 'Reconnected' : 'Connected'} to Twelve Data WebSocket.`);

    ws.send(JSON.stringify({ action: 'subscribe', params: { symbols: SYMBOLS.join(',') } }));
    console.log(`Subscription sent for ${SYMBOLS.join(', ')}.`);

    // Send an application heartbeat immediately, then every 10 seconds.
    sendHeartbeat();
    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_MS);
  });

  ws.on('message', handleMessage);

  ws.on('error', (error) => {
    console.error(`\nWebSocket error: ${error.message}`);
    logMeta('socket-error', { message: error.message });
  });

  ws.on('close', (code, reason) => {
    const now = process.hrtime.bigint();
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;

    if (connectionStartedNs !== null) {
      connectedNs += now - connectionStartedNs;
      connectionStartedNs = null;
    }

    console.log(`\nWebSocket closed: ${code}${reason?.length ? ` ${reason.toString()}` : ''}`);
    logMeta('socket-close', { code, reason: reason?.toString() || '' });

    if (finishing) return;
    unexpectedDisconnects += 1;
    disconnectedStartedNs = now;
    console.log(`Reconnecting in ${RECONNECT_MS}ms...\n`);
    reconnectTimer = setTimeout(() => connect(true), RECONNECT_MS);
  });
}

function sendHeartbeat() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ action: 'heartbeat' }));
  }
}

function handleMessage(buffer) {
  const arrivalNs = process.hrtime.bigint();
  const arrivalWallMs = Date.now();
  const raw = buffer.toString();

  logStream.write(`${JSON.stringify({
    type: 'message', localArrivalIso: new Date(arrivalWallMs).toISOString(),
    localArrivalUnixMs: arrivalWallMs, localArrivalMonotonicNs: arrivalNs.toString(), raw,
  })}\n`);

  let data;
  try { data = JSON.parse(raw); } catch {
    console.log(`${formatWallTime(arrivalWallMs)} NON-JSON ${raw}`);
    return;
  }
  if (data.event !== 'price') {
    console.log(`${formatWallTime(arrivalWallMs)} WS EVENT ${raw}`);
    return;
  }

  const s = stats.get(data.symbol);
  const price = Number(data.price);
  if (!s || !Number.isFinite(price)) return;

  if (s.firstArrivalNs === null) s.firstArrivalNs = arrivalNs;
  let intervalMs = null;
  if (s.lastArrivalNs !== null) {
    intervalMs = Number(arrivalNs - s.lastArrivalNs) / 1e6;
    s.intervals.push(intervalMs);
  }

  s.events += 1;
  if (s.lastPrice === null || price !== s.lastPrice) s.priceChanges += 1;
  else s.duplicates += 1;

  if (data.timestamp != null && Number.isFinite(Number(data.timestamp))) {
    const timestamp = Number(data.timestamp);
    if (s.firstProviderTimestamp === null) s.firstProviderTimestamp = timestamp;
    s.finalProviderTimestamp = timestamp;
  }

  s.lastArrivalNs = arrivalNs;
  s.finalArrivalNs = arrivalNs;
  s.lastPrice = price;

  console.log(`${formatWallTime(arrivalWallMs)} ${data.symbol.padEnd(8)} ${String(data.price).padEnd(14)}${intervalMs === null ? '' : ` +${intervalMs.toFixed(1)}ms`}`);
}

function logMeta(event, extra = {}) {
  logStream.write(`${JSON.stringify({ type: 'diagnostic', event, localArrivalIso: new Date().toISOString(), ...extra })}\n`);
}

function formatWallTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
function average(v) { return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; }
function percentile(v, p) {
  if (!v.length) return 0;
  const a = [...v].sort((x, y) => x - y);
  const rank = (p / 100) * (a.length - 1), lo = Math.floor(rank), hi = Math.ceil(rank);
  return lo === hi ? a[lo] : a[lo] * (1 - (rank - lo)) + a[hi] * (rank - lo);
}
function seconds(ns) { return Number(ns) / 1e9; }

function printReport(endNs) {
  let totalConnected = connectedNs;
  if (connectionStartedNs !== null) totalConnected += endNs - connectionStartedNs;
  let totalDisconnected = disconnectedNs;
  if (disconnectedStartedNs !== null) totalDisconnected += endNs - disconnectedStartedNs;
  const wallSeconds = seconds(endNs - startedNs);
  const connectedSeconds = seconds(totalConnected);
  const disconnectedSeconds = seconds(totalDisconnected);
  const uptime = wallSeconds > 0 ? (connectedSeconds / wallSeconds) * 100 : 0;

  console.log('\n============================================================');
  console.log(' FINAL REPORT');
  console.log('============================================================\n');
  console.log(`Connections             ${connections}`);
  console.log(`Unexpected disconnects  ${unexpectedDisconnects}`);
  console.log(`Reconnects              ${reconnects}`);
  console.log(`Total test duration     ${wallSeconds.toFixed(1)} sec`);
  console.log(`Connected duration      ${connectedSeconds.toFixed(1)} sec`);
  console.log(`Disconnected duration   ${disconnectedSeconds.toFixed(1)} sec`);
  console.log(`Connection uptime       ${uptime.toFixed(2)}%`);

  for (const symbol of SYMBOLS) {
    const s = stats.get(symbol);
    console.log(`\n${symbol}\n`);
    if (!s || s.events === 0) { console.log('No price events received.'); continue; }
    const comparable = Math.max(0, s.events - 1);
    const longest = s.intervals.length ? Math.max(...s.intervals) : 0;
    console.log(`Events received         ${s.events.toLocaleString()}`);
    console.log(`Price changes           ${s.priceChanges.toLocaleString()}`);
    console.log(`Events/sec connected    ${(connectedSeconds > 0 ? s.events / connectedSeconds : 0).toFixed(2)}`);
    console.log(`Events/sec wall-clock   ${(wallSeconds > 0 ? s.events / wallSeconds : 0).toFixed(2)}`);
    console.log(`Median interval         ${percentile(s.intervals, 50).toFixed(1)} ms`);
    console.log(`Average interval        ${average(s.intervals).toFixed(1)} ms`);
    console.log(`P95 interval            ${percentile(s.intervals, 95).toFixed(1)} ms`);
    console.log(`P99 interval            ${percentile(s.intervals, 99).toFixed(1)} ms`);
    console.log(`Longest gap             ${(longest / 1000).toFixed(3)} sec`);
    console.log(`Duplicates              ${(comparable ? (s.duplicates / comparable) * 100 : 0).toFixed(2)}%`);
    if (s.firstProviderTimestamp !== null) console.log(`Provider timestamp      ${s.firstProviderTimestamp} -> ${s.finalProviderTimestamp}`);
  }
  console.log('\n============================================================');
  console.log(`Raw JSONL log: ${logPath}`);
  console.log('============================================================\n');
}

function finish(message) {
  if (finishing) return;
  finishing = true;
  clearTimeout(stopTimer);
  clearInterval(heartbeatTimer);
  clearTimeout(reconnectTimer);
  const endNs = process.hrtime.bigint();
  console.log(`\n${message}`);
  printReport(endNs);
  logMeta('diagnostic-finished', { message });
  logStream.end();
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    try { ws.close(1000, 'diagnostic complete'); } catch { /* ignore */ }
  }
  setTimeout(() => process.exit(0), 300);
}

process.on('SIGINT', () => finish('Manual stop requested.'));
process.on('SIGTERM', () => finish('Termination requested.'));
