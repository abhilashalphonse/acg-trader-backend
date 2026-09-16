# ACG Market Gateway

The Market Gateway is the single authoritative live-market-data ingress for ACG Trader.

## Flow

```text
Twelve Data WebSocket
        |
        v
TwelveDataAdapter
        |
        v
MarketGateway
        |
        +--> QuoteStore (latest in memory)
        +--> market.tick
        +--> CandleEngine
               |
               +--> market.candle.update
               +--> market.candle.closed
               +--> MongoDB closed-candle persistence
        |
        v
REST + /v1/ws fan-out
```

Browsers never receive the Twelve Data API key and never connect directly to Twelve Data.

## Canonical live tick

```json
{
  "symbol": "EURUSD",
  "sequence": 1204,
  "price": 1.15386,
  "last": 1.15386,
  "bid": null,
  "ask": null,
  "mid": 1.15386,
  "spread": null,
  "providerTimestampMs": 1789525380000,
  "receivedAtMs": 1789525381464,
  "timeMs": 1789525381464,
  "source": "twelve-data",
  "providerSymbol": "EUR/USD",
  "isSyntheticSpread": false,
  "dayVolume": null
}
```

`timeMs` intentionally uses gateway arrival time for live candle aggregation. The Twelve Data provider timestamp is retained for diagnostics but is not trusted as the sub-second sequencing clock.

## Bid / ask

If a provider supplies bid and ask, ACG uses them. If it does not, bid/ask remain null unless that instrument is explicitly configured with `FIXED` or `SYNTHETIC` spread settings. Synthetic spreads are therefore opt-in, visible through `isSyntheticSpread`, and never silently invented.

## Timeframes

The engine supports `1s`, `5s`, `15s`, `30s`, `1m`, `5m`, `15m`, `1h`, `4h`, and `1d`.

By default, `1s` is computed in memory but not persisted. Closed `5s+` candles are persisted. Missing candles are filled only across short gaps; large gaps such as weekends are not backfilled with synthetic bars.

## REST

```text
GET /v1/market/status
GET /v1/market/quotes?symbols=EURUSD,XAUUSD
GET /v1/market/candles?symbol=EURUSD&timeframe=5s&limit=160
```

For provider-supported `1m+` intervals, candle history can be backfilled from Twelve Data into MongoDB. Sub-minute history is ACG-generated only.

## WebSocket

Connect to:

```text
ws://localhost:4000/v1/ws
```

Subscribe:

```json
{
  "action": "subscribe",
  "params": {
    "quotes": ["EURUSD", "XAUUSD"],
    "ticks": ["EURUSD"],
    "candles": [
      { "symbol": "EURUSD", "timeframe": "5s" }
    ]
  }
}
```

Events include:

```text
market.quote
market.tick
market.candle.update
market.candle.closed
market.status
subscription.status
```

Market quote/tick/current-candle updates are lossy under client backpressure: the newest market state matters more than replaying stale intermediate ticks. Closed candles and market-status messages are treated as reliable market events.

## Separation from trading

This module does not create orders, positions, P&L, margin or risk decisions. Future trading engines consume the exact same canonical `market.tick` stream, ensuring charts and simulated execution share one price source.
