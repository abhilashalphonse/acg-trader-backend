'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { planMarketOpen, planMarketClose, calculateAdverseSlippage } = require('../../src/modules/trading/execution-planner');
const { loadOpenExposure } = require('../../src/modules/trading/market-order.service');

function account(overrides = {}) {
  return {
    _id: '507f1f77bcf86cd799439011',
    status: 'ACTIVE',
    tradingEnabled: true,
    currency: 'USD',
    leverage: 100,
    riskPolicy: { allowedSymbols: [] },
    state: {
      balance: '100000',
      equity: '100000',
      freeMargin: '100000',
      usedMargin: '0',
      realizedPnlToday: '0',
    },
    ...overrides,
  };
}

function instrument(overrides = {}) {
  return {
    symbol: 'EURUSD',
    status: 'ACTIVE',
    executionEnabled: true,
    quoteCurrency: 'USD',
    tickSize: '0.00001',
    minVolume: '0.01',
    maxVolume: '100',
    volumeStep: '0.01',
    contractSize: '100000',
    defaultLeverage: 100,
    marginRate: null,
    commissionPerLot: '0',
    maxQuoteAgeMs: 5000,
    ...overrides,
  };
}

function quote(overrides = {}) {
  return {
    symbol: 'EURUSD',
    bid: 1.09995,
    ask: 1.10005,
    sequence: 42,
    receivedAtMs: 10_000,
    isStale: false,
    ...overrides,
  };
}

test('market BUY fills at ask and reserves exact margin', () => {
  const plan = planMarketOpen({
    account: account(),
    instrument: instrument(),
    quote: quote(),
    side: 'BUY',
    volume: '1',
    nowMs: 10_100,
  });

  assert.equal(plan.fillPrice, '1.10005');
  assert.equal(plan.requiredMargin, '1100.05');
  assert.equal(plan.commission, '0');
  assert.equal(plan.quoteSequence, 42);
});

test('market SELL fills at bid and applies per-lot commission', () => {
  const plan = planMarketOpen({
    account: account(),
    instrument: instrument({ commissionPerLot: '3.5' }),
    quote: quote(),
    side: 'SELL',
    volume: '0.5',
    nowMs: 10_100,
  });

  assert.equal(plan.fillPrice, '1.09995');
  assert.equal(plan.commission, '1.75');
  assert.equal(plan.requiredMargin, '549.975');
});

test('dynamic execution applies volume-band price adjustment and explicit per-side commission', () => {
  const plan = planMarketOpen({
    account: account(),
    instrument: instrument({
      commissionPerLot: '0',
      commissionPerLotPerSide: '2.5',
      spread: {
        volumeBands: [
          { upTo: '1', extraPoints: '0' },
          { upTo: '5', extraPoints: '2' },
        ],
      },
    }),
    quote: quote({ ask: 1.10005, bid: 1.09995, spreadPoints: 10, pricingModel: 'ACG_DYNAMIC' }),
    side: 'BUY',
    volume: '2',
    nowMs: 10_100,
  });

  assert.equal(plan.fillPrice, '1.10007');
  assert.equal(plan.commission, '5');
  assert.equal(plan.liquidityAdjustmentPoints, '2');
  assert.equal(plan.volumeBand, 'UP_TO_5');
  assert.equal(plan.pricingModel, 'ACG_DYNAMIC');
});

test('market execution rejects stale quotes and disabled instruments', () => {
  assert.throws(
    () => planMarketOpen({ account: account(), instrument: instrument(), quote: quote({ isStale: true }), side: 'BUY', volume: '1', nowMs: 10_100 }),
    error => error.code === 'QUOTE_STALE',
  );
  assert.throws(
    () => planMarketOpen({ account: account(), instrument: instrument({ executionEnabled: false }), quote: quote(), side: 'BUY', volume: '1', nowMs: 10_100 }),
    error => error.code === 'INSTRUMENT_EXECUTION_DISABLED',
  );
});

