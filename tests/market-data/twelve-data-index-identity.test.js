'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chooseIndexSearchMatch,
  qualifyProviderSymbol,
} = require('../../src/modules/market-data/adapters/twelve-data.adapter');

test('chooses an Index result instead of an ambiguous stock with the same ticker', () => {
  const rows = [
    {
      symbol: 'NDX',
      instrument_name: 'Nordex SE - Unsponsored ADR',
      exchange: 'FSX',
      instrument_type: 'Common Stock',
      country: 'Germany',
      currency: 'EUR',
    },
    {
      symbol: 'NDX',
      instrument_name: 'Nasdaq 100 Index',
      exchange: 'NASDAQ',
      instrument_type: 'Index',
      country: 'United States',
      currency: 'USD',
    },
  ];

  const match = chooseIndexSearchMatch(rows, {
    symbol: 'US100',
    providerSymbol: 'NDX',
    name: 'Nasdaq 100',
    quoteCurrency: 'USD',
  });

  assert.equal(match.instrument_type, 'Index');
  assert.equal(match.exchange, 'NASDAQ');
  assert.equal(qualifyProviderSymbol(match, 'NDX'), 'NDX:NASDAQ');
});

test('prefers the expected currency and name when multiple exact-ticker indices exist', () => {
  const rows = [
    {
      symbol: 'ABC',
      instrument_name: 'Example Europe Index',
      exchange: 'EURONEXT',
      instrument_type: 'Index',
      country: 'France',
      currency: 'EUR',
    },
    {
      symbol: 'ABC',
      instrument_name: 'Example US 100 Index',
      exchange: 'NASDAQ',
      instrument_type: 'Market Index',
      country: 'United States',
      currency: 'USD',
    },
  ];

  const match = chooseIndexSearchMatch(rows, {
    symbol: 'US100',
    providerSymbol: 'ABC',
    name: 'Example US 100',
    quoteCurrency: 'USD',
  });

  assert.equal(match.exchange, 'NASDAQ');
});

test('returns null when symbol search only finds non-index instruments', () => {
  const match = chooseIndexSearchMatch([
    {
      symbol: 'SPX',
      instrument_name: 'Spenda Ltd',
      exchange: 'ASX',
      instrument_type: 'Common Stock',
      currency: 'AUD',
    },
  ], {
    symbol: 'US500',
    providerSymbol: 'SPX',
    name: 'S&P 500',
    quoteCurrency: 'USD',
  });

  assert.equal(match, null);
});


test('name fallback can select an Index when Twelve Data uses a different index ticker', () => {
  const rows = [
    {
      symbol: 'OTHER',
      instrument_name: 'Nasdaq 100 Index',
      exchange: 'NASDAQ',
      instrument_type: 'Index',
      country: 'United States',
      currency: 'USD',
    },
    {
      symbol: 'NDX01',
      instrument_name: 'ChinaAMC Nasdaq 100 ETF',
      exchange: 'SET',
      instrument_type: 'ETF',
      country: 'Thailand',
      currency: 'THB',
    },
  ];

  const match = chooseIndexSearchMatch(rows, {
    symbol: 'US100',
    providerSymbol: 'NDX',
    name: 'Nasdaq 100',
    quoteCurrency: 'USD',
  }, { requireExactSymbol: false });

  assert.equal(match.instrument_type, 'Index');
  assert.equal(match.instrument_name, 'Nasdaq 100 Index');
});
