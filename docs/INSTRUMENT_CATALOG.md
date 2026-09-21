# ACG Instrument Catalog

The instrument catalog is the authoritative product specification used by ACG Trader for symbol precision, contract math, volume limits, leverage defaults and synthetic spread policy.

These values are **ACG simulation policy**, not claims that every broker uses identical CFD specifications.

## Seed behavior

At startup, when `INSTRUMENT_CATALOG_AUTO_SEED=true`, ACG Trader inserts any missing catalog instruments but does not overwrite existing MongoDB documents.

To intentionally synchronize the managed catalog fields later:

```bash
npm run seed:instruments
```

The sync command preserves an existing instrument's `executionEnabled` and `status` values. This prevents a catalog refresh from silently enabling or re-enabling trading.

## Initial catalog

### EURUSD

```text
displaySymbol     EUR/USD
digits            5
tickSize          0.00001
pipSize           0.0001
contractSize      100000
minVolume         0.01
maxVolume         100
volumeStep        0.01
defaultLeverage   100
provider          Twelve Data: EUR/USD
spreadMode        DYNAMIC
normalSpread      2 points = 0.00002 (0.2 pip)
maxQuoteAgeMs     10000
executionEnabled  false
```

### XAUUSD

```text
displaySymbol     XAU/USD
digits            2
tickSize          0.01
pipSize           0.01
contractSize      100
minVolume         0.01
maxVolume         100
volumeStep        0.01
defaultLeverage   100
provider          Twelve Data: XAU/USD
spreadMode        DYNAMIC
normalSpread      10 points = 0.10
maxQuoteAgeMs     10000
executionEnabled  false
```

The current Twelve Data WebSocket price stream is treated as the center/reference price. For instruments configured with ACG's `DYNAMIC` spread profile, the Market Gateway constructs executable bid/ask around that reference price. Normal profiles are intentionally tight for prop-style simulated execution, while controlled widening can still occur for volatility, rollover windows and large trade-size liquidity bands:

```text
bid = price - spread / 2
ask = price + spread / 2
```

Future execution must use the gateway's resulting bid/ask, never reconstruct spread independently.

## Safety rule

Catalog seeding does not enable execution. Before the future Order Engine can trade a symbol, `executionEnabled` must be deliberately changed to `true` after the execution/risk layer is ready.
