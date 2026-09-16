# Realtime Position Valuation

ACG Trader values open positions in memory from the same canonical market stream used by execution.

## Pricing rules

- LONG/BUY positions are marked to BID.
- SHORT/SELL positions are marked to ASK.
- Floating P&L is `(closePrice - entryPrice) * contractSize * volume` for longs and the inverse price difference for shorts.
- Only account-currency-compatible positions are aggregated. Cross-currency conversion is intentionally rejected until a canonical conversion service exists.

## Account state

For a fully priced account:

```text
floatingPnl = sum(open position floating P&L)
equity      = balance + floatingPnl
usedMargin  = sum(open position reserved margin)
freeMargin  = equity - usedMargin
marginLevel = equity / usedMargin * 100
```

If there is no used margin, `marginLevel` is null.

## LIVE / STALE / WAITING

- `LIVE`: every open position has a live executable quote.
- `STALE`: numeric valuation can still be calculated from the last executable quote, but one or more quotes are stale.
- `WAITING`: one or more open positions cannot be priced or converted. Equity/free margin are not fabricated.

New exposure requires a LIVE account valuation. Manual closes remain available so exposure can still be reduced.

## Runtime architecture

```text
market.tick / stale market.quote
        |
        v
ValuationEngine
  - positionsBySymbol
  - positionsByAccount
  - position valuations
  - account valuations
        |
        +--> valuation.position.updated
        +--> valuation.account.updated
```

The engine recovers open positions and their accounts from MongoDB on startup, then rebuilds valuations using QuoteStore. It listens to post-commit trading position/account events to keep the in-memory indexes current.

Realtime P&L is not persisted to MongoDB on every tick. MongoDB remains the durable source for balances, positions, deals, ledger entries and reserved margin; realtime valuation is rebuildable working state.

## Execution integration

Before opening new exposure, the Market Order Service overlays the durable account document with current in-memory floating P&L/equity/used margin/free margin and requires the result to be LIVE. This prevents margin validation from using stale persisted metrics.

When realizing P&L, value transfers from floating P&L into balance. Equity must not receive the same realized P&L twice. Commissions still reduce equity/balance as applicable.

## Development endpoints

These remain behind the existing development trading API gate:

```text
GET /v1/trading/accounts/:accountId/valuation
GET /v1/trading/positions/:positionId/valuation
```

Private authenticated realtime account channels are still a later layer.
