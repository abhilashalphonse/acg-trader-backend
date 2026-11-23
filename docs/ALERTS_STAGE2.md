# ACG Trader Alerts — Stage 2 Shadow Engine (DRAFT)

**Scope:** Backend-only durable input, deterministic evaluator, atomic progress/outbox and restart recovery. No customer alerts, UI, notification delivery, database URI changes, or Railway deployments are included.

**Default:** All features OFF. Existing trading market, execution and authentication paths are unchanged unless an operator deliberately sets an opt-in capture/worker flag in a safe environment.

## Event acceptance and continuity

The canonical backend publishes `market.tick` and `market.candle.closed` through its local event bus. That bus and the current QuoteStore are not durable.

An alert input becomes **accepted** only when its ordered `AlertStage2MarketBatch` and generation/checkpoint fence commit with majority write concern. Evaluation only reads accepted Mongo batches. The synchronous market/trading path NEVER waits for alert persistence.

Events contain a schema version, instrument/feed stream identity, `generation:sequence` position, event ID, kind, provider/market and received timestamps, explicit Bid/Ask/Last values or candle OHLC/timeframe, quality and synthetic-spread markers. Inputs are stored in generation order; the evaluator must never infer continuous price action across a `coverage_gap` or a missing replay sequence.

Each stream has a Mongo `AlertStage2Coverage` record. Capture begins only for streams with active shadow rules, creates a new monotonically increasing generation and records an explicit initial gap. A first persisted quote is required before the capture coverage record becomes MONITORING; source-specific availability is separately enforced by the evaluator. Streams are marked INTERRUPTED on provider status errors, persistence failures, or in-process buffer overflow. On successful recovery capture starts a fresh generation rather than bridging an unknown interval.

**Limits:** This stage does not reconstruct ticks the provider never supplied or that could not be persisted before a crash. In those cases coverage is explicitly incomplete. The client must not describe gaps as monitored. The code records the provider's identity and labels derived bid/ask; it does not substitute unavailable sources.

## Candle contract

Alert-eligible candles are ACG-finalised **non-synthetic** candles, currently based on the ACG chart/Last price. The alert journal transaction persists each candle row and its event batch together. The existing candle engine may also asynchronously persist the same finalised row. Provider corrections are recorded as `candle_corrected` evidence, ignored by the live evaluator and never rewrite historical trigger evidence. A later provider correction cannot silently retroactively trigger a new alert.

**Open question before release:** instrument/session-specific candle open-time alignment must be verified against all enabled feed types; provider reconciliation currently covers only a subset of candles.

## Pure condition evaluator

`evaluateAlert(rule, previousState, durableEvent)` performs no IO and no clock reads. An either-direction repeating crossing rearms on the reverse crossing itself; for example `99 → 101 → 99 → 101` across level `100` produces three triggers with no cooldown. It supports `crosses`, `crosses_above`, `crosses_below`, `enters_range`, `exits_range`, `candle_close_above`, and `candle_close_below`. Price is rounded deterministically to the configured tick size using decimal integer math. It supports once/repeat, reset before repeat, optional cooldown, UTC/IANA-timezone daily schedule and expiry.

For quote crossings the first valid observation establishes a baseline, not a trigger. Unknown price source resets the baseline and sets SOURCE_UNAVAILABLE. A gap resets the baseline. A repeat cooldown suppresses the eligible crossing without queuing it for later.

The first complete real candle after creation may satisfy a candle-close condition; unlike a quote crossing it does not require two preceding candle observations.

## Persistence, fencing and failure boundaries

`AlertShadowWorker` acquires a renewable singleton Mongo lease. Rules are scanned using a bounded `_id` keyset cursor that wraps to the beginning, preventing starvation of rules beyond the first 200. The cursor rotates even when individual rules have no events. Every progress transaction writes to that lease with `ownerId + token + expiry` as a predicate, preventing stale worker commits. In the same transaction it writes the rule runtime state and durable cursor, plus any immutable trigger records and `shadow` outbox jobs. Rule `version`, activation state and previous cursor are checked in the transaction. **Rule expiry is not checked against the processing wall-clock**: the evaluator uses the event's observation/receipt timestamp, then advances to EXPIRED only after a durably ordered post-expiry observation or `expiry_watermark` has been replayed. Capture remains active for expired-but-unprocessed rules until this barrier is committed. A failure rolls back the checkpoint, events and outbox.

