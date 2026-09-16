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
- Twelve Data `1m+` historical backfill without overwriting ACG-generated live candles
- ACG market WebSocket at `/v1/ws`
- Market and instrument REST endpoints
- Exact decimal arithmetic/rounding/step primitives for trading-critical calculations
- Trading Core models: `Order`, immutable `Deal`, `Position`, immutable `AccountLedger`
- Durable command idempotency with request hashing and TTL retention
- Per-account command serialization queue
- Market-data, instrument and Trading Core unit tests

## Local setup

Keep real credentials only in your local `.env` (the repository intentionally does not contain an `.env.example`). At minimum configure the existing application/Mongo/market variables used by `src/config/env.js`, including `MONGODB_URI` and `TWELVE_DATA_API_KEY` when the live Market Gateway is enabled.

```bash
npm install
npm run dev
```

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

See `docs/MARKET_GATEWAY.md`, `docs/INSTRUMENT_CATALOG.md` and `docs/TRADING_CORE.md`.

## Architecture rules

1. MongoDB is durable state, not the realtime tick bus.
2. Trading-critical calculations use exact decimal primitives; persisted financial values use Decimal128.
3. Instrument specifications own tick size, pip size, contract size, volume limits, leverage and spread configuration. Trading logic must not infer them from price magnitude.
4. Instrument catalog values are ACG simulation policy; they are not universal broker specifications.
5. A trading account owns a snapshot of its rules so trading does not require ACG Funded to be online.
6. `executionEnabled` defaults to `false`. Catalog seeding never silently enables trading.
7. ACG Trader V1 uses hedging position semantics.
8. `Order` is intent, `Deal` is immutable execution fact, `Position` is lifecycle state, and `AccountLedger` is immutable accounting history.
9. State-changing commands for one account must be serialized through `AccountCommandQueue`.
10. Retried commands must use durable idempotency; the same key cannot represent different trading intent.
11. Browsers never connect directly to the market-data provider or receive provider credentials.
12. Charts, future execution, P&L and risk consume one canonical market stream.
13. Provider timestamps are retained for diagnostics; live sub-minute candle sequencing uses gateway arrival time.
14. Known stale/disconnected intervals are not retroactively represented as genuine market continuity.
15. Twelve Data historical backfill may insert missing bars but never overwrite ACG-generated live candles.

## Next implementation layer

The next backend layer is the market-order Execution Foundation:

```text
Order command
    -> account command queue
    -> idempotency reserve
    -> account/instrument/quote validation
    -> Order accepted
    -> authoritative bid/ask fill
    -> Deal + Position
    -> AccountLedger / balance state
    -> idempotency complete
    -> realtime trading event
```

Market BUY/SELL, close and partial-close should be made correct end-to-end before LIMIT/STOP/STOP_LIMIT, SL/TP, trailing, P&L/margin and risk enforcement are added.
