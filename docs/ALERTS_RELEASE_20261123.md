# Native alerts release — 23 November 2026

Backend PR #102 and frontend PR #233 deliver the first usable price, range and candle-close alert release. Indicator, drawing, account-risk, watchlist and compound alerts remain future scope.

## Operating model

- Authenticated APIs scope every rule, event and subscription to the tenant and trader identity. Client-supplied ownership is rejected. Mutation versions prevent stale edits; a transactional quota guard caps saved alerts at 100 per identity.
- Existing market ingestion supplies capture; monitored symbols retain market priority without an open browser. The evaluator and push sender have independent loops, using the existing MongoDB connection. No additional permanent Railway service is required.
- Durable events, checkpoint, trigger history and notification outbox preserve the Stage 2 recovery contract. Terminal history is persistent; Web Push is optional per rule and requires a device subscription.
- Push service acceptance is recorded as ACCEPTED, never claimed as confirmed device delivery. Failed jobs retry independently. No order-execution functionality is added.
- ACG_ALERTS_ENABLED controls activation. The initial production replay window is two hours; longer outages produce explicit gaps rather than invented crossings.

## Verified evidence

Railway project: acg-trader-alerts-stage2-staging, 98a016a8-668d-401f-896f-00f407c5c15d. Database and runner were isolated from all production connections.

- Ten database-backed fault tests passed on Railway: rollback, expiry replay, lease fencing, concurrent pause/edit, capture interruption, write rejection, actual TTL deletion and replay-gap evidence.
- Four actual child-process SIGKILL boundaries passed: after rule update, trigger insert, outbox insert and transaction commit. Replacement evaluation reconciled one logical trigger/outbox without duplication.
- Live API integration passed with application-wide query sanitization enabled: tenant/owner isolation, idempotent creation, mutation versions, pause/resume/deletion, scoped history and read acknowledgement.
- Push tests passed: endpoint restrictions reject arbitrary destinations; transient provider failures retry; acceptance remains distinct from device delivery. Provider transmission is mocked in this test, not claimed as a received phone notification.
- Desktop and mobile browser tests passed creation, editing, pause/resume, deletion, dialog sizing and Escape dismissal. Production build and chart/dock regression workflows passed.

## Bounded Railway load sample

Commit ff7867e0d27d22a2f050d43f76f2a87d678463fd, evidence is available through the runner logs; the later API/push refinement was verified separately on commit 364be0901a116286b0d3cab941292935272a8804.

| Measurement | Result |
|---|---:|
| Duration | 240,112 ms |
| Synthetic quote events | 4,800 (20/s, one stream) |
| Committed journal batches / processed batches | 240 / 240 |
| Journal write p95 | 16 ms |
| Test triggers | 4,799 |
| Database logical data | 5,174,568 bytes |
| Database storage / indexes | 1,085,440 / 1,773,568 bytes |
| Separate live BTCUSD quote samples | 4 |

This is a short, single-stream synthetic load test with separately sampled live quotes. It does not establish full provider tick coverage, multi-tenant capacity or long-term production cost. Report actual billing from Railway when available; do not convert synthetic JSON size into a bill.

## Recovery limit

The three in-transaction kills recovered in 86.6–90.0 seconds; the after-commit case took approximately 0.30 seconds. MongoDB logs explicitly show transactionLifetimeLimitSeconds cleanup aborting the orphan transaction and a blocked lease update proceeding afterwards. No global database timeout was changed, because that would also affect trading.

The Alerts API reports RECOVERING when the evaluator lease or evaluation progress is stale. Notifications can be delayed during abrupt process failure; recovery replays retained accepted events. Unobserved market intervals and intervals outside retention are recorded as gaps.

## Release and rollback

Run the paired release gates for the exact backend/frontend PRs. Deploy the backend with alerts disabled first; activate ACG_ALERTS_ENABLED only after deployment health checks pass. Verify unauthenticated requests remain rejected and the public frontend serves the new build. To roll back alerts, disable ACG_ALERTS_ENABLED; preserve history and do not change the trading database URI or topology.

Delete temporary staging compute and its explicitly disposable volume after evidence collection. Production Web Push keys reside only in Railway secret variables; no private keys are committed.
