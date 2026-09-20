'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { ValuationEngine } = require('../../src/modules/trading/valuation-engine');
const { CurrencyConversionEngine } = require('../../src/modules/trading/currency-conversion-engine');

function query(value) {
  return { lean: async () => value };
}

function fixture() {
  const account = {
    _id: 'a1',
    accountCode: 'A1',
    currency: 'USD',
    state: { balance: '10000', realizedPnlToday: '0', dailyStartEquity: '10000' },
  };
  const position = {
    _id: 'p1',
    positionId: 'pos-1',
    accountId: 'a1',
    symbol: 'EURUSD',
    side: 'BUY',
    status: 'OPEN',
    openVolume: '1',
    entryPrice: '1.1000',
    contractSize: '100000',
    volumeStep: '0.01',
    quoteCurrency: 'USD',
    margin: '1100',
  };
  const quotes = new Map([['EURUSD', {
    symbol: 'EURUSD', bid: 1.101, ask: 1.1012, sequence: 1, receivedAtMs: 1000, source: 'test', isStale: false,
  }]]);
  const eventBus = new EventEmitter();
  const engine = new ValuationEngine({
    eventBus,
    quoteStore: { get: symbol => quotes.get(symbol) || null },
    logger: { info() {}, error() {} },
    positionModel: { find: () => query([position]) },
    accountModel: {
      find: () => query([account]),
      findById: () => query(account),
    },
  });
  return { account, position, quotes, eventBus, engine };
}

test('recovers open positions and builds account valuation from current QuoteStore state', async () => {
  const { engine } = fixture();
  await engine.start();
  const snapshot = engine.getAccountSnapshot('a1');
  assert.equal(snapshot.valuationStatus, 'LIVE');
  assert.equal(snapshot.floatingPnl, '100');
  assert.equal(snapshot.equity, '10100');
  assert.equal(snapshot.usedMargin, '1100');
  assert.equal(snapshot.freeMargin, '9000');
  await engine.stop();
});

test('canonical market ticks revalue positions and accounts without Mongo writes', async () => {
  const { engine, eventBus } = fixture();
  await engine.start();
  let accountEvent = null;
  eventBus.on('valuation.account.updated', value => { accountEvent = value; });
  eventBus.emit('market.tick', {
    symbol: 'EURUSD', bid: 1.102, ask: 1.1022, sequence: 2, receivedAtMs: 2000, source: 'test', isStale: false,
  });
  assert.equal(engine.getPositionSnapshot('p1').floatingPnl, '200');
  assert.equal(engine.getAccountSnapshot('a1').equity, '10200');
  assert.equal(accountEvent.equity, '10200');
  await engine.stop();
});

test('stale quote transitions pause new-exposure readiness while preserving last numeric PnL', async () => {
  const { engine, eventBus } = fixture();
  await engine.start();
  eventBus.emit('market.quote', {
    symbol: 'EURUSD', bid: 1.101, ask: 1.1012, sequence: 1, receivedAtMs: 1000, source: 'test', isStale: true,
  });
  const snapshot = engine.getAccountSnapshot('a1');
  assert.equal(snapshot.valuationStatus, 'STALE');
  assert.equal(snapshot.equity, '10100');

  const accountDoc = {
    _id: 'a1',
    currency: 'USD',
    state: { balance: '10000', floatingPnl: '0', equity: '10000', usedMargin: '1100', freeMargin: '8900' },
  };
  assert.throws(
    () => engine.overlayAccountDocument(accountDoc, { requireLive: true }),
    error => error.code === 'ACCOUNT_VALUATION_NOT_LIVE',
  );
  await engine.stop();
});

