'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { QuoteStore } = require('../src/modules/market-data/quote-store');
const { CurrencyConversionEngine } = require('../src/modules/trading/currency-conversion-engine');
const { ValuationEngine } = require('../src/modules/trading/valuation-engine');

function query(value) {
  return { lean: async () => value };
}

function waitForEvent(emitter, name, predicate, timeoutMs = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(name, handler);
      reject(new Error(`Timed out waiting for ${name}`));
    }, timeoutMs);
    const handler = payload => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      emitter.off(name, handler);
      resolve(payload);
    };
    emitter.on(name, handler);
  });
}

test('GM-004/005 retains USDINR, expires without stock ticks, and recovers on quote-only FX', async () => {
  const eventBus = new EventEmitter();
  const quoteStore = new QuoteStore();
  const now = Date.now();

  quoteStore.set({
    symbol: 'RELIANCE',
    bid: 110,
    ask: 111,
    receivedAtMs: now,
    sequence: 1,
    source: 'STOCK_TEST',
    isStale: false,
  });
  quoteStore.set({
    symbol: 'USDINR',
    bid: 90,
    ask: 91,
    receivedAtMs: now,
    sequence: 1,
    source: 'FX_TEST',
    isStale: false,
  });

  const retained = new Map();
  const marketPriority = {
    retain(symbol) { retained.set(symbol, (retained.get(symbol) || 0) + 1); },
    release(symbol) { retained.set(symbol, Math.max(0, (retained.get(symbol) || 0) - 1)); },
  };

  const account = {
    _id: 'account-1',
    accountCode: 'ACG-1',
    currency: 'USD',
    financialRevision: 4,
    state: {
      balance: '10000',
      realizedPnlToday: '0',
      dailyStartEquity: '10000',
    },
  };
  const position = {
    _id: 'position-1',
    positionId: 'POS-1',
    accountId: 'account-1',
    symbol: 'RELIANCE',
    side: 'BUY',
    status: 'OPEN',
    openVolume: '10',
    entryPrice: '100',
    contractSize: '1',
    quoteCurrency: 'INR',
    margin: '100',
  };

  const converter = new CurrencyConversionEngine({
    quoteStore,
    symbols: ['USDINR'],
    maxQuoteAgeMs: 35,
  });
  const engine = new ValuationEngine({
    eventBus,
    quoteStore,
    currencyConverter: converter,
    marketPriority,
    accountModel: { find() { return query([account]); } },
    positionModel: { find() { return query([position]); } },
  });

  await engine.start();
  assert.equal(engine.getAccountSnapshot('account-1').valuationStatus, 'LIVE');
  assert.ok((retained.get('RELIANCE') || 0) > 0);
  assert.ok((retained.get('USDINR') || 0) > 0);
  assert.equal(retained.get('INRUSD') || 0, 0);

  const expired = await waitForEvent(
    eventBus,
    'valuation.account.updated',
    value => value.accountId === 'account-1' && value.valuationStatus === 'WAITING',
  );
  assert.equal(expired.complete, false);

  const recoveryPromise = waitForEvent(
    eventBus,
    'valuation.account.updated',
    value => value.accountId === 'account-1' && value.valuationStatus === 'LIVE',
  );
  const recoveredQuote = quoteStore.set({
    symbol: 'USDINR',
    bid: 90.1,
    ask: 90.2,
    receivedAtMs: Date.now(),
    sequence: 2,
    source: 'FX_TEST',
    isStale: false,
  });
  // Deliberately publish only market.quote. A stock tick must not be required.
  eventBus.emit('market.quote', recoveredQuote);
  const recovered = await recoveryPromise;
  assert.equal(recovered.complete, true);

  await engine.stop();
  assert.equal(retained.get('USDINR') || 0, 0);
  assert.equal(retained.get('RELIANCE') || 0, 0);
});

