# Market Order Execution Foundation

This layer is the first transactional trading path in ACG Trader. It deliberately implements only market execution and manual close/partial-close. Pending orders, SL/TP triggers, trailing stops, live P&L and the risk engine are separate later layers.

## Safety boundary

`TRADING_API_ENABLED` defaults to `false`. The unauthenticated development trading routes cannot be enabled with `NODE_ENV=production`. Authentication/account ownership must be implemented before production trading routes are exposed.

Instrument execution is a second independent gate: `Instrument.executionEnabled` must also be `true`. The managed EURUSD/XAUUSD catalog continues to seed this field as `false` and catalog synchronization does not silently enable it.

## Open lifecycle

```text
POST /v1/trading/orders/market
        |
        v
idempotency reservation
        |
        v
per-account command queue
        |
        v
snapshot authoritative QuoteStore quote
        |
        v
validate account / instrument / quote / volume / protection / margin
        |
        v
Mongo transaction
  - Order(FILLED)
  - Position(OPEN)
  - Deal(OPEN)
  - optional COMMISSION ledger row
  - TradingAccount margin/balance state
  - IdempotencyRecord(COMPLETED)
        |
        v
commit
        |
        v
internal trading events
```

BUY executes at authoritative ASK. SELL executes at authoritative BID.

The quote is snapshotted once before the Mongo transaction and reused if MongoDB retries the transaction, so a retry cannot change the fill price.

## Close lifecycle

```text
POST /v1/trading/positions/:positionId/close
```

Omit `volume` to close the full position. Supply a valid step-aligned `volume` for a partial close. A partial close cannot leave a remainder below the instrument minimum volume.

Long positions close at BID. Short positions close at ASK.

The close transaction creates a new MARKET Order and immutable Deal, updates the existing Position, releases proportional reserved margin, posts realized P&L / commission ledger rows, and updates the TradingAccount state.

## Exact calculations

All persisted financial values remain Mongo Decimal128. Trading calculations use the exact decimal helper layer rather than native floating-point arithmetic.

For the currently supported USD-quoted instruments:

```text
notional = fillPrice * contractSize * volume
requiredMargin = notional / effectiveLeverage
```

If an instrument has `marginRate`, margin is `notional * marginRate` instead.

`effectiveLeverage = min(account leverage, instrument default leverage)`.

Cross-currency account conversion is intentionally rejected until a canonical conversion-rate service exists. The engine never guesses FX conversion.

## Position snapshots

A Position snapshots execution-critical instrument fields at open:

- `contractSize`
- `volumeStep`
- `quoteCurrency`
- reserved `margin`

This prevents later edits to the Instrument catalog from changing the mathematics of an already-open trade.

## Auditability

Each Deal stores:

- fill price
- requested price when supplied
- adverse slippage
- quote sequence
- quote receive timestamp
- quote source
- commission
- realized P&L

Deal and AccountLedger records are immutable.

## Idempotency

`clientOrderId` is the account-scoped idempotency identity for both open and close commands. Replaying the exact completed command returns the stored response. Reusing the same key with a different payload is rejected.

Idempotency completion occurs inside the same Mongo transaction as the trading records, preventing the common failure mode where the trade commits but its idempotency result does not.

## Internal events

After a successful commit the service emits internal events such as:

```text
trading.order.accepted
trading.order.filled
trading.deal.created
trading.position.opened
trading.position.updated
trading.position.closed
trading.account.updated
```

These are intentionally not exposed through the current public market WebSocket. Private authenticated account channels come later.

## Not included yet

- pending LIMIT / STOP / STOP_LIMIT execution
- automatic SL / TP triggering
- trailing stops
- tick-driven floating P&L
- margin-level liquidation
- daily/max-loss risk breaches
- authenticated user/account ownership
- private trading WebSocket channels
- cross-currency conversion