test('market execution enforces volume steps and free margin', () => {
  assert.throws(
    () => planMarketOpen({ account: account(), instrument: instrument(), quote: quote(), side: 'BUY', volume: '0.015', nowMs: 10_100 }),
    error => error.code === 'INVALID_VOLUME_STEP',
  );
  assert.throws(
    () => planMarketOpen({
      account: account({
        riskPolicy: {
          allowedSymbols: [],
          maxMarginUsagePercent: '0',
          maxSingleOrderMarginPercentOfFree: '0',
          maxSymbolMarginPercentOfPermitted: '0',
        },
        state: { ...account().state, usedMargin: '99900', freeMargin: '100' },
      }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '1',
      nowMs: 10_100,
    }),
    error => error.code === 'INSUFFICIENT_MARGIN',
  );
});

test('protection prices must be on the correct side of the fill', () => {
  assert.throws(
    () => planMarketOpen({ account: account(), instrument: instrument(), quote: quote(), side: 'BUY', volume: '1', stopLoss: '1.10100', nowMs: 10_100 }),
    error => error.code === 'INVALID_PROTECTION_PRICE',
  );

  const plan = planMarketOpen({
    account: account(),
    instrument: instrument(),
    quote: quote(),
    side: 'BUY',
    volume: '1',
    stopLoss: '1.09010',
    takeProfit: '1.12000',
    nowMs: 10_100,
  });
  assert.equal(plan.stopLoss, '1.0901');
  assert.equal(plan.takeProfit, '1.12');
});

test('partial close of a long uses bid, realizes PnL and releases proportional margin', () => {
  const position = {
    _id: '507f191e810c19729de860ea',
    accountId: '507f1f77bcf86cd799439011',
    symbol: 'EURUSD',
    side: 'BUY',
    status: 'OPEN',
    openVolume: '1',
    entryPrice: '1.10005',
    contractSize: '100000',
    volumeStep: '0.01',
    quoteCurrency: 'USD',
    margin: '1100.05',
  };
  const plan = planMarketClose({
    account: account(),
    instrument: instrument(),
    quote: quote({ bid: 1.10105, ask: 1.10115 }),
    position,
    volume: '0.4',
    nowMs: 10_100,
  });

  assert.equal(plan.fillPrice, '1.10105');
  assert.equal(plan.realizedPnl, '40');
  assert.equal(plan.remainingVolume, '0.6');
  assert.equal(plan.releasedMargin, '440.02');
  assert.equal(plan.dealType, 'PARTIAL_CLOSE');
});

test('full close of a short uses ask and releases all remaining margin', () => {
  const position = {
    _id: '507f191e810c19729de860ea',
    accountId: '507f1f77bcf86cd799439011',
    symbol: 'EURUSD',
    side: 'SELL',
    status: 'OPEN',
    openVolume: '0.5',
    entryPrice: '1.105',
    contractSize: '100000',
    volumeStep: '0.01',
    quoteCurrency: 'USD',
    margin: '552.5',
  };
  const plan = planMarketClose({
    account: account(),
    instrument: instrument(),
    quote: quote({ bid: 1.09995, ask: 1.10005 }),
    position,
    nowMs: 10_100,
  });

  assert.equal(plan.fillPrice, '1.10005');
  assert.equal(plan.realizedPnl, '247.5');
  assert.equal(plan.remainingVolume, '0');
  assert.equal(plan.releasedMargin, '552.5');
  assert.equal(plan.dealType, 'CLOSE');
});

test('adverse slippage is positive when the fill is worse for either side', () => {
  assert.equal(calculateAdverseSlippage({ side: 'BUY', fillPrice: '1.1001', requestedPrice: '1.1' }), '0.0001');
  assert.equal(calculateAdverseSlippage({ side: 'SELL', fillPrice: '1.0999', requestedPrice: '1.1' }), '0.0001');
});


test('market execution enforces maximum open positions', () => {
  assert.throws(
    () => planMarketOpen({
      account: account({ riskPolicy: { allowedSymbols: [], maxOpenPositions: 2 } }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '1',
      exposure: { currentOpenPositions: 2, currentTotalVolume: '1.5' },
      nowMs: 10_100,
    }),
    error => error.code === 'MAX_OPEN_POSITIONS',
  );
});

test('market execution enforces maximum total volume', () => {
  assert.throws(
    () => planMarketOpen({
      account: account({ riskPolicy: { allowedSymbols: [], maxTotalVolume: '2' } }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '0.6',
      exposure: { currentOpenPositions: 2, currentTotalVolume: '1.5' },
      nowMs: 10_100,
    }),
    error => error.code === 'MAX_TOTAL_VOLUME_REACHED',
  );
});


test('market execution accepts a quote past soft recovery age but inside the hard cutoff', () => {
  const plan = planMarketOpen({
    account: account(),
    instrument: instrument({ softQuoteAgeMs: 1000, maxQuoteAgeMs: 5000 }),
    quote: quote({ receivedAtMs: 7000, isStale: false }),
    side: 'BUY',
    volume: '1',
    nowMs: 10_100,
  });
  assert.equal(plan.fillPrice, '1.10005');
});

test('market execution still blocks beyond the hard quote cutoff', () => {
  assert.throws(
    () => planMarketOpen({
      account: account(),
      instrument: instrument({ softQuoteAgeMs: 1000, maxQuoteAgeMs: 5000 }),
      quote: quote({ receivedAtMs: 4000, isStale: false }),
      side: 'BUY',
      volume: '1',
      nowMs: 10_100,
    }),
    error => error.code === 'QUOTE_STALE' && error.details.maxAgeMs === 5000,
  );
});


test('market execution rejects non-positive and crossed executable books', () => {
  for (const badQuote of [
    quote({ bid: 0, ask: 1.1 }),
    quote({ bid: 1.1, ask: 0 }),
    quote({ bid: 1.101, ask: 1.1 }),
  ]) {
    assert.throws(
      () => planMarketOpen({
        account: account(),
        instrument: instrument(),
        quote: badQuote,
        side: 'BUY',
        volume: '1',
        nowMs: 10_100,
      }),
      error => error.code === 'EXECUTABLE_QUOTE_UNAVAILABLE',
    );
  }
});


test('standard accounts do not receive hidden margin exposure caps', () => {
  const plan = planMarketOpen({
    account: account({ riskPolicy: { allowedSymbols: [] } }),
    instrument: instrument(),
    quote: quote({ bid: 1.14469, ask: 1.14471 }),
    side: 'SELL',
    volume: '15.2',
    stopLoss: '1.14502',
    takeProfit: '1.14278',
    exposure: {
      currentOpenPositions: 0,
      currentSymbolPositions: 0,
      currentTotalVolume: '0',
      currentSymbolVolume: '0',
      currentSymbolMargin: '0',
      currentOpenRisk: '0',
      unmeasuredRiskPositions: 0,
    },
    nowMs: 10_100,
  });

  assert.equal(plan.requiredMargin, '17399.288');
});

test('Funded explicit null margin policies do not inherit hidden platform exposure caps', () => {
  const fundedAccount = account({
    riskPolicy: {
      allowedSymbols: [],
      maxMarginUsagePercent: null,
      maxSingleOrderMarginPercentOfFree: null,
      maxSymbolMarginPercentOfPermitted: null,
    },
  });

  const plan = planMarketOpen({
    account: fundedAccount,
    instrument: instrument(),
    quote: quote({ bid: 1.14469, ask: 1.14471 }),
    side: 'SELL',
    volume: '15.2',
    stopLoss: '1.14502',
    takeProfit: '1.14278',
    exposure: {
      currentOpenPositions: 0,
      currentSymbolPositions: 0,
      currentTotalVolume: '0',
      currentSymbolVolume: '0',
      currentSymbolMargin: '0',
      currentOpenRisk: '0',
      unmeasuredRiskPositions: 0,
    },
    nowMs: 10_100,
  });

  assert.equal(plan.fillPrice, '1.14469');
  assert.equal(plan.requiredMargin, '17399.288');
  assert.equal(plan.stopLoss, '1.14502');
  assert.equal(plan.takeProfit, '1.14278');
});

test('explicit null margin policy does not disable standard position-count safeguards', () => {
  assert.throws(
    () => planMarketOpen({
      account: account({
        riskPolicy: {
          allowedSymbols: [],
          maxPositionsPerSymbol: null,
          maxMarginUsagePercent: null,
          maxSingleOrderMarginPercentOfFree: null,
          maxSymbolMarginPercentOfPermitted: null,
        },
      }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '1',
      exposure: {
        currentOpenPositions: 3,
        currentSymbolPositions: 3,
        currentTotalVolume: '3',
        currentSymbolVolume: '3',
        currentSymbolMargin: '3300',
        currentOpenRisk: '0',
        unmeasuredRiskPositions: 3,
      },
      nowMs: 10_100,
    }),
    error => error.code === 'MAX_SYMBOL_POSITIONS',
  );
});

test('standard risk policy never forces a stop loss', () => {
  assert.doesNotThrow(() => planMarketOpen({
    account: account({ riskPolicy: { allowedSymbols: [] } }),
    instrument: instrument(),
    quote: quote(),
    side: 'BUY',
    volume: '1',
    nowMs: 10_100,
  }));
});

test('server risk policy rejects per-position and per-trade risk excess', () => {
  assert.throws(
    () => planMarketOpen({
      account: account({ riskPolicy: { allowedSymbols: [], maxPositionVolume: '0.5' } }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '1',
      stopLoss: '1.09',
      nowMs: 10_100,
    }),
    error => error.code === 'MAX_POSITION_VOLUME_REACHED',
  );

  assert.throws(
    () => planMarketOpen({
      account: account({ riskPolicy: { allowedSymbols: [], maxRiskPerTradePercent: '1' } }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '1',
      stopLoss: '1.08',
      nowMs: 10_100,
    }),
    error => error.code === 'MAX_TRADE_RISK',
  );
});

test('server risk policy rejects projected symbol volume and aggregate stop risk', () => {
  assert.throws(
    () => planMarketOpen({
      account: account({ riskPolicy: { allowedSymbols: [], maxSymbolVolume: '1.5' } }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '1',
      stopLoss: '1.099',
      exposure: { currentOpenPositions: 1, currentTotalVolume: '1', currentSymbolVolume: '1', currentOpenRisk: '0', unmeasuredRiskPositions: 0 },
      nowMs: 10_100,
    }),
    error => error.code === 'MAX_SYMBOL_VOLUME_REACHED',
  );

  assert.throws(
    () => planMarketOpen({
      account: account({ riskPolicy: { allowedSymbols: [], maxAggregateRiskPercent: '1.5' } }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '1',
      stopLoss: '1.095',
      exposure: { currentOpenPositions: 1, currentTotalVolume: '1', currentSymbolVolume: '1', currentOpenRisk: '1000', unmeasuredRiskPositions: 0 },
      nowMs: 10_100,
    }),
    error => error.code === 'MAX_AGGREGATE_RISK',
  );
});


test('standard ACG policy enforces position, margin and exposure caps', () => {
  assert.throws(
    () => planMarketOpen({
      account: account({ riskPolicy: { allowedSymbols: [], maxPositionsPerSymbol: 3 } }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '1',
      exposure: { currentOpenPositions: 3, currentSymbolPositions: 3, currentTotalVolume: '3', currentSymbolVolume: '3', currentSymbolMargin: '3300', currentOpenRisk: '0', unmeasuredRiskPositions: 3 },
      nowMs: 10_100,
    }),
    error => error.code === 'MAX_SYMBOL_POSITIONS',
  );

  assert.throws(
    () => planMarketOpen({
      account: account({ state: { ...account().state, usedMargin: '49000', freeMargin: '51000' }, riskPolicy: { allowedSymbols: [], maxMarginUsagePercent: '50', maxSingleOrderMarginPercentOfFree: '100', maxSymbolMarginPercentOfPermitted: '100' } }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '1',
      exposure: { currentOpenPositions: 1, currentSymbolPositions: 0, currentTotalVolume: '1', currentSymbolVolume: '0', currentSymbolMargin: '0', currentOpenRisk: '0', unmeasuredRiskPositions: 1 },
      nowMs: 10_100,
    }),
    error => error.code === 'MAX_MARGIN_USAGE',
  );

  assert.throws(
    () => planMarketOpen({
      account: account({ riskPolicy: { allowedSymbols: [], maxSingleOrderMarginPercentOfFree: '1', maxSymbolMarginPercentOfPermitted: '100' } }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '1',
      exposure: { currentOpenPositions: 0, currentSymbolPositions: 0, currentTotalVolume: '0', currentSymbolVolume: '0', currentSymbolMargin: '0', currentOpenRisk: '0', unmeasuredRiskPositions: 0 },
      nowMs: 10_100,
    }),
    error => error.code === 'MAX_SINGLE_ORDER_EXPOSURE',
  );
});

test('explicit percentage risk rules require a stop loss so they cannot be bypassed', () => {
  assert.throws(
    () => planMarketOpen({
      account: account({ riskPolicy: { allowedSymbols: [], maxRiskPerTradePercent: '1', maxAggregateRiskPercent: '2', maxSingleOrderMarginPercentOfFree: '100', maxSymbolMarginPercentOfPermitted: '100' } }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '1',
      nowMs: 10_100,
    }),
    error => error.code === 'STOP_LOSS_REQUIRED_FOR_RISK',
  );
});


test('single-order exposure uses remaining capacity inside the 50% margin ceiling', () => {
  assert.throws(
    () => planMarketOpen({
      account: account({
        state: { ...account().state, usedMargin: '25000', freeMargin: '75000' },
        riskPolicy: {
          allowedSymbols: [],
          maxMarginUsagePercent: '50',
          maxSingleOrderMarginPercentOfFree: '20',
          maxSymbolMarginPercentOfPermitted: '100',
        },
      }),
      instrument: instrument(),
      quote: quote(),
      side: 'BUY',
      volume: '5',
      exposure: {
        currentOpenPositions: 1,
        currentSymbolPositions: 0,
        currentTotalVolume: '1',
        currentSymbolVolume: '0',
        currentSymbolMargin: '0',
        currentOpenRisk: '0',
        unmeasuredRiskPositions: 1,
      },
      nowMs: 10_100,
    }),
    error => error.code === 'MAX_SINGLE_ORDER_EXPOSURE'
      && error.details.remainingPermittedMargin === '25000'
      && Number(error.details.singleOrderMarginPercentOfAvailableCapacity) > 20,
  );
});

test('aggregate stop risk is evaluated from the selected account exposure only', () => {
  const riskPolicy = {
    allowedSymbols: [],
    maxRiskPerTradePercent: '1',
    maxAggregateRiskPercent: '2',
  };
  const proposed = {
    instrument: instrument(),
    quote: quote(),
    side: 'BUY',
    volume: '1',
    stopLoss: '1.09705',
    nowMs: 10_100,
  };

  assert.throws(
    () => planMarketOpen({
      ...proposed,
      account: account({ _id: 'account-a', riskPolicy }),
      exposure: {
        currentOpenPositions: 1,
        currentSymbolPositions: 1,
        currentTotalVolume: '6',
        currentSymbolVolume: '6',
        currentSymbolMargin: '6600',
        currentOpenRisk: '1800',
        unmeasuredRiskPositions: 0,
      },
    }),
    error => error.code === 'MAX_AGGREGATE_RISK',
  );

  const accepted = planMarketOpen({
    ...proposed,
    account: account({ _id: 'account-b', riskPolicy }),
    exposure: {
      currentOpenPositions: 1,
      currentSymbolPositions: 1,
      currentTotalVolume: '1',
      currentSymbolVolume: '1',
      currentSymbolMargin: '1100',
      currentOpenRisk: '1000',
      unmeasuredRiskPositions: 0,
    },
  });

  assert.equal(accepted.riskAmount, '300');
  assert.equal(accepted.riskPercent, '0.3');
});

test('open exposure loader never mixes positions from different trading accounts', async () => {
  const rows = {
    'account-a': [{
      symbol: 'EURUSD',
      side: 'BUY',
      openVolume: '6',
      entryPrice: '1.1',
      stopLoss: '1.097',
      contractSize: '100000',
      quoteCurrency: 'USD',
      margin: '6600',
    }],
    'account-b': [{
      symbol: 'EURUSD',
      side: 'BUY',
      openVolume: '1',
      entryPrice: '1.1',
      stopLoss: '1.09',
      contractSize: '100000',
      quoteCurrency: 'USD',
      margin: '1100',
    }],
  };
  const positionModel = {
    find(filter) {
      const selected = rows[String(filter.accountId)] || [];
      return {
        select() { return this; },
        async lean() { return selected; },
      };
    },
  };

  const accountA = account({ _id: 'account-a' });
  const accountB = account({ _id: 'account-b' });
  const exposureA = await loadOpenExposure(positionModel, 'account-a', null, { account: accountA, symbol: 'EURUSD', nowMs: 10_100 });
  const exposureB = await loadOpenExposure(positionModel, 'account-b', null, { account: accountB, symbol: 'EURUSD', nowMs: 10_100 });

  assert.equal(exposureA.currentOpenRisk, '1800');
  assert.equal(exposureA.currentOpenPositions, 1);
  assert.equal(exposureB.currentOpenRisk, '1000');
  assert.equal(exposureB.currentOpenPositions, 1);
});

test('projected percentage risk includes opening and stop-side commission', () => {
  const btc = instrument({
    symbol: 'BTCUSD',
    quoteCurrency: 'USD',
    tickSize: '0.01',
    minVolume: '0.01',
    maxVolume: '1000',
    volumeStep: '0.01',
    contractSize: '1',
    defaultLeverage: 100,
    commissionPerLot: '0',
    commissionPerLotPerSide: '0',
    commissionRate: '0.0002',
  });
  const btcQuote = quote({
    symbol: 'BTCUSD',
    bid: 83999,
    ask: 84000,
  });

  const accepted = planMarketOpen({
    account: account({
      riskPolicy: {
        allowedSymbols: [],
        maxRiskPerTradePercent: '1',
        maxAggregateRiskPercent: '2',
      },
    }),
    instrument: btc,
    quote: btcQuote,
    side: 'SELL',
    volume: '5',
    stopLoss: '84160',
    nowMs: 10_100,
    exposure: {
      currentOpenPositions: 0,
      currentSymbolPositions: 0,
      currentTotalVolume: '0',
      currentSymbolVolume: '0',
      currentSymbolMargin: '0',
      currentOpenRisk: '0',
      unmeasuredRiskPositions: 0,
    },
  });

  assert.equal(accepted.rawStopRiskAmount, '805');
  assert.equal(accepted.openingCommission, '83.999');
  assert.equal(accepted.estimatedCloseCommission, '84.16');
  assert.equal(accepted.riskAmount, '973.159');
  assert.equal(accepted.riskPercent, '0.973159');

  assert.throws(
    () => planMarketOpen({
      account: account({
        riskPolicy: {
          allowedSymbols: [],
          maxRiskPerTradePercent: '1',
          maxAggregateRiskPercent: '2',
        },
      }),
      instrument: btc,
      quote: btcQuote,
      side: 'SELL',
      volume: '5',
      stopLoss: '84170',
      nowMs: 10_100,
      exposure: {
        currentOpenPositions: 0,
        currentSymbolPositions: 0,
        currentTotalVolume: '0',
        currentSymbolVolume: '0',
        currentSymbolMargin: '0',
        currentOpenRisk: '0',
        unmeasuredRiskPositions: 0,
      },
    }),
    error => error.code === 'MAX_TRADE_RISK'
      && error.details.rawStopRiskAmount === '855'
      && error.details.openingCommission === '83.999'
      && error.details.closingCommission === '84.17',
  );
});

test('50 percent margin cap is evaluated against post-opening-commission equity', () => {
  assert.throws(
    () => planMarketOpen({
      account: account({
        state: {
          ...account().state,
          equity: '100000',
          balance: '100000',
          freeMargin: '100000',
          usedMargin: '0',
        },
        riskPolicy: {
          allowedSymbols: [],
          maxMarginUsagePercent: '50',
        },
      }),
      instrument: instrument({
        quoteCurrency: 'USD',
        contractSize: '100000',
        defaultLeverage: 2,
        commissionPerLotPerSide: '100',
      }),
      quote: quote({ bid: 0.99999, ask: 1 }),
      side: 'BUY',
      volume: '1',
      nowMs: 10_100,
    }),
    error => error.code === 'MAX_MARGIN_USAGE'
      && error.details.openingCommission === '100'
      && error.details.projectedEquity === '99900'
      && Number(error.details.projectedMarginUsagePercent) > 50,
  );
});

test('existing measured open risk includes projected stop-side commission', async () => {
  const positionModel = {
    find() {
      return {
        select() { return this; },
        async lean() {
          return [{
            symbol: 'EURUSD',
            side: 'BUY',
            openVolume: '1',
            entryPrice: '1.1',
            stopLoss: '1.09',
            contractSize: '100000',
            quoteCurrency: 'USD',
            margin: '1100',
          }];
        },
      };
    },
  };
  const instrumentModel = {
    find(filter) {
      assert.ok(filter.symbol);
      return {
        select() { return this; },
        async lean() {
          return [{
            symbol: 'EURUSD',
            contractSize: '100000',
            quoteCurrency: 'USD',
            commissionPerLot: '0',
            commissionPerLotPerSide: '2.5',
            commissionRate: '0',
          }];
        },
      };
    },
  };

  const exposure = await loadOpenExposure(positionModel, 'account-a', null, {
    account: account({ _id: 'account-a' }),
    symbol: 'EURUSD',
    instrumentModel,
    nowMs: 10_100,
  });

  assert.equal(exposure.currentOpenRisk, '1002.5');
  assert.equal(exposure.unmeasuredRiskPositions, 0);
});



test('opening projection includes spread loss, commission and resulting authoritative margin state', () => {
  const plan = planMarketOpen({
    account: account({
      state: {
        ...account().state,
        balance: '100000',
        equity: '100000',
        floatingPnl: '0',
        usedMargin: '0',
        freeMargin: '100000',
      },
    }),
    instrument: instrument({ commissionPerLot: '3.5' }),
    quote: quote({ bid: 1.1000, ask: 1.1002 }),
    side: 'BUY',
    volume: '1',
    nowMs: 10_100,
  });

  assert.equal(plan.fillPrice, '1.1002');
  assert.equal(plan.immediateOpeningPnl, '-20');
  assert.equal(plan.commission, '3.5');
  assert.equal(plan.requiredMargin, '1100.2');
  assert.equal(plan.projectedAccountState.balance, '99996.5');
  assert.equal(plan.projectedAccountState.floatingPnl, '-20');
  assert.equal(plan.projectedAccountState.equity, '99976.5');
  assert.equal(plan.projectedAccountState.usedMargin, '1100.2');
  assert.equal(plan.projectedAccountState.freeMargin, '98876.3');
});

test('spread and commission can make an otherwise old-style affordable order financially unaffordable', () => {
  assert.throws(
    () => planMarketOpen({
      account: account({
        state: {
          ...account().state,
          balance: '1110',
          equity: '1110',
          floatingPnl: '0',
          usedMargin: '0',
          freeMargin: '1110',
        },
      }),
      instrument: instrument({ commissionPerLot: '3.5' }),
      quote: quote({ bid: 1.1000, ask: 1.1002 }),
      side: 'BUY',
      volume: '1',
      nowMs: 10_100,
    }),
    error => error.code === 'INSUFFICIENT_MARGIN'
      && error.details.requiredMargin === '1100.2'
      && error.details.commission === '3.5'
      && error.details.immediateOpeningPnl === '-20'
      && error.details.projectedFreeMargin === '-13.7',
  );
});

test('immediate opening PnL uses the same account-currency conversion path as live valuation', () => {
  const converter = {
    convert(amount, from, to) {
      assert.equal(from, 'USD');
      assert.equal(to, 'EUR');
      return String(Number(amount) * 0.8);
    },
  };

  const plan = planMarketOpen({
    account: account({
      currency: 'EUR',
      state: {
        ...account().state,
        balance: '100000',
        equity: '100000',
        floatingPnl: '0',
        usedMargin: '0',
        freeMargin: '100000',
      },
    }),
    instrument: instrument({ marginCurrency: 'USD', quoteCurrency: 'USD' }),
    quote: quote({ bid: 1.1000, ask: 1.1002 }),
    side: 'BUY',
    volume: '1',
    currencyConverter: converter,
    nowMs: 10_100,
  });

  assert.equal(plan.immediateOpeningPnl, '-16');
  assert.equal(plan.requiredMargin, '880.16');
  assert.equal(plan.projectedAccountState.floatingPnl, '-16');
});
