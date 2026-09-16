# ACG Trader Backend

Independent Node.js/Express/MongoDB backend for ACG Trader.

ACG Trader owns its own market-data, trading-account, execution, position, P&L and risk state. It does not depend on the ACG Funded runtime or database.

## Foundation implemented

- Express API bootstrap and graceful shutdown
- Strict environment validation with Zod
- MongoDB/Mongoose connection lifecycle
- Pino structured logging with secret redaction
- Helmet, CORS, request IDs and API rate limiting
- Liveness/readiness endpoints
- Precision-safe `Instrument` model using MongoDB Decimal128
- Independent `TradingAccount` model with account state and snapshotted risk policy
- Existing Twelve Data diagnostic retained under `diagnostics/`

## Local setup

```bash
npm install
copy .env.example .env
npm run dev
```

On macOS/Linux use `cp .env.example .env` instead of `copy`.

Set `MONGODB_URI` in `.env` before starting.

Default API: `http://localhost:4000`

Health endpoints:

```text
GET /health/live
GET /health/ready
GET /v1
```

## Architecture rules

1. MongoDB is durable state, not the realtime tick bus.
2. Financial values persisted by the trading domain use Decimal128.
3. Instrument specifications own tick size, pip size, contract size, volume limits, leverage and spread configuration. Trading logic must not infer them from price magnitude.
4. A trading account owns a snapshot of its rules so trading does not require ACG Funded to be online.
5. `executionEnabled` defaults to `false` for instruments. A symbol must be explicitly configured and enabled before the future execution engine may trade it.
6. ACG Trader V1 uses hedging position semantics.

## Next implementation layer

The next backend layer is the Market Gateway:

```text
Provider adapter -> canonical quote/tick -> in-memory QuoteStore -> Candle Engine -> ACG WebSocket
```

Execution, position/P&L and risk engines will consume the same canonical market-data stream.
