'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ACG_INSTRUMENT_CATALOG, ACG_LEVERAGE_BY_ASSET_CLASS, leverageForAssetClass } =
  require('../../src/modules/instruments/instrument-catalog');
const { ACG_INDIA_PILOT_CATALOG } = require('../../src/modules/instruments/india-pilot-catalog');
const { calculateRequiredMargin, planMarketClose } = require('../../src/modules/trading/execution-planner');
const { calculatePositionValuation, aggregateAccountValuation } = require('../../src/modules/trading/valuation-calculator');
const { shouldTriggerStopOut } = require('../../src/modules/trading/margin-stop-out-engine');
const { evaluateRiskContext } = require('../../src/modules/trading/challenge-risk-engine');

const expected = {
  FOREX: 100,
  METAL: 50,
  ENERGY: 50,
  OTHER: 50,
  INDEX: 20,
  EQUITY: 10,
  CRYPTO: 2,
};

test('All 300 catalog instruments use ACG asset-class leverage, not a blanket 100x', () => {
  assert.equal(ACG_INSTRUMENT_CATALOG.length, 300);
  assert.deepEqual(ACG_LEVERAGE_BY_ASSET_CLASS, expected);
  const covered = new Set();
  for (const instrument of ACG_INSTRUMENT_CATALOG) {
    covered.add(instrument.assetClass);
    assert.equal(instrument.defaultLeverage, expected[instrument.assetClass], instrument.symbol);
    assert.equal(instrument.marginRate, null, instrument.symbol + ' must not bypass its leverage ceiling');
  }
  assert.deepEqual([...covered].sort(), Object.keys(expected).sort());
  assert.throws(() => leverageForAssetClass('UNMAPPED'));
});

test('legacy reservations release proportionally on partial close across every asset class', () => {
  for (const assetClass of Object.keys(expected)) {
    const instrument = { ...ACG_INSTRUMENT_CATALOG.find(i => i.assetClass === assetClass && i.quoteCurrency === 'USD'),
      commissionPerLot: '0', commissionPerLotPerSide: '0', commissionRate: '0' };
    const position = { accountId: 'a', symbol: instrument.symbol, side: 'BUY', status: 'OPEN', openVolume: '1',
      entryPrice: '100', contractSize: instrument.contractSize, quoteCurrency: 'USD', margin: '12.34' };
    const input = { account: { _id: 'a', currency: 'USD' }, instrument, position,
      quote: { bid: 100, ask: 100, isStale: false, receivedAtMs: Date.now() } };
    assert.equal(planMarketClose({ ...input, volume: '0.5' }).releasedMargin, '6.17', assetClass);
    assert.equal(planMarketClose(input).releasedMargin, '12.34', assetClass);
  }
});

test('grandfathering does not exempt a losing position from stop-out or challenge loss limits', () => {
  const state = aggregateAccountValuation({ account: { _id: 'a', currency: 'USD', state: { balance: '100' } },
    positionValuations: [{ symbol: 'BTCUSD', margin: '100', floatingPnl: '-60', quoteCurrency: 'USD', valuationStatus: 'LIVE' }] });
  assert.equal(shouldTriggerStopOut(state), true);
  assert.equal(evaluateRiskContext({ equity: state.equity, initialBalance: '100', dailyStartEquity: '100', dailyLossLimit: '50', maxLossLimit: '60' }).breached, true);
});

test('Chart-only Indian equities use the stock 10x ceiling', () => {
  assert.ok(ACG_INDIA_PILOT_CATALOG.length > 0);
  for (const instrument of ACG_INDIA_PILOT_CATALOG) {
    assert.equal(instrument.assetClass, 'EQUITY');
    assert.equal(instrument.defaultLeverage, 10, instrument.symbol);
    assert.equal(instrument.executionEnabled, false, 'India execution must remain disabled');
  }
});

test('Server projected margin applies 100/50/20/10/2 leverage to all market families', () => {
  for (const [assetClass, leverage] of Object.entries(expected)) {
    const instrument = ACG_INSTRUMENT_CATALOG.find(i => i.assetClass === assetClass && i.quoteCurrency === 'USD');
    assert.ok(instrument, 'Missing USD-quoted test instrument for ' + assetClass);
    const notional = Number(instrument.contractSize) * 100;
    const required = Number(calculateRequiredMargin({
      account: { currency: 'USD', leverage: 100 },
      instrument, volume: '1', fillPrice: '100',
    }));
    assert.ok(Math.abs(required - notional / leverage) < 1e-6, assetClass + ' ' + instrument.symbol + ' margin ' + required);
  }
});

test('Lower account leverage and stricter margin rates always win', () => {
  const crypto = ACG_INSTRUMENT_CATALOG.find(i => i.assetClass === 'CRYPTO' && i.quoteCurrency === 'USD');
  const account = { currency: 'USD', leverage: 1 };
  assert.equal(Number(calculateRequiredMargin({
    account, instrument: crypto, volume: '1', fillPrice: '100',
  })), 100 * Number(crypto.contractSize));
  const account100 = { currency: 'USD', leverage: 100 };
  const rateTooSmall = { ...crypto, marginRate: '0.01' };
  assert.equal(Number(calculateRequiredMargin({
    account: account100, instrument: rateTooSmall, volume: '1', fillPrice: '100',
  })), (100 * Number(crypto.contractSize)) / 2);
  const higherMargin = { ...crypto, marginRate: '0.75' };
  assert.equal(Number(calculateRequiredMargin({
    account: account100, instrument: higherMargin, volume: '1', fillPrice: '100',
  })), 0.75 * 100 * Number(crypto.contractSize));
});


test('Legacy open crypto margin remains the stored reservation while NEW crypto orders require 2x', () => {
  const instrument=ACG_INSTRUMENT_CATALOG.find(i=>i.assetClass==='CRYPTO'&&i.quoteCurrency==='USD');
  assert.ok(instrument);
  const contractSize=String(instrument.contractSize);
  const notional=Number(contractSize)*100;
  const legacyMargin=String(notional/100); // Snapshot made before the corrected policy.
  const valued=calculatePositionValuation({
    position:{positionId:'legacy-p',accountId:'a',symbol:instrument.symbol,
      side:'BUY',status:'OPEN',openVolume:'1',entryPrice:'100',
      contractSize,quoteCurrency:'USD',margin:legacyMargin},
    quote:{bid:100,ask:101,isStale:false,receivedAtMs:Date.now(),sequence:1},
  });
  const account={_id:'a',currency:'USD',state:{balance:'1000'}};
  const aggregate=aggregateAccountValuation({account,positionValuations:[valued]});
  assert.equal(Number(aggregate.usedMargin),Number(legacyMargin),
    'Existing reservation cannot be silently multiplied by the new 2x ceiling');
  assert.equal(Number(aggregate.freeMargin),1000-Number(legacyMargin));
  assert.equal(shouldTriggerStopOut(aggregate),false,
    'Changing the catalog must not by itself force-liquidate the unchanged legacy position');
  const newPositionMargin=calculateRequiredMargin({
    account:{currency:'USD',leverage:100},instrument,volume:'1',fillPrice:'100',
  });
  assert.ok(Math.abs(Number(newPositionMargin)-notional/2)<1e-7,
    'All new crypto exposure must honor 2x even while grandfathered positions remain open');
});
