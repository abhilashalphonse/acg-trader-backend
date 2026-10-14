'use strict';
// Disposable, real-server integration harness. NEVER point at production MongoDB.
// Runs actual ACG auth, trading, market gateway and WebSocket code.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const express = require('express');
const mongoose = require('mongoose');

if (process.env.CI !== 'true' || process.env.PR72_E2E_DISPOSABLE !== '1') {
  throw Error('Disposable CI guard required');
}
const url = new URL(process.env.MONGODB_URI || '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname)
  || url.port !== '27017' || url.pathname !== '/acg_pr72_browser_e2e') {
  throw Error('Refusing non-disposable MongoDB URI');
}
if (!process.env.TWELVE_DATA_API_KEY) throw Error('Provider credential not configured');
if (!process.env.PR72_E2E_PRIVATE_DATA) throw Error('Private runner data path required');

const { ensureCriticalIndexes } = require('../src/config/indexes');
const { syncInstrumentCatalog, enforceCatalogLeveragePolicy } = require('../src/modules/instruments/instrument-catalog.service');
const { Tenant } = require('../src/modules/tenancy/tenant.model');
const { Instrument } = require('../src/modules/instruments/instrument.model');
const { AccountControlService } = require('../src/modules/trading/account-control.service');
const { createMarketRuntime } = require('../src/modules/market-data/market.runtime');
const { createTradingRuntime } = require('../src/modules/trading/trading.runtime');
const { createAuthRuntime } = require('../src/modules/auth/auth.runtime');
const { createApp } = require('../src/app');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const secret = crypto.randomBytes(32).toString('hex');
let marketRuntime, tradingRuntime, server;
const originalSetter = { current: null };
const outages = new Set();

async function initReplicaSet() {
  const direct = new mongoose.mongo.MongoClient('mongodb://127.0.0.1:27017/admin', { directConnection: true });
  await direct.connect();
  try {
    const hello = await direct.db('admin').command({ hello: 1 });
    if (!hello.setName) await direct.db('admin').command({ replSetInitiate: {
      _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }],
    } });
  } finally { await direct.close(); }
  let ready = false;
  for (let i = 0; i < 35; i++) {
    try {
      const probe = new mongoose.mongo.MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 1000 });
      await probe.connect(); const hello = await probe.db('admin').command({ hello: 1 });
      await probe.close();
      if (hello.isWritablePrimary) { ready = true; break; }
    } catch { /* electing primary */ }
    await sleep(400);
  }
  if (!ready) throw Error('Disposable replica set did not elect a primary');
}

