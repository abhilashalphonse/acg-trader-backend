'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ACG_INSTRUMENT_CATALOG, ACG_LEVERAGE_BY_ASSET_CLASS, leverageForAssetClass } =
  require('../../src/modules/instruments/instrument-catalog');
const { ACG_INDIA_PILOT_CATALOG } = require('../../src/modules/instruments/india-pilot-catalog');
const { calculateRequiredMargin } = require('../../src/modules/trading/execution-planner');

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
