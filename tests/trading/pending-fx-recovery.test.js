'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const { PendingOrderService } = require('../../src/modules/trading/pending-order.service');
const { PendingOrderEngine } = require('../../src/modules/trading/pending-order-engine');
const { CurrencyConversionEngine, setDefaultCurrencyConversionEngine } = require('../../src/modules/trading/currency-conversion-engine');

// Real planner, converter, service, queue and engine; persistence is in memory.
function fixture(t, { type = 'LIMIT', status = 'PENDING', balance = '10000' } = {}) {
  const bus = new EventEmitter();
  const positions = [], deals = [], errors = [];
  let fx = null;
  const converter = new CurrencyConversionEngine({ quoteStore: { get: () => fx }, symbols: ['EURUSD'], maxQuoteAgeMs: 1000 });
  setDefaultCurrencyConversionEngine(converter);
  t.after(() => setDefaultCurrencyConversionEngine(null));
  const account = { _id: 'account', accountType: 'DEMO', status: 'ACTIVE', tradingEnabled: true,
    currency: 'EUR', leverage: 100, riskPolicy: {}, state: { balance, equity: balance, freeMargin: balance,
      floatingPnl: '0', usedMargin: '0' }, async save() {} };
  const instrument = { symbol: 'BTCUSD', assetClass: 'CRYPTO', status: 'ACTIVE', executionEnabled: true,
    quoteCurrency: 'USD', marginCurrency: 'USD', contractSize: '1', tickSize: '0.01',
    minVolume: '0.01', maxVolume: '100', volumeStep: '0.01', defaultLeverage: 2,
    commissionPerLot: '0', tradingSessions: [], maxQuoteAgeMs: 10000 };
  const order = { _id: 'order', orderId: 'ord-1', accountId: 'account', symbol: 'BTCUSD', side: 'BUY', type, status,
    requestedVolume: '1', filledVolume: '0', limitPrice: '110', stopPrice: '90', expiresAt: null,
    saves: 0, async save() { this.saves++; } };
  const query = value => ({ session: async () => value });
  const orderModel = { findById: () => query(order), find: filter => ({ lean: async () => order.status === filter.status ? [order] : [] }) };
  const model = rows => class { constructor(data) { Object.assign(this, data); this._id = 'row-' + rows.length; }
    static find() { return { select: () => ({ lean: async () => rows }) }; }
    async save() { rows.push(this); } };
  const service = new PendingOrderService({ eventBus: bus, accountModel: { findById: () => query(account) },
    instrumentModel: { findOne: () => query(instrument) }, orderModel, positionModel: model(positions), dealModel: model(deals),
    runTransaction: async work => work(null) });
  const engine = new PendingOrderEngine({ eventBus: bus, pendingOrderService: service, orderModel,
    expiryCheckMs: 60000, logger: { info() {}, error(data) { errors.push(data.err.code); } } });
  t.after(() => engine.stop());
  const tick = (ask = 100) => ({ symbol: 'BTCUSD', bid: ask, ask, isStale: false, receivedAtMs: Date.now() });
  const run = (ask = 100) => service.executePendingOrder({ accountId: 'account', orderId: 'order', tick: tick(ask) });
  const recover = () => { fx = { bid: 2, ask: 2, receivedAtMs: Date.now(), isStale: false }; };
  const stale = () => { fx = { bid: 2, ask: 2, receivedAtMs: Date.now() - 10000, isStale: false }; };
  return { bus, service, engine, order, account, positions, deals, errors, tick, run, recover, stale };
}

for (const [type, status] of [['LIMIT', 'PENDING'], ['STOP', 'PENDING'], ['STOP_LIMIT', 'TRIGGERED']]) {
  test(`${type}: missing and stale FX preserve order; recovery fills once at current leverage`, async t => {
    const f = fixture(t, { type, status });
    for (const unavailable of [() => {}, f.stale]) {
      unavailable();
      await assert.rejects(f.run(), { code: 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE' });
      assert.equal(f.order.status, status);
      assert.equal(f.order.saves, 0);
      assert.equal(f.positions.length, 0);
      assert.equal(f.deals.length, 0);
      assert.equal(f.account.state.usedMargin, '0');
    }
    f.recover();
    const results = await Promise.all([f.run(), f.run()]);
    assert.equal(results.filter(r => r.operation === 'PENDING_FILL').length, 1);
    assert.equal(f.positions.length, 1);
    assert.equal(f.deals.length, 1);
    assert.equal(f.positions[0].margin, '25'); // $100 / 2 leverage / 2 EURUSD
    assert.equal(f.order.status, 'FILLED');
  });
}

test('FX outage then cancellation or expiry cannot create exposure', async t => {
  for (const terminal of ['CANCELLED', 'EXPIRED']) {
    const f = fixture(t);
    await assert.rejects(f.run(), { code: 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE' });
    if (terminal === 'CANCELLED') f.order.status = 'CANCELLED';
    else f.order.expiresAt = new Date(Date.now() - 1);
    f.recover();
    await f.run();
    assert.equal(f.order.status, terminal);
    assert.equal(f.positions.length, 0);
    assert.equal(f.deals.length, 0);
  }
});

test('retry rechecks LIMIT/STOP conditions and STOP_LIMIT limit price', async t => {
  for (const [type, status, movedPrice] of [['LIMIT', 'PENDING', 120], ['STOP', 'PENDING', 80], ['STOP_LIMIT', 'TRIGGERED', 120]]) {
    const f = fixture(t, { type, status });
    await assert.rejects(f.run(), { code: 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE' });
    f.recover();
    assert.equal((await f.run(movedPrice)).skipped, true);
    assert.equal(f.positions.length, 0);
    assert.equal(f.order.status, status);
  }
});

test('insufficient margin remains a permanent rejection after FX recovery', async t => {
  const f = fixture(t, { balance: '10' });
  await assert.rejects(f.run(), { code: 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE' });
  f.recover();
  assert.equal((await f.run()).operation, 'PENDING_REJECT');
  assert.equal(f.order.rejectCode, 'INSUFFICIENT_MARGIN');
  assert.equal(f.positions.length, 0);
});

test('engine retains blocked order, recovers it after restart, and retries on a qualifying tick', async t => {
  const f = fixture(t);
  await f.engine.start();
  f.bus.emit('market.tick', f.tick());
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.errors, ['ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE']);
  assert.equal(f.engine.health().pendingOrders, 1);
  await f.engine.stop();
  f.recover();
  await f.engine.start();
  f.bus.emit('market.tick', f.tick());
  f.bus.emit('market.tick', f.tick());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.positions.length, 1);
  assert.equal(f.engine.health().pendingOrders, 0);
});
