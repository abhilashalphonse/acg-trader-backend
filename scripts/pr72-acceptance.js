'use strict';

// Destructive fixtures are permitted ONLY in the dedicated disposable database.
// No production credentials, live feed, platform relay or customer records.
const uri = process.env.MONGODB_URI || '';
if (process.env.PR72_ISOLATED_ACCEPTANCE !== '1'
  || !/^mongodb:\/\/(mongo\.railway\.internal|127\.0\.0\.1):27017\/acg_pr72_acceptance(?:\?|$)/.test(uri)) {
  throw new Error('PR72 acceptance requires an explicitly enabled isolated acg_pr72_acceptance database');
}
process.env.MARKET_GATEWAY_ENABLED = 'false';
process.env.PLATFORM_EVENTS_ENABLED = 'false';
process.env.TRADING_API_ENABLED = 'true';
process.env.NEWS_TRADING_ENFORCEMENT = 'false';
process.env.WEEKEND_HOLDING_ENFORCEMENT = 'false';
process.env.TRADING_PERMISSION_SHADOW_ENABLED = 'false';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const express = require('express');
const mongoose = require('mongoose');
const { Tenant } = require('../src/modules/tenancy/tenant.model');
const { TradingAccount } = require('../src/modules/accounts/trading-account.model');
const { TraderSession } = require('../src/modules/auth/trader-session.model');
const { AuthService, hashToken } = require('../src/modules/auth/auth.service');
const { Instrument } = require('../src/modules/instruments/instrument.model');
const { syncInstrumentCatalog, enforceCatalogLeveragePolicy } = require('../src/modules/instruments/instrument-catalog.service');
const { ACG_LEVERAGE_BY_ASSET_CLASS } = require('../src/modules/instruments/instrument-catalog');
const { AccountControlService } = require('../src/modules/trading/account-control.service');
const { MarketOrderService } = require('../src/modules/trading/market-order.service');
const { PendingOrderService } = require('../src/modules/trading/pending-order.service');
const { PendingOrderEngine } = require('../src/modules/trading/pending-order-engine');
const { ValuationEngine } = require('../src/modules/trading/valuation-engine');
const { PositionProtectionService } = require('../src/modules/trading/position-protection.service');
const { TradingPermissionPolicyService } = require('../src/modules/trading/trading-permission-policy.service');
const { CurrencyConversionEngine, setDefaultCurrencyConversionEngine } = require('../src/modules/trading/currency-conversion-engine');
const { AccountCommandQueue } = require('../src/modules/trading/account-command-queue');
const { Position } = require('../src/modules/trading/position.model');
const { Order } = require('../src/modules/trading/order.model');
const { Deal } = require('../src/modules/trading/deal.model');
const { createTradingRouter } = require('../src/modules/trading/trading.routes');
const { errorHandler } = require('../src/shared/http/error-middleware');
const { ensureCriticalIndexes } = require('../src/config/indexes');
const { shouldTriggerStopOut } = require('../src/modules/trading/margin-stop-out-engine');
const { evaluateRiskContext } = require('../src/modules/trading/challenge-risk-engine');

