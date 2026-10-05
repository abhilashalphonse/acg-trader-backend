'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, fork } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const combined = process.env.RUN_COMBINED_SCALE_TEST === '1';
test(combined ? 'combined local capacity: 1,000 authenticated sockets observe two worker processes flatten 500 accounts'
  : 'local capacity: 1,000 authenticated sockets, 500 active accounts and periodic session revalidation', {
  skip: !process.env.TEST_MONGODB_URI || (process.env.RUN_SOCKET_SCALE_TEST !== '1' && !combined), timeout: 300000,
}, async () => {
  const uri = process.env.TEST_MONGODB_URI;
  if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/acg_socket_test(?:\?|$)/.test(uri)) throw new Error('Dedicated local acg_socket_test replica set required');
  const mongoose = require('mongoose');
  const { Tenant } = require('../../src/modules/tenancy/tenant.model');
  const { TradingAccount } = require('../../src/modules/accounts/trading-account.model');
  const { TraderSession } = require('../../src/modules/auth/trader-session.model');
  const { Instrument } = require('../../src/modules/instruments/instrument.model');
  const { MarketOrderService } = require('../../src/modules/trading/market-order.service');
  const { PendingOrderService } = require('../../src/modules/trading/pending-order.service');
  const { WeekendActionService } = require('../../src/modules/trading/weekend-action.service');
  const { WeekendAccountAction } = require('../../src/modules/trading/weekend-action.model');
  const { Position } = require('../../src/modules/trading/position.model');
  const { Order } = require('../../src/modules/trading/order.model');
  const { AccountStateSynchronizer } = require('../../src/modules/trading/account-state-synchronizer');
  const { ValuationEngine } = require('../../src/modules/trading/valuation-engine');
  const { AuthService, hashToken } = require('../../src/modules/auth/auth.service');
  const { createMarketWebSocketServer } = require('../../src/realtime/market-ws-server');
  const { ensureCriticalIndexes } = require('../../src/config/indexes');
  const eventBus = new EventEmitter();
  const errors = [];
  const logger = { info() {}, warn() {}, debug() {}, error(error) { errors.push(error); } };
  let quote = { symbol: 'EURUSD', bid: 1.101, ask: 1.1012, receivedAtMs: Date.now(), isStale: false, sequence: 1, source: 'local-capacity' };
  const quoteStore = { get: () => ({ ...quote, receivedAtMs: Date.now() }) };
  const manifestPath = path.join(os.tmpdir(), `acg-local-sessions-${crypto.randomUUID()}.json`);
  let server, sockets, engine, tickTimer, child, synchronizer;
  const workers = [];
  const loop = monitorEventLoopDelay({ resolution: 20 });
  try {
    mongoose.set('sanitizeFilter', true);
    await mongoose.connect(uri); await ensureCriticalIndexes();
    const tenant = await Tenant.create({ name: 'Local capacity', slug: 'local-capacity' });
    await Instrument.create({ symbol: 'EURUSD', displaySymbol: 'EUR/USD', name: 'Euro / US Dollar', assetClass: 'FOREX', baseCurrency: 'EUR', quoteCurrency: 'USD',
      digits: 5, tickSize: '.00001', pipSize: '.0001', contractSize: '100000', minVolume: '.01', maxVolume: '100', volumeStep: '.01', defaultLeverage: 100, executionEnabled: true });
    const accounts = await TradingAccount.insertMany(Array.from({ length: 1000 }, (_, i) => ({ tenantId: tenant._id, externalRef: `socket-${i}`, accountCode: `SOCKET-${i}`, ownerExternalRef: `owner-${i}`,
      accountType: 'CHALLENGE', riskDayKey: new Date().toISOString().slice(0, 10), tradingPermissionsVersion: 1,
      tradingPermissions: { newsTrading: false, weekendHolding: false },
      state: { initialBalance: '100000', balance: '100000', equity: '100000', freeMargin: '100000', dailyStartEquity: '100000' } })));
    const market = new MarketOrderService({ quoteStore, logger, eventBus });
    const pending = new PendingOrderService({ quoteStore, logger, eventBus });
    let next = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (next < 500) {
        const index = next++;
        for (let positionIndex = 0; positionIndex < (combined ? 3 : 1); positionIndex++) {
          await market.openMarketOrder({ accountId: accounts[index].id, clientOrderId: `socket-seed-${positionIndex}`, symbol: 'EURUSD', side: 'BUY', volume: '0.1' });
          if (combined) await pending.placePendingOrder({ accountId: accounts[index].id, clientOrderId: `socket-pending-${positionIndex}`, symbol: 'EURUSD', side: 'BUY', type: 'LIMIT', volume: '0.1', limitPrice: '1.09' });
        }
      }
    }));
    const credentials = accounts.map(account => ({ token: `acg_ts_${crypto.randomBytes(32).toString('hex')}`, accountId: account.id }));
    const expires = new Date(Date.now() + 3600000);
    await TraderSession.insertMany(credentials.map((item, i) => ({ tenantId: tenant._id, tokenHash: hashToken(item.token), authMethod: 'FEDERATED',
      ownerExternalRef: accounts[i].ownerExternalRef, accountIds: [accounts[i]._id], selectedAccountId: accounts[i]._id,
      accessExpiresAt: expires, idleExpiresAt: expires, expiresAt: expires })));
    engine = new ValuationEngine({ quoteStore, eventBus, logger }); await engine.start();
    if (combined) {
      synchronizer = new AccountStateSynchronizer({ eventBus, valuationEngine: engine, logger });
      await synchronizer.start();
    }
    const authService = new AuthService(); let authChecks = 0;
    const authenticate = authService.authenticateSessionToken.bind(authService);
    authService.authenticateSessionToken = async (...args) => { authChecks++; return authenticate(...args); };
    server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
    sockets = createMarketWebSocketServer({ server, runtime: { eventBus, quoteStore, symbols: ['EURUSD'], timeframes: ['1m'], candleEngine: { getCurrent: () => null }, health: () => ({ state: 'READY' }) },
      tradingRuntime: { valuationEngine: engine }, authService, path: '/v1/ws', corsOrigins: [], pingIntervalMs: 5000,
      maxBufferBytes: 1024 * 1024, quoteCoalesceMs: 250, valuationCoalesceMs: 250, logger });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(manifestPath, JSON.stringify({ websocketUrl: `ws://127.0.0.1:${server.address().port}/v1/ws`, sessions: credentials }), { mode: 0o600 });
    loop.enable();
    tickTimer = setInterval(() => {
      quote = { ...quote, bid: quote.sequence % 2 ? 1.1011 : 1.101, ask: quote.sequence % 2 ? 1.1013 : 1.1012, sequence: quote.sequence + 1, receivedAtMs: Date.now() };
      eventBus.emit('market.tick', quote); eventBus.emit('market.quote', quote);
    }, 250);
    const start = Date.now();
    child = spawn(process.execPath, [path.resolve('scripts/load-trader-sessions.js')], { windowsHide: true,
      env: { ...process.env, ACG_LOAD_MANIFEST: manifestPath, ACG_LOAD_TARGET_HOST: '127.0.0.1', ACG_LOAD_TRADERS: '1000', ACG_LOAD_ACTIVE_ACCOUNTS: '500', ACG_LOAD_RAMP_SECONDS: '20', ACG_LOAD_SECONDS: combined ? '120' : '75', ACG_LOAD_EXPECT_FLAT_ACCOUNTS: combined ? '500' : '0' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let output = '', stderr = '';
    child.stdout.on('data', value => { output += value; }); child.stderr.on('data', value => { stderr += value; });
    const loadExit = new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    let flattenMs = null;
    if (combined) {
      const initialSync = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Load generator initial sync timed out')), 45000);
        child.once('message', message => { clearTimeout(timeout); resolve(message); });
        child.once('exit', () => { clearTimeout(timeout); reject(new Error(`Load generator exited before initial sync: ${stderr}`)); });
      });
      assert.equal(initialSync.event, 'initialSyncComplete');
      assert.equal(initialSync.synced, 1000); assert.equal(initialSync.activeAccounts, 500);
      const instrument = await Instrument.findOne({ symbol: 'EURUSD' }).lean();
      const planner = new WeekendActionService({ policyService: { config: {} } });
      const plannedAt = Date.now();
      for (const account of accounts.slice(0, 500)) await planner.plan({ account, instrument, enforced: true, weekend: {
        autoCloseAt: new Date(plannedAt - 1000).toISOString(), requiredFlatAt: new Date(plannedAt + 300000).toISOString(),
        marketCloseAt: new Date(plannedAt + 600000).toISOString(), reopenAt: new Date(plannedAt + 86400000).toISOString(),
      } });
      const flattenStart = Date.now();
      for (let index = 0; index < 2; index++) {
        const processWorker = fork(path.resolve('scripts/test-fixtures/weekend-worker.cjs'), [], {
          execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
          env: { ...process.env, ACG_WEEKEND_WORKER_TEST: '1', ACG_WEEKEND_CAPACITY_TEST: '1' },
        });
        let workerError = '';
        processWorker.stderr.on('data', value => { workerError = (workerError + value).slice(-6000); });
        const exited = new Promise(resolve => processWorker.once('exit', (code, signal) => resolve({ code, signal, error: workerError })));
        workers.push({ child: processWorker, exited });
      }
      for (const result of await Promise.all(workers.map(worker => worker.exited))) assert.equal(result.code, 0, result.error);
      flattenMs = Date.now() - flattenStart;
      assert.equal(await WeekendAccountAction.countDocuments({ state: 'CONFIRMED' }), 500);
      assert.equal(await WeekendAccountAction.countDocuments({ late: true }), 0);
      assert.equal(await Position.countDocuments({ status: 'OPEN' }), 0);
      assert.equal(await Order.countDocuments({ status: mongoose.trusted({ $in: ['PENDING', 'TRIGGERED'] }) }), 0);
      const repairDeadline = Date.now() + 10000;
      while (accounts.slice(0, 500).some(account => engine.getAccountSnapshot(account.id)?.positionCount !== 0) && Date.now() < repairDeadline) await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(accounts.slice(0, 500).every(account => engine.getAccountSnapshot(account.id)?.positionCount === 0), 'socket process must repair its cache after remote closes');
      assert.equal(synchronizer.health().ready, true);
    }
    const exitCode = await loadExit;
    if (exitCode !== 0 || errors.length) console.log(JSON.stringify({ combinedDiagnostics: { flattenMs, serverEgress: sockets.health().egress, errors: errors.slice(0, 10).map(item => ({ message: item.err?.message, code: item.err?.code })) } }));
    assert.equal(exitCode, 0, stderr || output);
    const result = JSON.parse(output);
    assert.equal(result.synced, 1000); assert.equal(result.observedActiveAccounts, 500);
    if (combined) { assert.equal(result.observedFlatAccounts, 500); assert.equal(result.observedCloseFills, 1500); }
    assert.ok(authChecks >= 2000, `Expected recurring authentication checks, observed ${authChecks}`);
    assert.equal(errors.length, 0);
    console.log(JSON.stringify({ [combined ? 'combinedLocalCapacity' : 'localSocketCapacity']: { ...result, elapsedMs: Date.now() - start, authChecks,
      serverEventLoopP99Ms: loop.percentile(99) / 1e6, serverEgress: sockets.health().egress,
      ...(combined ? { flattenMs, initialPositions: 1500, initialPendingOrders: 1500, workerProcesses: 2, socketProcesses: 1, stateSynchronization: synchronizer.health(),
        scope: 'Concurrent authenticated socket traffic and weekend flattening, with client-observed flat state and closing fills; excludes ordinary order traffic, provider failover and full deployed runtime.' } : {}),
      fixture: combined ? 'Real AuthService, WebSocket server, MongoDB, two independent weekend worker processes and cross-process cache/client state repair; synthetic quotes; excludes login, upstream providers, ordinary order traffic and the full risk runtime.'
        : 'Persisted test sessions verified by real AuthService, real WebSocket server/valuation and MongoDB; synthetic quotes, one application process; excludes login and upstream providers.' } }));
  } finally {
    child?.kill(); clearInterval(tickTimer); loop.disable();
    for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
    await Promise.all(workers.map(worker => worker.exited));
    if (sockets) await sockets.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await synchronizer?.stop();
    if (engine) await engine.stop();
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
});
