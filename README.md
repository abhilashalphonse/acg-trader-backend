# ACG Trader Backend

Independent Node.js/Express/MongoDB backend for ACG Trader.

ACG Trader owns its own market data, trading accounts, execution, positions, P&L and risk state. It does not depend on the ACG Funded runtime or database.

## Implemented

- Express API bootstrap and graceful shutdown
- strict environment validation with Zod
- MongoDB/Mongoose connection lifecycle
- Pino structured logging, Helmet, CORS, request IDs and rate limiting
- independent `TradingAccount` and precision-safe `Instrument` models
- ACG EURUSD/XAUUSD instrument catalog with explicit simulated CFD specifications
- Twelve Data market adapter, reconnect/heartbeat handling and canonical Market Gateway
- deterministic synthetic bid/ask from Instrument spread policy
- stale quote protection
- TICK stream and candle engine for `1s`, `5s`, `15s`, `30s`, `1m`, `5m`, `15m`, `1h`, `4h`, `1d`
- realtime carry-forward candles only while feed continuity is healthy
- candle persistence and Twelve Data `1m+` backfill
- public market WebSocket at `/v1/ws`
- market/instrument REST endpoints
- exact decimal arithmetic helpers
- Order, Deal, Position, AccountLedger and Idempotency models
- immutable Deals and AccountLedger rows
- per-account command serialization
- account-scoped idempotency
- transactional MARKET BUY/SELL execution foundation
- transactional manual full/partial position close
- exact margin, commission and realized-P&L calculations for supported account/quote currencies
- internal post-commit trading events

## Local setup

Create a local `.env` file (never commit it) containing at least:

```text
NODE_ENV=development
PORT=4000
MONGODB_URI=<your MongoDB Atlas/replica-set URI>
TWELVE_DATA_API_KEY=<your Twelve Data key>
INSTRUMENT_CATALOG_AUTO_SEED=true
MARKET_GATEWAY_ENABLED=true
MARKET_SYMBOLS=EURUSD,XAUUSD
TRADING_API_ENABLED=false
```

Then:

```bash
npm install
npm test
npm run dev
```

MongoDB transactions are required for trading execution, so use Atlas or another replica-set deployment.

## Main endpoints

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

GET  /v1/trading/status
POST /v1/trading/orders/market
POST /v1/trading/positions/:positionId/close
```

The trading POST routes are disabled by default. They are an unauthenticated development surface only at this stage. `TRADING_API_ENABLED=true` is rejected when `NODE_ENV=production` until authenticated account ownership exists.

Instrument execution is independently gated by `Instrument.executionEnabled`; managed catalog seeding keeps it `false` unless deliberately enabled in the database.

## Architecture rules

1. MongoDB is durable state, not the realtime tick bus.
2. Financial values persisted by the trading domain use Decimal128.
3. Trading calculations use exact decimal helpers rather than native floating-point arithmetic.
4. Instrument specifications own tick size, pip size, contract size, volume limits, leverage and spread policy.
5. Instrument catalog values are ACG simulation policy, not universal broker specifications.
6. Existing positions snapshot contract size, volume step, quote currency and reserved margin so later catalog edits cannot change open-trade math.
7. ACG Trader V1 uses hedging position semantics.
8. Browsers never connect directly to the external market provider or receive provider credentials.
9. Charts, execution, future P&L and future risk consume the same canonical market stream.
10. BUY executes at ASK; SELL executes at BID. Long closes at BID; short closes at ASK.
11. Stale/missing executable quotes reject execution.
12. Account commands are serialized per account in the authoritative process.
13. MARKET execution and idempotency completion commit atomically in one Mongo transaction.
14. Deals and ledger rows are immutable audit records.
15. Cross-currency account conversion is rejected until a canonical conversion service exists.
16. Private trading events are not broadcast on the public market WebSocket before authentication exists.

## Documentation

- `docs/MARKET_GATEWAY.md`
- `docs/INSTRUMENT_CATALOG.md`
- `docs/TRADING_CORE.md`
- `docs/MARKET_ORDER_EXECUTION.md`

## Next implementation layer

The next trading layer should be tick-driven account state and protection:

```text
Canonical market tick
        |
        +--> floating P&L / equity / margin
        +--> SL / TP trigger engine
        +--> pending LIMIT / STOP / STOP_LIMIT engine
        +--> trailing-stop engine
        +--> Risk Engine
```

Authentication and private account WebSocket channels must be implemented before production trading routes are enabled.