test('GM-004 conversion completeness is required even when native P&L is zero', async () => {
  const eventBus = new EventEmitter();
  const quoteStore = new QuoteStore();
  const now = Date.now();

  quoteStore.set({
    symbol: 'RELIANCE',
    bid: 100,
    ask: 101,
    receivedAtMs: now,
    sequence: 1,
    source: 'STOCK_TEST',
    isStale: false,
  });

  const account = {
    _id: 'account-zero',
    accountCode: 'ACG-ZERO',
    currency: 'USD',
    financialRevision: 1,
    state: { balance: '10000', realizedPnlToday: '0', dailyStartEquity: '10000' },
  };
  const position = {
    _id: 'position-zero',
    accountId: 'account-zero',
    symbol: 'RELIANCE',
    side: 'BUY',
    status: 'OPEN',
    openVolume: '10',
    entryPrice: '100',
    contractSize: '1',
    quoteCurrency: 'INR',
    margin: '100',
  };

  const engine = new ValuationEngine({
    eventBus,
    quoteStore,
    currencyConverter: new CurrencyConversionEngine({
      quoteStore,
      symbols: ['USDINR'],
      maxQuoteAgeMs: 1000,
    }),
    accountModel: { find() { return query([account]); } },
    positionModel: { find() { return query([position]); } },
  });

  await engine.start();
  const valuation = engine.getAccountSnapshot('account-zero');
  assert.equal(valuation.valuationStatus, 'WAITING');
  assert.equal(valuation.complete, false);
  assert.equal(valuation.equity, null);
  await engine.stop();
});


test('GM-004 rejects old FX source timestamps even with a fresh local receipt', () => {
  const { QuoteStore } = require('../src/modules/market-data/quote-store');
  const { CurrencyConversionEngine } = require('../src/modules/trading/currency-conversion-engine');
  const quoteStore = new QuoteStore();
  quoteStore.set({
    symbol: 'USDINR',
    bid: 90,
    ask: 90.1,
    providerTimestampMs: 1000,
    receivedAtMs: 10000,
    source: 'FX_TEST',
    isStale: false,
  });
  const engine = new CurrencyConversionEngine({
    quoteStore,
    symbols: ['USDINR'],
    maxQuoteAgeMs: 1000,
  });

  assert.throws(
    () => engine.convert('900', 'INR', 'USD', { nowMs: 10000 }),
    error => error?.code === 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE',
  );
});

test('GM-004 explicit approved FX fallback is usable only through its configured validity', () => {
  const { QuoteStore } = require('../src/modules/market-data/quote-store');
  const { CurrencyConversionEngine } = require('../src/modules/trading/currency-conversion-engine');
  const quoteStore = new QuoteStore();
  quoteStore.set({
    symbol: 'USDINR',
    bid: 90,
    ask: 91,
    providerTimestampMs: 1000,
    receivedAtMs: 1000,
    source: 'FALLBACK_TEST',
    isStale: true,
    fxValuationQuality: 'APPROVED_FALLBACK',
    approvedUntilMs: 20000,
  });
  const engine = new CurrencyConversionEngine({
    quoteStore,
    symbols: ['USDINR'],
    maxQuoteAgeMs: 1000,
  });

  const conversion = engine.convertWithEvidence('900', 'INR', 'USD', { nowMs: 15000 });
  assert.equal(conversion.amount, '9.89010989011');
  assert.equal(conversion.evidence.path[0].fxValuationQuality, 'APPROVED_FALLBACK');
  assert.equal(conversion.evidence.path[0].approvedUntilMs, 20000);
  assert.throws(
    () => engine.convert('900', 'INR', 'USD', { nowMs: 20001 }),
    error => error?.code === 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE',
  );
});

test('GM-004 rejects crossed FX quotes at the financial boundary', () => {
  const { QuoteStore } = require('../src/modules/market-data/quote-store');
  const { CurrencyConversionEngine } = require('../src/modules/trading/currency-conversion-engine');
  const quoteStore = new QuoteStore();
  quoteStore.set({
    symbol: 'USDINR',
    bid: 91,
    ask: 90,
    receivedAtMs: 1000,
    source: 'FX_TEST',
    isStale: false,
  });
  const engine = new CurrencyConversionEngine({ quoteStore, symbols: ['USDINR'] });
  assert.throws(
    () => engine.convert('900', 'INR', 'USD', { nowMs: 1000 }),
    error => error?.code === 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE',
  );
});
