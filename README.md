# ACG Trader Backend

Independent Node.js/Express/MongoDB backend for ACG Trader.

ACG Trader owns its own market-data, trading-account, execution, position, P&L and risk state. It does not depend on the ACG Funded runtime or database.

## Implemented

- Express API bootstrap and graceful shutdown
- Strict environment validation with Zod
- MongoDB/Mongoose connection lifecycle
- Pino structured logging with secret redaction
- Helmet, CORS, request IDs and API rate limiting
- Liveness/readiness endpoints
- Precision-safe `Instrument` model using MongoDB Decimal128
- Independent `TradingAccount` model with account state and snapshotted risk policy
- ACG instrument catalog with safe insert-on-start behavior
- Explicit EURUSD/XAUUSD contract, volume, provider and synthetic-spread specifications
- Twelve Data WebSocket diagnostic under `diagnostics/`
- ACG Market Gateway with one upstream Twelve Data connection
- Canonical tick normalization and per-symbol sequencing
- In-memory latest-quote store
- Deterministic bid/ask construction from Instrument spread policy
- Stale quote detection and immediate stale propagation on provider disconnect
- Candle engine for `1s`, `5s`, `15s`, `30s`, `1m`, `5m`, `15m`, `1h`, `4h`, `1d`
- Realtime carry-forward candles for short zero-tick intervals while feed continuity is healthy
- No synthetic candle backfill across known provider outages/stale periods
- Closed-candle persistence in MongoDB
- Twelve Data `1m+` historical backfill without overwriting ACG-generated candles
- ACG market WebSocket at `/v1/ws`
- Market and instrument REST endpoints
- Market-data/instrument unit tests

## Local setup

```bash
npm install
copy .env.example .env
npm run dev
```

On macOS/Linux use `cp .env.example .env` instead of `copy`.

Set `MONGODB_URI` and `TWELVE_DATA_API_KEY` in `.env` before starting the default live Market Gateway.

Default API: `http://localhost:4000`

```text
GET /health/live
GET /health/ready
GET /v1
GET /v1/instruments
GET /v1/instruments/EURUSD
GET /v1/market/status
GET /v1/market/quotes?symbols=EURUSD,XAUUSD
GET /v1/market/candles?symbol=EURUSD&timeframe=5s&limit=160
WS  /v1/ws
```

Run tests:

```bash
npm test
```

Synchronize the managed instrument catalog deliberately:

```bash
npm run seed:instruments
```

See `docs/MARKET_GATEWAY.md` and `docs/INSTRUMENT_CATALOG.md`.

## Architecture rules

1. MongoDB is durable state, not the realtime tick bus.
2. Financial values persisted by the trading domain use Decimal128.
3. Instrument specifications own tick size, pip size, contract size, volume limits, leverage and spread configuration. Trading logic must not infer them from price magnitude.
4. Instrument catalog values are ACG simulation policy; they are not universal broker specifications.
5. A trading account owns a snapshot of its rules so trading does not require ACG Funded to be online.
6. `executionEnabled` defaults to `false`. Catalog seeding never silently enables trading.
7. ACG Trader V1 uses hedging position semantics.
8. Browsers never connect directly to the market-data provider or receive provider credentials.
9. Charts, future execution, P&L and risk consume one canonical market stream.
10. Provider timestamps are retained for diagnostics; live sub-minute candle sequencing uses gateway arrival time.
11. Known stale/disconnected intervals are not retroactively represented as genuine market continuity.
12. Twelve Data historical backfill may insert missing bars but never overwrite ACG-generated live candles.

## Next implementation layer

The next backend layer is the trading core:

```text
Canonical market tick
        |
        +--> Order validation / pending triggers
        +--> Execution Engine
        +--> Positions
        +--> P&L / margin
        +--> SL / TP / trailing
        +--> Risk Engine
```