test('execution overlay replaces stale persisted account metrics with current live valuation', async () => {
  const { engine } = fixture();
  await engine.start();
  const accountDoc = {
    _id: 'a1',
    currency: 'USD',
    state: { balance: '10000', floatingPnl: '-999', equity: '9001', usedMargin: '9999', freeMargin: '-998' },
  };
  const projection = engine.overlayAccountDocument(accountDoc, { requireLive: true });
  assert.equal(projection.valuationStatus, 'LIVE');
  assert.equal(String(accountDoc.state.floatingPnl), '100');
  assert.equal(String(accountDoc.state.equity), '10100');
  assert.equal(String(accountDoc.state.usedMargin), '1100');
  assert.equal(String(accountDoc.state.freeMargin), '9000');
  await engine.stop();
});

test('post-commit position/account events update the in-memory indexes before the next account command', async () => {
  const { engine, eventBus } = fixture();
  await engine.start();
  eventBus.emit('trading.position.closed', { id: 'p1', accountId: 'a1', symbol: 'EURUSD', status: 'CLOSED' });
  eventBus.emit('trading.account.updated', {
    id: 'a1', accountCode: 'A1', currency: 'USD', state: { balance: '10100', realizedPnlToday: '100', dailyStartEquity: '10000' },
  });
  const snapshot = engine.getAccountSnapshot('a1');
  assert.equal(snapshot.positionCount, 0);
  assert.equal(snapshot.floatingPnl, '0');
  assert.equal(snapshot.equity, '10100');
  assert.equal(snapshot.usedMargin, '0');
  await engine.stop();
});


test('flat accounts do not emit valuation updates on subsequent market ticks', async () => {
  const { engine, eventBus } = fixture();
  await engine.start();

  eventBus.emit('trading.position.closed', { id: 'p1', accountId: 'a1', symbol: 'EURUSD', status: 'CLOSED' });
  eventBus.emit('trading.account.updated', {
    id: 'a1',
    accountCode: 'A1',
    currency: 'USD',
    state: { balance: '10100', realizedPnlToday: '100', dailyStartEquity: '10000' },
  });

  let accountEvents = 0;
  eventBus.on('valuation.account.updated', () => { accountEvents += 1; });

  eventBus.emit('market.tick', {
    symbol: 'EURUSD',
    bid: 1.103,
    ask: 1.1032,
    sequence: 3,
    receivedAtMs: 3000,
    source: 'test',
    isStale: false,
  });

  assert.equal(accountEvents, 0);
  assert.equal(engine.getAccountSnapshot('a1').positionCount, 0);
  assert.equal(engine.getAccountSnapshot('a1').floatingPnl, '0');
  assert.equal(engine.getAccountSnapshot('a1').equity, '10100');

  await engine.stop();
});


test('startup recovery uses a trusted $in selector for account ids', async () => {
  const account = {
    _id: 'a1',
    accountCode: 'A1',
    currency: 'USD',
    state: { balance: '10000', realizedPnlToday: '0', dailyStartEquity: '10000' },
  };
  const position = {
    _id: 'p1',
    positionId: 'pos-1',
    accountId: 'a1',
    symbol: 'EURUSD',
    side: 'BUY',
    status: 'OPEN',
    openVolume: '1',
    entryPrice: '1.1000',
    contractSize: '100000',
    volumeStep: '0.01',
    quoteCurrency: 'USD',
    margin: '1100',
  };

  let capturedFilter = null;
  const engine = new ValuationEngine({
    eventBus: new EventEmitter(),
    quoteStore: { get: () => null },
    logger: { info() {}, error() {} },
    positionModel: { find: () => query([position]) },
    accountModel: {
      find: filter => {
        capturedFilter = filter;
        return query([account]);
      },
      findById: () => query(account),
    },
  });

  await engine.start();
  assert.deepEqual(capturedFilter?._id?.$in, ['a1']);
  assert.equal(capturedFilter?._id?.$eq, undefined);
  await engine.stop();
});