The unique trigger index uses `(alertId, ruleVersion, eventId)`. Rules carry a stable effective-from timestamp: retained events accepted before activation are skipped (but checkpointed). Rule edits must increment version, reset evaluation state, and set a new effective-from timestamp; paused/deleted rules must not match the trigger commit predicate. Every outbox job is **shadow-only**, never dispatched.

The capture writer also fences each persisted batch against its current stream generation **and** a renewable per-stream Mongo ownership lease (`captureOwnerId`, `captureToken`, `captureLeaseUntil`) in a transaction. Starting a second process cannot rotate generations while the first lease is valid. Superseded owners stand down permanently; a legitimate, unfenced owner may restart its generation when recovering from interruption.

## Safe testing and commands

```bash
npm test                           # includes pure evaluator, fairness and capture-lease tests
npm run alerts:stage2:benchmark    # synthetic sizing only; NOT a Railway bill
```

After live topology and transaction checks have passed, an operator can test in an isolated staging environment by explicitly configuring:

```text
ACG_ALERTS_STAGE2_CAPTURE=true
ACG_ALERTS_STAGE2_SHADOW_WORKER=true
ACG_ALERTS_REPLAY_HOURS=12
```

`ACG_ALERTS_STAGE2_CAPTURE` is read by the existing Trader backend and subscribes to its internal event bus. `ACG_ALERTS_STAGE2_SHADOW_WORKER` gates the separate `node src/modules/alerts/alert-worker.main.js` process. Both are disabled by default. The worker reads the same DB selection flags as the existing backend; it does not change those variables.

Before activating, insert isolated shadow rules with valid `tenantId`, `ownerId`, `streamId`, condition, source, tick size, version and status STARTING. There is deliberately no public create-alert API in Stage 2.

The replay log has a capped **12-hour default TTL** (configurable between 2 and 48 hours); immutable trigger history has no automatic TTL. TTL expiry can make an old cursor unrecoverable. The evaluator resets its baseline when it detects a missing replay sequence or unannounced generation. Retention must be sized from the staging event-rate sample, not set indefinitely without cost measurements.

## Mandatory acceptance matrix (NOT YET EXECUTED AGAINST RAILWAY)

| Test | Required result | Status |
|---|---|---|
| Pure crossing, zone, candle, source, reset, cooldown tests | Deterministic | Passed GitHub Actions |
| Market ingestion continues during evaluator restart | Replay accepted batches | Isolated Mongo replay verified; real provider restart still needs staging |
| Kill process during transaction | All-or-nothing trigger/state/outbox | Injected outbox-write rollback passed; true SIGKILL pending |
| Reprocess same batch | One trigger and one outbox logical job | Passed isolated Mongo replay |
| Run two evaluators | Old fencing token cannot write | Passed isolated Mongo takeover |
| Pause or increment rule version mid-evaluation | Outdated transaction aborts | Needs staging |
| Disconnect provider or force DB failure | Health interrupted, next observation is fresh baseline | Pure gap baseline and isolated Mongo segment-gap tests passed; live provider fault pending |
| Expire replay while worker offline | Explicit gap and no inferred crossing | Missing-sequence test passed; true TTL expiration pending |
| Force notification provider failure | Not applicable; Stage 2 has no sending | Stage 3 |
| Measure market events/s, batches/s, DB CPU/RAM/disk, write latency | Published cost report | Needs staging |

## Additional controlled fault-injection verification (2026-11-23)

The dedicated GitHub Actions MongoDB job now runs against a **throwaway local replica set** and contains these additional gates:

