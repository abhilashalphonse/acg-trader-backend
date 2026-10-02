# Forex M5 finalization

The live engine still builds the active candle from streamed provider prices. A runtime worker now listens to `market.candle.closed` and checks Twelve Data forex M5 bars after closure, independently of browser history requests.

- Requests bypass the history cache and use an exclusive close-time cursor plus an exact open-time match.
- Checks are scheduled 15 and 75 seconds after close. Failed or missing/invalid/explicitly incomplete responses retry at 180 and 600 seconds. These delays allow publication to settle; they are not a provider guarantee of finality.
- Requests are serialized, spaced at least one second apart, and deduplicated per symbol/timeframe/open time. Backlogs can delay scheduled checks. The pending queue is bounded at 2,000 entries. A failed final attempt leaves the live-built candle unchanged and emits a warning.
- Valid changed OHLC passes through the existing durable correction queue, then `market.candle.corrected` is broadcast. The active candle is never replaced by a completed-bar correction. Matching checks do not emit another correction.
- Cache invalidation is limited to the corrected provider/symbol/timeframe, including pending cache fills. Connected frontend charts already refresh authoritative history on the correction event.
- Scope is deliberately Twelve Data `FOREX` / `5m`. Other providers, metals and timeframes keep their current behavior. Workers are per market-runtime process, like the existing live engine; this is not a distributed job queue. Pending jobs do not survive process restarts; normal history loading remains the recovery path.

Configuration:

```text
MARKET_CLOSED_CANDLE_RECONCILIATION_ENABLED=true
MARKET_CLOSED_CANDLE_REQUEST_INTERVAL_MS=1000
```

The request interval only paces this worker, not all application API traffic. Check the subscription's API budget before increasing its scope. Market status exposes `closedCandleReconciliation` counters for requests, successful checks, failures, drops and pending work.

## Verification

Unit tests drive a real candle engine with sparse ticks and mocked finalized provider bars. They verify exact OHLC parity, persistence-before-broadcast through the existing correction path, retries, repeated publication, request pacing, shutdown and cache invalidation. They do not certify a deployed provider stream.

For a live, read-only REST comparison, configure `TWELVE_DATA_API_KEY` and `ACG_TRADER_API_BASE` and run:

```text
npm run diagnostic:candle-parity -- GBPUSD
```

The diagnostic compares six overlapping completed M5 bars at least 90 seconds old. It prints numeric differences and exits nonzero for mismatches or unavailable data. It calls ACG's history endpoint, so it is a REST parity check; use the worker tests and correction events to verify unattended chart finalization. Provider revisions after the verification window and exhausted requests remain observable limitations.