test('conversion-pair ticks revalue cross-currency accounts immediately', async () => {
  const account = {
    _id: 'a1',
    accountCode: 'A1',
    currency: 'EUR',
    state: { balance: '10000', realizedPnlToday: '0', dailyStartEquity: '10000' },
  };
  const position = {
    _id: 'p1',
    positionId: 'pos-1',
    accountId: 'a1',
    symbol: 'XAUUSD',
    side: 'BUY',
    status: 'OPEN',
    openVolume: '1',
    entryPrice: '2000',
    contractSize: '100',
    volumeStep: '0.01',
    quoteCurrency: 'USD',
    margin: '1500',
  };
  const now = Date.now();
  const quotes = new Map([
    ['XAUUSD', { symbol: 'XAUUSD', bid: 2001, ask: 2001.2, sequence: 1, receivedAtMs: now, source: 'test', isStale: false }],
    ['EURUSD', { symbol: 'EURUSD', bid: 1.1, ask: 1.2, sequence: 1, receivedAtMs: now, source: 'test', isStale: false }],
  ]);
  const eventBus = new EventEmitter();
  const converter = new CurrencyConversionEngine({
    quoteStore: { get: symbol => quotes.get(symbol) || null },
    symbols: [...quotes.keys()],
    maxQuoteAgeMs: 5000,
  });
  const engine = new ValuationEngine({
    eventBus,
    quoteStore: { get: symbol => quotes.get(symbol) || null },
    currencyConverter: converter,
    logger: { info() {}, error() {} },
    positionModel: { find: () => query([position]) },
    accountModel: {
      find: () => query([account]),
      findById: () => query(account),
    },
  });

  await engine.start();
  assert.equal(engine.getAccountSnapshot('a1').floatingPnl, '83.333333333333');

  const updated = { symbol: 'EURUSD', bid: 1.0, ask: 1.0, sequence: 2, receivedAtMs: Date.now(), source: 'test', isStale: false };
  quotes.set('EURUSD', updated);
  eventBus.emit('market.tick', updated);

  assert.equal(engine.getAccountSnapshot('a1').floatingPnl, '100');
  assert.equal(engine.getAccountSnapshot('a1').equity, '10100');
  await engine.stop();
});

test('stale conversion quotes immediately make cross-currency account valuation incomplete', async () => {
  const account = {
    _id: 'a1',
    accountCode: 'A1',
    currency: 'EUR',
    state: { balance: '10000', realizedPnlToday: '0', dailyStartEquity: '10000' },
  };
  const position = {
    _id: 'p1',
    positionId: 'pos-1',
    accountId: 'a1',
    symbol: 'XAUUSD',
    side: 'BUY',
    status: 'OPEN',
    openVolume: '1',
    entryPrice: '2000',
    contractSize: '100',
    volumeStep: '0.01',
    quoteCurrency: 'USD',
    margin: '1500',
  };
  const now = Date.now();
  const quotes = new Map([
    ['XAUUSD', { symbol: 'XAUUSD', bid: 2001, ask: 2001.2, sequence: 1, receivedAtMs: now, source: 'test', isStale: false }],
    ['EURUSD', { symbol: 'EURUSD', bid: 1.1, ask: 1.2, sequence: 1, receivedAtMs: now, source: 'test', isStale: false }],
  ]);
  const eventBus = new EventEmitter();
  const converter = new CurrencyConversionEngine({
    quoteStore: { get: symbol => quotes.get(symbol) || null },
    symbols: [...quotes.keys()],
    maxQuoteAgeMs: 5000,
  });
  const engine = new ValuationEngine({
    eventBus,
    quoteStore: { get: symbol => quotes.get(symbol) || null },
    currencyConverter: converter,
    logger: { info() {}, error() {} },
    positionModel: { find: () => query([position]) },
    accountModel: {
      find: () => query([account]),
      findById: () => query(account),
    },
  });

  await engine.start();
  const stale = { ...quotes.get('EURUSD'), isStale: true, receivedAtMs: Date.now() };
  quotes.set('EURUSD', stale);
  eventBus.emit('market.quote', stale);

  const snapshot = engine.getAccountSnapshot('a1');
  assert.equal(snapshot.valuationStatus, 'WAITING');
  assert.equal(snapshot.complete, false);
  assert.equal(snapshot.equity, null);
  await engine.stop();
});