1. **Real process termination:** fork a separate Node evaluator, pause at four commit boundaries (after rule update, after trigger insertion, after outbox insertion, and after commit), deliver OS-level `SIGKILL`, restart a replacement, and reconcile rule/checkpoint/trigger/outbox counts.
2. **Lifecycle races:** externally pause or edit a loaded rule while its evaluator is suspended, then prove the old version cannot commit.
3. **Feed and database faults:** inject a feed interruption and a journal persistence error; assert the capture health becomes INTERRUPTED and recovery opens a fresh stream generation with a fresh price baseline.
4. **Real retention deletion:** configure the disposable MongoDB TTL monitor to delete an expired batch, then verify a persisted `AlertStage2ReplayGap` record and a fresh baseline, not an invented crossing.

`AlertReplayGap` is an immutable record written in the same transaction as an affected rule's checkpoint and monitoring state. It records the reason, previous replay cursor, first recovered position and rule version. When all pending batches have expired, the worker consults the durable stream coverage high-water mark, writes a gap and advances its checkpoint only with the gap evidence committed.

**Test type distinctions:** Child process `SIGKILL` is stronger than throwing inside the same Node process, but still uses a disposable CI MongoDB container. Fake provider/database interruption is not equivalent to losing Railway networking or the real market-data feed. Only a separate isolated Railway shadow run can validate operational lag, costs and actual provider behavior.