const checks = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await pause(100); } throw new Error('Acceptance condition timed out'); }
async function main() {
  const direct = new mongoose.mongo.MongoClient(uri, { directConnection: true, serverSelectionTimeoutMS: 30000 });
  await direct.connect();
  try {
    const hello = await direct.db('admin').command({ hello: 1 });
    if (!hello.setName) {
      const host = uri.includes('mongo.railway.internal') ? 'mongo.railway.internal:27017' : '127.0.0.1:27017';
      await direct.db('admin').command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host }] } });
    }
  } finally { await direct.close(); }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 60000 });
  // Safe by the strict URI guard above; makes reruns independent.
  await mongoose.connection.dropDatabase();
  await ensureCriticalIndexes();
  await syncInstrumentCatalog();
  const specs = await Instrument.find({}).lean();
  assert.equal(specs.length, 300);
  for (const spec of specs) assert.equal(spec.defaultLeverage, ACG_LEVERAGE_BY_ASSET_CLASS[spec.assetClass]);
  checks.push('300 persisted catalog instruments use the class ceiling');
  const symbols = ['EURUSD', 'XAUUSD', 'US30', 'AAPL', 'BTCUSD'];
  // Use the actual first catalog index symbol if the display convention differs.
  symbols[2] = specs.find(s => s.assetClass === 'INDEX' && s.quoteCurrency === 'USD').symbol;
  for (const symbol of symbols) await Instrument.updateOne({ symbol }, { $set: { tradingSessions: [], executionEnabled: true,
    commissionPerLot: '0', commissionPerLotPerSide: '0', commissionRate: '0', spread: { mode: 'MARKET' } } });
  const bus = new EventEmitter();
  const quotes = new Map();
  const quoteStore = { get: symbol => { const q = quotes.get(symbol); return q ? { ...q, receivedAtMs: q.isStale ? 0 : Date.now() } : null; } };
  function tick(symbol, price, stale = false) { const q = { symbol, bid: price, ask: price, receivedAtMs: Date.now(), isStale: stale, sequence: Date.now(), source: 'PR72_CONTROLLED_FIXTURE' }; quotes.set(symbol, q); bus.emit('market.tick', q); }
  for (const symbol of symbols) tick(symbol, 100);
  const converter = new CurrencyConversionEngine({ quoteStore, symbols: ['EURUSD'] });
  setDefaultCurrencyConversionEngine(converter);
  const valuation = new ValuationEngine({ quoteStore, eventBus: bus, currencyConverter: converter });
  const queue = new AccountCommandQueue();
  const policy = new TradingPermissionPolicyService({ config: { newsEnforcementEnabled: false, weekendEnforcementEnabled: false, shadowEnabled: false } });
  const options = { quoteStore, eventBus: bus, commandQueue: queue, valuationEngine: valuation, tradingPermissionPolicyService: policy };
  const market = new MarketOrderService(options);
  const pending = new PendingOrderService(options);
  const engine = new PendingOrderEngine({ eventBus: bus, pendingOrderService: pending, logger: { info() {}, error() {} } });
  const runtime = { enabled: true, marketOrderService: market, pendingOrderService: pending,
    valuationEngine: valuation, tradingPermissionPolicyService: policy, positionProtectionService: new PositionProtectionService(options) };
  const app = express(); app.use(express.json());
  app.use('/trading', createTradingRouter(runtime, new AuthService())); app.use(errorHandler);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/trading`;
  const tenant = await Tenant.create({ name: 'PR72 acceptance', slug: 'pr72-acceptance' });
  const provisioner = new AccountControlService();
  let counter = 0;
  async function account(currency = 'USD', balance = '100000', accountType = 'DEMO') {
    const id = 'acceptance-' + ++counter;
    const provisioned = await provisioner.provision({ tenantId: String(tenant._id), externalRef: id, ownerExternalRef: id,
      accountType, currency, initialBalance: balance, leverage: 100, tradingPermissionsVersion: 1,
      tradingPermissions: { newsTrading: true, weekendHolding: true } });
    const a = provisioned.account;
    const token = 'acg_ts_' + crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000);
    await TraderSession.create({ tenantId: tenant._id, tokenHash: hashToken(token), authMethod: 'FEDERATED', ownerExternalRef: id,
      accountIds: [a.id], selectedAccountId: a.id, expiresAt, accessExpiresAt: expiresAt, idleExpiresAt: expiresAt });
    return { id: a.id, token };
  }
  async function request(a, route, body, expected = 201, method = 'POST') {
    const res = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + a.token },
      body: JSON.stringify({ accountId: a.id, ...body }) });
    const data = await res.json(); assert.equal(res.status, expected, JSON.stringify(data)); return data;
  }
  try {
    await valuation.start(); await engine.start();
    assert.equal((await fetch(base + '/orders/market', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    checks.push('unauthenticated trading request rejected');
    for (const symbol of symbols) {
      const a = await account();
      const opened = await request(a, '/orders/market', { clientOrderId: 'market', symbol, side: 'BUY', volume: '0.1' });
      const spec = specs.find(s => s.symbol === symbol);
      assert.equal(Number(opened.position.margin), 100 * Number(spec.contractSize) * 0.1 / spec.defaultLeverage);
      await request(a, '/positions/' + opened.position.id + '/protection', { clientRequestId: 'protect', stopLoss: '90', takeProfit: '110' }, 200, 'PATCH');
      await request(a, '/positions/' + opened.position.id + '/close', { clientOrderId: 'close' });
      checks.push(symbol + ': authenticated market margin, SL/TP edit and close');
    }
    const poor = await account('USD', '1');
    const rejected = await request(poor, '/orders/market', { clientOrderId: 'poor', symbol: 'BTCUSD', side: 'BUY', volume: '1' }, 409);
    assert.equal(rejected.error.code, 'INSUFFICIENT_MARGIN');
    assert.equal(await Position.countDocuments({ accountId: poor.id }), 0);
    checks.push('unaffordable order creates no position');

    // Real persisted legacy reservation, catalog update, valuation restart and partial close.
    const legacy = await account('USD', '10000', 'CHALLENGE');
    await Instrument.updateOne({ symbol: 'BTCUSD' }, { $set: { defaultLeverage: 100 } });
    const old = await request(legacy, '/orders/market', { clientOrderId: 'legacy', symbol: 'BTCUSD', side: 'BUY', volume: '1' });
    assert.equal(old.position.margin, '1');
    await enforceCatalogLeveragePolicy();
    await valuation.stop(); await valuation.start();
    const legacyState = await valuation.getOrLoadAccountSnapshot(legacy.id);
    assert.equal(legacyState.usedMargin, '1');
    assert.equal(shouldTriggerStopOut(legacyState), false);
    assert.equal(evaluateRiskContext({ equity: legacyState.equity, initialBalance: '10000', dailyStartEquity: '10000', dailyLossLimit: '500', maxLossLimit: '1000' }).breached, false);
    await request(legacy, '/positions/' + old.position.id + '/close', { clientOrderId: 'partial', volume: '0.5' });
    assert.equal((await Position.findById(old.position.id)).margin.toString(), '0.5');
    const fresh = await request(legacy, '/orders/market', { clientOrderId: 'new', symbol: 'BTCUSD', side: 'BUY', volume: '1' });
    assert.equal(fresh.position.margin, '50');
    checks.push('legacy margin survives catalog enforcement/recovery; partial close releases half; new exposure uses 2x');

    // Price stream is deterministic: creation happens before the trigger, then FX fails.
    for (const type of ['LIMIT', 'STOP', 'STOP_LIMIT']) {
      const a = await account('EUR'); tick('EURUSD', 2); tick('BTCUSD', 100);
      const prices = type === 'LIMIT' ? { limitPrice: '90' } : type === 'STOP' ? { stopPrice: '110' } : { stopPrice: '110', limitPrice: '115' };
      const created = await request(a, '/orders/pending', { clientOrderId: type, symbol: 'BTCUSD', side: 'BUY', type, volume: '1', ...prices });
      tick('EURUSD', 2, true); tick('BTCUSD', type === 'LIMIT' ? 90 : 110);
      await pause(500);
      assert.ok(['PENDING', 'TRIGGERED'].includes((await Order.findById(created.order.id)).status));
      assert.equal(await Position.countDocuments({ accountId: a.id }), 0);
      tick('EURUSD', 2); tick('BTCUSD', type === 'LIMIT' ? 90 : 110);
      await until(async () => (await Order.findById(created.order.id)).status === 'FILLED');
      tick('BTCUSD', type === 'LIMIT' ? 90 : 110); await pause(100);
      assert.equal(await Position.countDocuments({ accountId: a.id }), 1);
      assert.equal(await Deal.countDocuments({ accountId: a.id }), 1);
      checks.push(type + ': authenticated creation; FX outage blocks; recovery fills exactly once');
    }
    console.log(JSON.stringify({ result: 'PASS', commit: process.env.RAILWAY_GIT_COMMIT_SHA || null, controlledQuotes: true, checks }, null, 2));
  } finally {
    await engine.stop(); await valuation.stop();
    await new Promise(resolve => server.close(resolve));
    setDefaultCurrencyConversionEngine(null);
    await mongoose.disconnect();
  }
}
main().catch(async error => { console.error(JSON.stringify({ result: 'FAIL', checks, error: error.message, stack: error.stack })); await mongoose.disconnect(); process.exitCode = 1; });
