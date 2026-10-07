'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  projectAccountAfterClose,
} = require('../src/modules/trading/execution-planner');
const {
  applyCloseAccountAndPositionMutation,
} = require('../src/modules/trading/market-order.service');

class FakeLedger {
  constructor(value) {
    Object.assign(this, value);
  }
}

test('GM-001 full close removes marked P&L rather than realized P&L', () => {
  const projection = projectAccountAfterClose({
    account: {
      state: {
        balance: '10000',
        floatingPnl: '1.111111111111',
        equity: '10001.111111111111',
        usedMargin: '100',
      },
    },
    realizedPnl: '1',
    commission: '0',
    markedPnlRemoved: '1.111111111111',
    releasedMargin: '100',
  });

  assert.deepEqual(projection, {
    balance: '10001',
    floatingPnl: '0',
    equity: '10001',
    usedMargin: '0',
    freeMargin: '10001',
    marginLevel: null,
  });
});

test('GM-001 partial close preserves the remaining marked contribution', () => {
  const projection = projectAccountAfterClose({
    account: {
      state: {
        balance: '10000',
        floatingPnl: '20',
        equity: '10020',
        usedMargin: '200',
      },
    },
    realizedPnl: '9',
    commission: '1',
    markedPnlRemoved: '10',
    releasedMargin: '100',
  });

  assert.equal(projection.balance, '10008');
  assert.equal(projection.floatingPnl, '10');
  assert.equal(projection.equity, '10018');
  assert.equal(projection.usedMargin, '100');
  assert.equal(projection.freeMargin, '9918');
  assert.equal(projection.marginLevel, '10018');
});

test('GM-001 committed full close is flat: floating P&L zero and equity equals balance', () => {
  const account = {
    tenantId: 'tenant-1',
    _id: 'account-1',
    currency: 'USD',
    financialRevision: 7,
    state: {
      balance: '10000',
      floatingPnl: '1.111111111111',
      equity: '10001.111111111111',
      realizedPnlToday: '0',
      usedMargin: '100',
      freeMargin: '9901.111111111111',
      marginLevel: '10001.1111111111',
    },
  };
  const position = {
    openVolume: '10',
    margin: '100',
    realizedPnl: '0',
    commissionPaid: '0',
    status: 'OPEN',
    closedAt: null,
    closeReason: null,
  };
  const plan = {
    realizedPnl: '1',
    commission: '0',
    releasedMargin: '100',
    remainingVolume: '0',
    fullClose: true,
    projectedAccountState: {
      balance: '10001',
      floatingPnl: '0',
      equity: '10001',
      usedMargin: '0',
      freeMargin: '10001',
      marginLevel: null,
    },
  };

  const ledgers = applyCloseAccountAndPositionMutation({
    account,
    position,
    plan,
    deal: { dealId: 'deal-1' },
    clientOrderId: 'close-1',
    ledgerModel: FakeLedger,
    now: new Date('2026-10-07T00:00:00.000Z'),
    valuationComplete: true,
    closeReason: 'MANUAL',
  });

  assert.equal(account.financialRevision, 8);
  assert.equal(account.state.balance, '10001');
  assert.equal(account.state.floatingPnl, '0');
  assert.equal(account.state.equity, account.state.balance);
  assert.equal(account.state.usedMargin, '0');
  assert.equal(account.state.freeMargin, '10001');
  assert.equal(position.status, 'CLOSED');
  assert.equal(position.openVolume, '0');
  assert.equal(ledgers.length, 1);
  assert.equal(ledgers[0].type, 'REALIZED_PNL');
  assert.equal(ledgers[0].balanceAfter, '10001');
});


