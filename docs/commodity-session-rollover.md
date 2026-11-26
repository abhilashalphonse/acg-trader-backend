# Commodity trading sessions and closed-market candles

Reference audit: 26 November 2026. Scope: all 20 ACG simulated commodity instruments, using the `providerMappings.twelveData` symbol in the catalog.

## Why

The previous commodity catalog assigned `FX_WEEK` to every metal, energy and agricultural instrument. As a result, the market-data engine considered an XAUUSD 22:15 UTC price on 25 November 2026 valid even though the standard gold maintenance interval was 22:00–23:00 UTC. The live CandleEngine and historical MarketHistoryService already use the instrument calendar, so the incorrect catalog input could admit stale/fabricated flat candles.

This patch replaces the generic calendar with explicit exchange-*reference* sessions in `commodity-trading-sessions.js`; `instrument-catalog.js` passes the selected sessions and IANA timezone through to both the market-data and trading session gates. No chart-side hiding of flat candles is added. Legitimate flat candles *during open market hours* remain valid.

**Important distinction:** Spot/rolling CFD symbols such as XAU/USD, WTI/USD, XBR/USD and Twelve Data's aggregate feeds are **not** identical to the listed futures used as reference markets. This PR has verified the reference exchange hours for each underlying, but **has not verified live Twelve Data feed hours for every symbol**. Source providers can vary, and the cited exchange calendars do not establish execution hours for a particular OTC quote. Production release requires feed parity review for each symbol, especially spot metals and oil.

## Individually mapped instruments

| ACG symbol | Reference instrument | Local timezone | Normal session / daily breaks | Reference |
| --- | --- | --- | --- | --- |
| XAUUSD | COMEX Gold | New York | Sun–Fri 18:00–17:00 (17:00–18:00 break) | [CME](https://www.cmegroup.com/markets/metals/precious/gold/specs) |
| XAGUSD | COMEX Silver | New York | Sun–Fri 18:00–17:00 | [CME](https://www.cmegroup.com/markets/metals/precious/silver/specs) |
| XPTUSD | NYMEX Platinum | New York | Sun–Fri 18:00–17:00 | [CME](https://www.cmegroup.com/markets/metals/precious/platinum/specs) |
| XPDUSD | NYMEX Palladium | New York | Sun–Fri 18:00–17:00 | [CME](https://www.cmegroup.com/markets/metals/precious/palladium/specs) |
| WTIUSD | NYMEX WTI | New York | Sun–Fri 18:00–17:00 | [CME](https://www.cmegroup.com/education/courses/introduction-to-energy/introduction-to-crude-oil/wti-overview) |
| XBRUSD | ICE Brent | New York | Normally 20:00–18:00; Sunday special 23:00 London open (modeled 18:00 NY; DST mismatch weeks require provider check) | [ICE](https://www.ice.com/products/219/Brent-Crude-Futures) |
| NGASUSD | NYMEX Henry Hub | New York | Sun–Fri 18:00–17:00 | [CME](https://www.cmegroup.com/articles/faqs/micro-henry-hub-natural-gas-futures-and-options-frequently-asked-questions.html) |
| COPPER | COMEX Copper | New York | Sun–Fri 18:00–17:00 | [CME](https://www.cmegroup.com/markets/metals/base/copper/specs) |
| CORN | CBOT Corn | Chicago | Sun–Fri 19:00–07:45; Mon–Fri 08:30–13:20 | [CME](https://www.cmegroup.com/markets/agriculture/grains/corn/specs) |
| WHEAT | CBOT Wheat | Chicago | Sun–Fri 19:00–07:45; Mon–Fri 08:30–13:20 | [CME](https://www.cmegroup.com/markets/agriculture/grains/wheat/specs) |
| SOYBEAN | CBOT Soybeans | Chicago | Sun–Fri 19:00–07:45; Mon–Fri 08:30–13:20 | [CME](https://www.cmegroup.com/markets/agriculture/oilseeds/soybean/specs) |
| SUGAR | ICE Sugar No. 11 | New York | Mon–Fri 03:30–13:00 | [ICE](https://www.ice.com/products/23/Sugar-No-11-Futures) |
| COFFEE | ICE Coffee C | New York | Mon–Fri 04:15–13:30 | [ICE](https://www.ice.com/products/15/Coffee) |
| COCOA | ICE Cocoa | New York | Mon–Fri 04:45–13:30 | [ICE](https://www.ice.com/products/7/Cocoa-Futures) |
| COTTON | ICE Cotton No. 2 | New York | Previous evening 21:00–14:20 next day | [ICE](https://www.ice.com/products/254/cotton-no-2-futures/specs) |
| CATTLE | CME Live Cattle | Chicago | Mon–Fri 08:30–13:05 | [CME](https://www.cmegroup.com/markets/agriculture/livestock/live-cattle/specs) |
| HOGS | CME Lean Hogs | Chicago | Mon–Fri 08:30–13:05 | [CME](https://www.cmegroup.com/markets/agriculture/livestock/lean-hogs/specs) |
| GASOLINE | NYMEX RBOB Gasoline | New York | Sun–Fri 18:00–17:00 | [CME](https://www.cmegroup.com/markets/energy/refined-products/rbob-gasoline) |
| HEATOIL | NYMEX NY Harbor ULSD | New York | Sun–Fri 18:00–17:00 | [CME](https://www.cmegroup.com/markets/energy/refined-products/heating-oil) |
| ALUMINUM | COMEX Aluminum | New York | Sun–Fri 18:00–17:00 | [CME](https://www.cmegroup.com/markets/metals/base/aluminum/specs) |

ICE U.S. regular-hours cross-check (September 2026): https://www.ice.com/publicdocs/futures_us/ICE_Futures_US_Regular_Trading_Hours.pdf

## Acceptance / deployment gates

1. **Before merge:** Run Node unit tests for commodity sessions, rollover live candles and session-filtered provider history; ensure existing forex, crypto and equity tests are unchanged.
2. **Provider parity:** Retrieve Twelve Data raw XAU/USD, XAG/USD, XPT/USD, XPD/USD, WTI/USD, XBR/USD, NG/USD and all futures-like `1` mappings around their open/break/close, compare source timestamps with the listed reference hours, and resolve any quote/market mismatch *per symbol*. For unavailable symbols, keep disabled rather than assert an unsupported schedule.
3. **Holidays:** Populate `tradingHolidays` or `sessionOverrides` for Thanksgiving, Christmas, early closes and exchange notices; don't infer exchange holidays from fixed weekly rules. The policy handles US DST automatically for New York/Chicago, but London-vs-NY mismatch weeks for ICE Brent require special review.
4. **Safe rollout:** Run `scripts/cleanup-out-of-session-candles.js` **read-only/dry-run** before considering any deletion. A change of schedule does not purge MongoDB itself; don't delete records before reviewing candidate counts and effects on open trades and chart history.
5. **Acceptance:** Confirm no synthetic candles, no live ticks, no provider history rows and no new trade execution during the verified XAUUSD closure. Confirm exact first real reopened bar, correct weekend behavior and 5m/1h boundary retention.

This document is a reference audit, not a declaration that provider parity and production acceptance have passed.