**CI evidence obtained:** [Alerts CI run 45090396375](https://github.com/abhilashalphonse/acg-trader-backend/actions/runs/45090396375) passed the four real OS-level `SIGKILL` boundaries with one logical trigger/outbox after restart. The earlier 7-case disposable Mongo integration suite in this run also passed including pause/edit races. Subsequent workflows include durable replay-gap records, forced journal failure and actual TTL removal; **only mark their current-head gate passed after the latest full workflow completes successfully**.

**Observed recovery timing:** Three in-transaction SIGKILL checks took about **90 seconds each** in the disposable CI environment; after-commit termination recovered much faster. These are end-to-end test elapsed times, not isolated database abort timings, and are not yet Railway recovery measurements. Record and investigate this latency against the operational alert recovery SLO before release.

## Railway isolated shadow-run report — 2026-11-23 (FINAL: FAIL)

**Decision:** **STAGE 2 FAIL — do not merge or enable customer alerts.** Test spend was user-authorised up to €15 and three hours. Test resources were removed after evidence collection; at final verification the private Railway project `acg-trader-alerts-stage2-staging` had **zero services, zero volumes and no staged changes**. The existing Trader production and old staging environments were not modified, and no notifications were enabled.

**Evidence provenance and scope.** A temporary MongoDB 7 single-member replica set `alertsTest`, persistent 1 GB Railway volume, a database acceptance runner, and separate capture and evaluator services were deployed to project `98a016a8-668d-401f-896f-00f407c5c15d`. The separate synthetic capture/evaluator were pinned to PR branch code commit `4d28fc74bc5a4ec7c590643aeabdd2c99432922d`; the post-test duplicate-key handling fix is commit `20afacb1cfda083fad89be2064717e81689e3d0f`. The database acceptance runner used a different, experimental branch (`feature/alerts-live-20261123` at `fea33f445a71de08bb0e2fed7fb58e250f6c96a4`), so its outcomes are not interchangeable with validation of the latest PR head.

| Evidence | Result |
| --- | --- |
| Actual Railway MongoDB transaction topology | Writable `alertsTest` single-member replica set confirmed using the private internal hostname |
| Database integration tests | 10/10 passed: expiry/backlog, rollback, lease takeover, rule pause/edit, feed outage, DB write interruption, TTL, missing sequences |
| OS process-kill recovery | 4/4 passed for SIGKILL after rule, trigger, outbox writes and after commit; no duplicate outbox/trigger |
| In-transaction SIGKILL test duration | ~88–90 seconds each (end-to-end per case); post-commit significantly faster; exact blocking source not yet isolated |
| Experimental native-alert integration tests | **2/3 failed**, initial capture lease Date-cast error; Stage 2 branch fix split coverage initialization from conditional lease acquisition, then handled duplicate-key standby; no green rerun of the failing experimental branch |
| Synthetic capture, bounded 100 s sample | 393 generated quotes (3.93/s); 396 durably accepted events including coverage markers; at least 182 batches accepted by second 92 |
| Synthetic interruption recovery | Explicit feed disconnection and forced journal persistence failure recovered with new generation and baseline markers; observed generations advanced to 6 |
| Evaluator shadow evidence | 289 trigger records and 25 rule-scoped gap records in the sampled evaluator process; outbox delivery remained disabled |
| Evaluation lag | Last observed ~58.5 s; peak observed ~188 s during catch-up. **Failed** to establish low-lag, stable backlog recovery |
| Live licensed market-feed integration | **Not tested.** No new Twelve Data subscription was opened; provider entitlement and connection limits could not be verified |
| Notification/trading isolation | No customer notification delivery or trading commands enabled |
| Cleanup | All four temporary services and the 1 GB test volume deleted; no remaining billable staging resources |

**Observed Railway resource samples** (last-hour measurement window includes off-time; peaks are not sustained averages): Mongo CPU 0.044 vCPU, RAM 0.176 GB, disk 0.042 GB; capture CPU 0.020 vCPU, RAM 0.031 GB; evaluator CPU 0.042 vCPU, RAM 0.040 GB; acceptance runner CPU 0.080 vCPU, RAM 0.110 GB. The additional duplicate MongoDB template and its 5 GB volume were detected early and deleted.

**Cost:** The connected Railway tooling does not expose itemised project billing or a final invoice. Therefore **the actual measured € charge is unavailable**. Using the published usage rates of approximately $20 per active vCPU-month, $10 per GB RAM-month and $0.15 per allocated GB-volume-month, even charging the observed resource peaks for the full ~18-minute window yields only about **$0.003 of modelled resource charges**. This is **not a billed cost** and excludes plan fee, egress, Railway billing rounding and unknown adjustments; the full €15 budget was not approached under measured resource consumption. Always confirm exact charges from Railway Usage/Billing.

**Monthly projection (very small synthetic workload only):** At the observed near-end sample rates (~0.048 vCPU combined, ~0.246 GB RAM, 0.042 GB data), continuous Mongo+capture+evaluator resource usage would be about **$3.4/month** excluding backup, persistent allocated volume, traffic, retries, storage growth, notifications, higher event volume and base subscription. This is *not* a production sizing forecast.

**Blockers before a PASS:** Identify and bound the ~90-second transaction recovery latency with timestamps separating Mongo lock cleanup, driver retries, evaluator lease and harness; establish target evaluation lag and prove backlog drains under a stable representative market feed; obtain authorised feed access and check provider limits; rerun failing native-alert integration tests against the same current PR head; obtain actual billed cost and a realistic load-based monthly projection. Production remains disabled until resolved.

**Release recommendation:** Keep PR **DRAFT**, retain Stage 2 as FAIL. The engine alone does not deliver the native customer Alerts feature; authenticated APIs, notification delivery and terminal UI follow only after Stage 2 reliability acceptance.

## Known limitations before implementation is considered complete

1. Need a controlled staging integration test against the actual MongoDB topology and event rates. Unit tests do not prove process-crash atomicity.
2. No public alert create/edit/pause API is exposed. Rule lifecycle and validation will require dedicated authenticated endpoints after Stage 2.
3. Source cadence and provider gaps cannot be reconstructed from candle high/low alone.
4. Keyset pagination passes a 475-rule fairness regression. Production-scale performance and long-running per-rule processing still require load tests.
5. Persisted stream health is updated on event commits/failures; downstream UI needs a staleness threshold and explicit source-health handling, not merely the last saved status.
6. Event-batch retention, outbox history and indexing need measured disk/transaction overhead on Railway.

**Gate:** No production alerts or UI integration until crash/restart, fencing, honest gap reporting, and actual staging cost measurements pass.