test('GM-002 loss-liability conversion uses the same FX side as a realized loss', () => {
  const { CurrencyConversionEngine } = require('../src/modules/trading/currency-conversion-engine');
  const engine = new CurrencyConversionEngine({
    symbols: ['USDINR'],
    maxQuoteAgeMs: 10000,
    quoteStore: {
      get(symbol) {
        if (symbol !== 'USDINR') return null;
        return {
          symbol,
          bid: 90,
          ask: 91,
          receivedAtMs: 1000,
          sequence: 7,
          source: 'TEST',
        };
      },
    },
  });

  const estimated = engine.convertWithEvidence('900', 'INR', 'USD', {
    nowMs: 1000,
    purpose: 'LOSS_LIABILITY',
  });
  const realized = engine.convert('-900', 'INR', 'USD', { nowMs: 1000 });

  assert.equal(estimated.amount, '10');
  assert.equal(realized, '-10');
  assert.equal(estimated.evidence.purpose, 'LOSS_LIABILITY');
  assert.equal(estimated.evidence.path.length, 1);
  assert.equal(estimated.evidence.path[0].symbol, 'USDINR');
  assert.equal(estimated.evidence.path[0].selectedSide, 'BID');
  assert.equal(estimated.evidence.path[0].operation, 'DIVIDE');
});

test('GM-002 stop-risk sizing uses loss-liability conversion semantics', () => {
  const { CurrencyConversionEngine } = require('../src/modules/trading/currency-conversion-engine');
  const { calculateStopRiskAmount } = require('../src/modules/trading/firm-risk-policy');
  const engine = new CurrencyConversionEngine({
    symbols: ['USDINR'],
    quoteStore: {
      get(symbol) {
        if (symbol !== 'USDINR') return null;
        return { bid: 90, ask: 91, receivedAtMs: 1000, source: 'TEST' };
      },
    },
  });

  const risk = calculateStopRiskAmount({
    account: { currency: 'USD', state: { equity: '10000' } },
    instrument: { contractSize: '1', pnlCurrency: 'INR', quoteCurrency: 'INR' },
    side: 'BUY',
    entryPrice: '100',
    volume: '10',
    stopLoss: '10',
    currencyConverter: engine,
    nowMs: 1000,
  });

  // INR 900 of downside uses the same USD/INR bid convention as INR -900 settlement.
  assert.equal(risk, '10');
});

test('GM-002 cross-currency zero still requires a usable FX dependency', () => {
  const { CurrencyConversionEngine } = require('../src/modules/trading/currency-conversion-engine');
  const engine = new CurrencyConversionEngine({
    symbols: ['USDINR'],
    quoteStore: { get() { return null; } },
  });

  assert.equal(engine.canConvert('INR', 'USD', { nowMs: 1000 }), false);
  assert.throws(
    () => engine.convert('0', 'INR', 'USD', { nowMs: 1000 }),
    error => error?.code === 'ACCOUNT_CURRENCY_CONVERSION_UNAVAILABLE',
  );
});


test('GM-002 financial conversion context keeps one FX snapshot across an attempt', () => {
  const { CurrencyConversionEngine } = require('../src/modules/trading/currency-conversion-engine');
  let quote = { bid: 90, ask: 91, receivedAtMs: 1000, sequence: 1, source: 'TEST' };
  const engine = new CurrencyConversionEngine({
    symbols: ['USDINR'],
    quoteStore: { get() { return quote; } },
  });
  const context = engine.createContext({ nowMs: 1000 });

  const first = context.convertWithEvidence('900', 'INR', 'USD', { purpose: 'LOSS_LIABILITY' });
  quote = { bid: 80, ask: 81, receivedAtMs: 1000, sequence: 2, source: 'TEST' };
  const second = context.convertWithEvidence('900', 'INR', 'USD', { purpose: 'LOSS_LIABILITY' });
  const freshAttempt = engine.createContext({ nowMs: 1000 })
    .convertWithEvidence('900', 'INR', 'USD', { purpose: 'LOSS_LIABILITY' });

  assert.equal(first.amount, '10');
  assert.equal(second.amount, '10');
  assert.equal(first.evidence.path[0].quoteSequence, 1);
  assert.equal(second.evidence.path[0].quoteSequence, 1);
  assert.equal(freshAttempt.amount, '11.25');
  assert.equal(freshAttempt.evidence.path[0].quoteSequence, 2);
});
