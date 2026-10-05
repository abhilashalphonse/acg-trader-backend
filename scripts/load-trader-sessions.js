'use strict';
// Read-only staging soak. Credentials are read from a local file and never included in output.
const fs = require('node:fs');
const { WebSocket } = require('ws');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');

async function main() {
  const manifest = JSON.parse(fs.readFileSync(process.env.ACG_LOAD_MANIFEST, 'utf8'));
  const target = new URL(manifest.websocketUrl);
  if (!['ws:', 'wss:'].includes(target.protocol) || target.username || target.password || target.search) throw new Error('Use a WebSocket URL without credentials/query parameters');
  if (target.hostname !== process.env.ACG_LOAD_TARGET_HOST) throw new Error('ACG_LOAD_TARGET_HOST must explicitly match the test host');
  const count = integer(process.env.ACG_LOAD_TRADERS, 1000, 1, 10000);
  const activeTarget = integer(process.env.ACG_LOAD_ACTIVE_ACCOUNTS, 500, 0, count);
  const flatTarget = integer(process.env.ACG_LOAD_EXPECT_FLAT_ACCOUNTS, 0, 0, count);
  const durationMs = integer(process.env.ACG_LOAD_SECONDS, 300, 10, 3600) * 1000;
  const rampMs = integer(process.env.ACG_LOAD_RAMP_SECONDS, 60, 1, 600) * 1000;
  if (!Array.isArray(manifest.sessions) || manifest.sessions.length < count) throw new Error(`Provide ${count} distinct test sessions`);
  const sessions = manifest.sessions.slice(0, count);
  if (sessions.some(item => !item.token || !item.accountId) || new Set(sessions.map(item => item.token)).size !== count) throw new Error('Each trader needs a distinct session token and accountId');
  const metrics = { targetTraders: count, targetActiveAccounts: activeTarget, connected: 0, synced: 0, subscriptionErrors: 0,
    errors: 0, unexpectedDisconnects: 0, messages: 0, bytes: 0, peakConnected: 0, pingTimeouts: 0 };
  const activeAccounts = new Set();
  const latestAccounts = new Map();
  const syncMs = [], pingMs = [];
  const sockets = [];
  const loop = monitorEventLoopDelay({ resolution: 20 }); loop.enable();
  let stopping = false;
  try {
    await Promise.all(sessions.map((session, index) => new Promise(resolve => {
      setTimeout(() => {
        const start = performance.now();
        const socket = new WebSocket(target, ['acg-trader', `auth.${session.token}`], { handshakeTimeout: 15000,
          ...(manifest.origin ? { origin: manifest.origin } : {}) });
        sockets.push(socket);
        let synced = false, connected = false, pingSentAt = null;
        const timeout = setTimeout(() => { metrics.errors++; socket.terminate(); resolve(); }, 30000);
        socket.on('open', () => {
          connected = true; metrics.connected++; metrics.peakConnected = Math.max(metrics.peakConnected, metrics.connected);
          socket.send(JSON.stringify({ action: 'subscribe', params: { quotes: manifest.symbols || ['EURUSD'] } }));
        });
        const ping = setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) return;
          if (pingSentAt != null) metrics.pingTimeouts++;
          pingSentAt = Date.now(); socket.send(JSON.stringify({ action: 'ping', timestamp: pingSentAt }));
        }, 10000);
        socket.on('message', buffer => {
          metrics.messages++; metrics.bytes += buffer.length;
          let message; try { message = JSON.parse(buffer); } catch { metrics.errors++; return; }
          if (message.type === 'error') metrics.errors++;
          if (message.type === 'subscription.status') metrics.subscriptionErrors += message.data?.rejected?.length || 0;
          if (message.type === 'pong' && message.data?.clientTimestamp === pingSentAt) { pingMs.push(Date.now() - pingSentAt); pingSentAt = null; }
          if (message.type === 'trading.state.snapshot') {
            const account = message.data?.accounts?.find(item => item.account?.id === session.accountId);
            if (!account) { if (!synced) { metrics.errors++; socket.terminate(); } return; }
            latestAccounts.set(session.accountId, account);
            if (!synced) {
              synced = true; metrics.synced++; syncMs.push(performance.now() - start);
              if (account.positions?.some(position => position.status === 'OPEN')) activeAccounts.add(session.accountId);
              clearTimeout(timeout); resolve();
            }
          }
        });
        socket.on('error', () => { metrics.errors++; });
        socket.on('close', () => { clearTimeout(timeout); clearInterval(ping); if (connected) metrics.connected--; if (!stopping) metrics.unexpectedDisconnects++; resolve(); });
      }, index * rampMs / count);
    })));
    const allConnectedAtStart = metrics.connected === count && metrics.synced === count;
    process.send?.({ event: 'initialSyncComplete', connected: metrics.connected, synced: metrics.synced, activeAccounts: activeAccounts.size });
    await new Promise(resolve => setTimeout(resolve, durationMs));
    const observedFlatAccounts = [...activeAccounts].filter(id => {
      const account = latestAccounts.get(id);
      return !account.positions?.some(position => position.status === 'OPEN')
        && !account.orders?.some(order => ['PENDING', 'TRIGGERED'].includes(order.status));
    }).length;
    const observedCloseFills = [...activeAccounts].reduce((sum, id) => sum + (latestAccounts.get(id).fills || []).filter(fill => fill.type === 'CLOSE').length, 0);
    const passed = allConnectedAtStart && metrics.connected === count && activeAccounts.size >= activeTarget
      && observedFlatAccounts >= flatTarget
      && metrics.errors === 0 && metrics.unexpectedDisconnects === 0 && metrics.subscriptionErrors === 0 && metrics.pingTimeouts === 0;
    console.log(JSON.stringify({ ...metrics, observedActiveAccounts: activeAccounts.size, observedFlatAccounts, observedCloseFills, expectedFlatAccounts: flatTarget, durationMs, rampMs, passed,
      syncMs: percentiles(syncMs), pingMs: percentiles(pingMs), generatorEventLoopP99Ms: loop.percentile(99) / 1e6,
      scope: 'Authenticated WebSocket state sync, quote subscriptions and heartbeat soak; excludes order throughput, provider failover and weekend deadline capacity.' }, null, 2));
    if (!passed) process.exitCode = 1;
  } finally { stopping = true; for (const socket of sockets) socket.terminate(); loop.disable(); if (process.connected) process.disconnect(); }
}
function integer(value, fallback, min, max) { const n = Number(value ?? fallback); if (!Number.isInteger(n) || n < min || n > max) throw new Error('Invalid load-test numeric option'); return n; }
function percentiles(values) { const sorted = [...values].sort((a, b) => a - b); const at = q => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? null; return { samples: sorted.length, p50: at(.5), p95: at(.95), p99: at(.99) }; }
main().catch(error => { console.error(error.message); process.exitCode = 1; });
