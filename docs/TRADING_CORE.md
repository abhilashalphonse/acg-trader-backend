# ACG Trader Trading Core Foundation

This layer defines the durable trading-domain contract that the execution engine will use. It does not expose public order routes and it does not enable instrument execution.

## Domain records

### Order

An Order is trading intent. It owns the client idempotency key, symbol, side, type, requested volume, pending-order trigger fields, protection, time-in-force and lifecycle timestamps.

Supported order types:

- `MARKET`
- `LIMIT`
- `STOP`
- `STOP_LIMIT`

Supported lifecycle states:

- `RECEIVED`
- `VALIDATING`
- `ACCEPTED`
- `PENDING`
- `TRIGGERED`
- `PARTIALLY_FILLED`
- `FILLED`
- `CANCELLED`
- `EXPIRED`
- `REJECTED`

`accountId + clientOrderId` is unique. Retrying the same client command must never create a second order.

### Deal

A Deal is an immutable execution fact. It records what actually happened: execution side, volume, fill price, requested price, slippage, commission, swap, realized P&L, quote sequence and execution time.

Deals are append-only and must never be rewritten to make later state look simpler.

### Position

A Position is mutable lifecycle state for one hedged trade. ACG Trader V1 uses hedging semantics, so multiple positions in the same symbol and direction can coexist.

A position stores initial/open volume, entry price, SL/TP, trailing state, realized P&L and close state. Floating P&L will be calculated from the live QuoteStore rather than persisted on every tick.

### AccountLedger

The account ledger is immutable accounting history. Entries record monetary balance movements with `balanceBefore` and `balanceAfter` and a reference to the related order/deal/position/system action.

Initial entry types:

- `DEPOSIT`
- `WITHDRAWAL`
- `REALIZED_PNL`
- `COMMISSION`
- `SWAP`
- `ADJUSTMENT`

## Decimal arithmetic

`src/shared/decimal/decimal.js` uses integer-coefficient decimal arithmetic rather than JavaScript floating point for trading-critical calculations. It provides canonical normalization, add/subtract/multiply/divide, deterministic rounding, step alignment/quantization and Mongo Decimal128 conversion.

Persisted trading financial values remain MongoDB Decimal128. API serialization should use decimal strings.

## Command serialization

`AccountCommandQueue` serializes all state-changing commands for the same trading account while allowing separate accounts to execute concurrently.

This prevents races between events such as:

- market order + close-all
- user close + SL trigger
- partial close + reverse
- risk liquidation + trader command
- duplicate mobile/API retries

## Durable idempotency

`IdempotencyRecord` and `IdempotencyService` provide command-level idempotency beyond the Order model's `clientOrderId` uniqueness.

The request payload is canonicalized and SHA-256 hashed. Reusing the same key with a different payload is a conflict. Completed/failed command records can be replayed safely and expire through a TTL index after the retention period.

## Next layer

The Execution Foundation should consume these records in this order:

```text
request
  -> AccountCommandQueue
  -> IdempotencyService.reserve
  -> account/instrument/quote validation
  -> Order ACCEPTED
  -> authoritative bid/ask from QuoteStore
  -> Deal
  -> Position
  -> AccountLedger / TradingAccount balance state
  -> IdempotencyService.complete
  -> realtime trading event
```

Market orders should be implemented and tested end-to-end before pending orders, SL/TP, trailing, P&L/margin and challenge risk rules.
