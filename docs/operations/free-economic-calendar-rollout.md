# Zero-subscription economic calendar — controlled rollout

## Scope and provenance

- **Primary:** ShowMyTrades public economic calendar. Provider documents no API key, commercial use for licensed app users, 15-minute upstream cache, no completeness/SLA guarantee.
- **Independent primary-source cross-check:** official Bureau of Labor Statistics (BLS) iCalendar feed for CPI, PPI and Employment Situation. BLS is NOT a full global economic calendar; it does not verify FOMC, PCE, ECB or BOE.
- **Not connected:** XOOMAR. Its current public $0 tier does not explicitly grant a commercial-product licence; its pricing lists this licence under paid Pro. Obtain written permission before using it in a commercial production feed.
- No new paid API contract or account secrets are required.

## Data safety

1. `NEWS_CALENDAR_PROVIDER` defaults to `financecalendar`; the existing production integration is not replaced by merging code.
2. Enabling `showmytrades` uses a distinct MongoDB state pointer and immutable snapshots. Previous FinanceCalendar snapshots cannot be reused as free-source evidence.
3. Every response must pass event ID, impact, clock, currency and UTC timestamp validation. Last-minute deletions of known future events do not silently replace the active snapshot. BLS schedule conflicts retain both event times as a conservative safety guard.
4. BLS failures are explicitly reported as `officialBls=UNAVAILABLE`; they must never be described as independent official verification.
5. The collector polls ShowMyTrades no more frequently than 15 minutes in its normal operation. Rate limiting/retries and provider outages use bounded requests and stale/expired snapshot semantics.
6. Without `NEWS_FREE_CALENDAR_VALIDATED=true`, the free provider is marked `PENDING_VALIDATION`, not authoritative. Enabling active news enforcement while unvalidated is rejected during process startup. Closing or reducing existing positions remains allowed under the existing trading policy.

## Staging verification only (first)

In the **ACG Trader staging** backend (not ACG Funded and never acg-quant-research):

```dotenv
NEWS_CALENDAR_PROVIDER=showmytrades
NEWS_FREE_CALENDAR_VALIDATED=false
NEWS_TRADING_ENFORCEMENT=false
NEWS_TRADING_ROLLOUT_PERCENT=0
```

Confirm these logs appear:

```
Calendar snapshot published
provider: showmytrades+bls
eventCount: <nonnegative integer>
verification: { primary: AVAILABLE, officialBls: AVAILABLE|UNAVAILABLE, confirmed: ..., conflicts: ... }
```

Pass acceptance before changing any production variable or permission:

- Compare US CPI, PPI and NFP UTC timestamps with the current BLS official schedule; verify November and March DST transitions.
- Separately compare FOMC, PCE and other high-impact US events against Federal Reserve/BEA official calendars, and EUR/GBP/JPY etc. against the relevant issuing authorities.
- Prove the ±5-minute restricted-entry behavior on a non-customer test account. Confirm pending orders obey the same restriction and **close/reduce is always permitted**.
- Inject primary HTTP 429/503, invalid payload, stale server clock, cancellations, event moves, truncated lists and conflicting BLS times.
- Check upstream response completeness and commercial use conditions over several scheduled release cycles; external feeds have no SLA.
- Demonstrate recovery and fail-closed behavior when the feed is unavailable, and verify actual provider reachability from Railway.
- Save evidence and require explicit authorization before setting `NEWS_FREE_CALENDAR_VALIDATED=true`, merging a release configuration change or expanding enforcement.

## References

- ShowMyTrades: https://showmytrades.com/docs/api/economic-calendar
- BLS iCalendar: https://www.bls.gov/help/hlpiCAL.htm
- BLS feed: https://www.bls.gov/schedule/news_release/bls.ics
- XOOMAR licence tiers: https://xoomar.com/pricing