async function main() {
  await initReplicaSet();
  await mongoose.connect(process.env.MONGODB_URI);
  if (mongoose.connection.name !== 'acg_pr72_browser_e2e') throw Error('Database isolation lost');
  await mongoose.connection.dropDatabase();
  await ensureCriticalIndexes();
  await syncInstrumentCatalog();
  await enforceCatalogLeveragePolicy();
  const spec = await Instrument.findOne({ symbol: 'BTCUSD' });
  if (!spec) throw Error('Crypto instrument unavailable');
  // Eligible products in the disposable database only; never override real sessions.
  await Instrument.updateMany({ symbol: { $in: ['BTCUSD', 'EURUSD'] } },
    { $set: { executionEnabled: true, status: 'ACTIVE' } });
  const tenant = await Tenant.create({
    name: 'PR72 Browser CI', slug: 'acg-pr72-ci', authModes: ['PASSWORD', 'FEDERATED'],
    allowedOrigins: ['http://127.0.0.1:5174'],
  });
  const owner = 'pr72-ci-owner';
  const provisioner = new AccountControlService();
  const provision = async (code, currency, ownerRef = owner) => {
    const result = await provisioner.provision({
      tenantId: String(tenant._id), externalRef: code, ownerExternalRef: ownerRef,
      accountCode: code, accountType: 'DEMO', currency, initialBalance: '100000',
      leverage: 100, riskPolicy: {},
      tradingPermissionsVersion: 1,
      tradingPermissions: { newsTrading: true, weekendHolding: true },
    });
    return result.account;
  };
  const native = await provision('ACI-NATIVE', 'USD', 'pr72-native-only');
  const primary = await provision('ACI-USD-A', 'USD');
  const secondary = await provision('ACI-USD-B', 'USD');
  const eur = await provision('ACI-EUR', 'EUR');
  const authRuntime = createAuthRuntime();
  const nativePassword = crypto.randomBytes(30).toString('base64url') + 'aA1!';
  await authRuntime.authService.createNativeCredential({
    tenantId: String(tenant._id), accountId: String(native._id),
    login: 'pr72-native', password: nativePassword, mustChangePassword: false,
  });

  marketRuntime = createMarketRuntime();
  // Controlled outage only in isolated CI: gateway receives genuine provider
  // quotes, but its quoteStore deliberately discards new ticks while paused.
  originalSetter.current = marketRuntime.quoteStore.set.bind(marketRuntime.quoteStore);
  marketRuntime.quoteStore.set = quote => outages.has(String(quote.symbol).toUpperCase())
    ? marketRuntime.quoteStore.get(quote.symbol) : originalSetter.current(quote);

  tradingRuntime = createTradingRuntime({ marketRuntime });
  await tradingRuntime.start();
  await marketRuntime.start();
  const actualApp = createApp({ marketRuntime, tradingRuntime, authRuntime });
  const controller = express();
  controller.use('/__pr72_ci', express.json(), (req, res, next) => {
    if (req.ip !== '127.0.0.1' && req.ip !== '::ffff:127.0.0.1') return res.sendStatus(403);
    if (req.headers['x-pr72-ci-control'] !== secret) return res.sendStatus(403);
    next();
  });
  controller.post('/__pr72_ci/federation', async (_req, res, next) => {
    try {
      const ticket = await authRuntime.authService.createFederationTicket({
        tenantId: String(tenant._id), ownerExternalRef: owner,
        accountIds: [primary, secondary, eur].map(a => String(a._id)),
        selectedAccountId: String(primary._id),
      });
      res.json(ticket); // Only to localhost, with private runner token.
    } catch (e) { next(e); }
  });
  controller.post('/__pr72_ci/outage', (req, res) => {
    const symbol = String(req.body?.symbol || '').toUpperCase();
    if (!['BTCUSD', 'EURUSD'].includes(symbol)) return res.sendStatus(400);
    const current = marketRuntime.quoteStore.get(symbol);
    if (!current) return res.sendStatus(409);
    outages.add(symbol);
    originalSetter.current({ ...current, receivedAtMs: Date.now() - 180000, isStale: true });
    marketRuntime.eventBus.emit('market.tick', { ...current, receivedAtMs: Date.now() - 180000, isStale: true });
    res.json({ state: 'PAUSED', symbol });
  });
  controller.post('/__pr72_ci/recover', (req, res) => {
    const symbol = String(req.body?.symbol || '').toUpperCase();
    outages.delete(symbol);
    res.json({ state: 'RESUMED', symbol });
  });
  controller.use(actualApp);
  server = http.createServer(controller);
  marketRuntime.attachWebSocket(server, authRuntime.authService, tradingRuntime);
  await new Promise((resolve, reject) => server.listen(4000, '127.0.0.1', error => error ? reject(error) : resolve()));

  const privateData = {
    controlToken: secret, nativeLogin: 'pr72-native', nativePassword,
    tenant: 'acg-pr72-ci',
    accounts: { native: String(native._id), primary: String(primary._id),
      secondary: String(secondary._id), eur: String(eur._id) },
    accountCodes: { primary:primary.accountCode, secondary:secondary.accountCode, eur:eur.accountCode },
  };
  fs.writeFileSync(process.env.PR72_E2E_PRIVATE_DATA, JSON.stringify(privateData), { mode: 0o600, flag: 'wx' });
  console.log('PR72_E2E_HARNESS_READY'); // No credentials, tickets or user records in logs.
}

async function stop() {
  if (server) await new Promise(resolve => server.close(resolve));
  if (marketRuntime) await marketRuntime.stop();
  if (tradingRuntime) await tradingRuntime.stop();
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
main().catch(async error => {
  console.error('PR72_E2E_HARNESS_ERROR', error.message);
  try { await stop(); } catch { process.exit(1); }
  process.exit(1);
});
