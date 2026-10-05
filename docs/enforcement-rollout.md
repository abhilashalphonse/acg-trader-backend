# Enforcement implementation and acceptance

This branch is an implementation candidate. It has not been deployed or enabled in production.

## Runtime behavior

- News refresh runs in the background under a shared Mongo lease. An immutable snapshot and durable active pointer survive restarts. Execution reads the local snapshot without calling the calendar provider.
- A snapshot is fresh for 60 seconds by default, usable in grace until 15 minutes after fetch, then expired. Coverage expiry also expires it. Only mapped news instruments with effective news enforcement pause new exposure when data is unavailable/expired. Existing positions can still be reduced or closed subject to the normal executable-quote/session requirements.
- Market entry, pending creation/fill/activation, risky amendments and atomic reversal evaluate policy in their execution transaction. Retries evaluate time again. Account writes fence concurrent permission changes. Opening deals retain compact decision evidence in `metadata.executionPolicy`.
- A versioned account is enforced only when the relevant global flag is enabled, the account's stable bucket is below its rollout percentage, and the tenant's persisted control has not disabled it. News and weekend percentages are independent and default to zero; both global flags default false.
- Date overrides take precedence over holidays and recurring sessions. Weekend planning uses the final session of the week, including Thursday when Friday is a holiday. Schedule content hashes invalidate jobs even if an operator forgets to increment the numeric schedule version.
- The weekend scanner plans durable jobs. Two-hour warnings precede the processing window. Processing begins at T-10 minutes by default; the required-flat target is T-5. The worker installs an account restriction, cancels pending entries, closes positions and verifies the database before marking `CONFIRMED`. Failed work retries. Jobs claimed after market close become `MISSED`; they do not unexpectedly close positions after reopening.
- Every weekend side-effect transaction verifies lease owner/generation, permission version, schedule identity and current enforcement. New claims use a new idempotency generation; an expired worker's failed command cannot poison recovery.
- Change streams repair other instances' account/order/position caches. A 30-second database sweep provides fallback after stream interruption. Financial revisions are checked again during execution. Failed reloads make synchronization health unready. Repairs also trigger coalesced, tenant-scoped client snapshots, with at most four additional socket refreshes in flight. Reconnect/refresh snapshots read account, positions, orders and fills in one Mongo snapshot transaction and calculate valuations without replacing live execution caches.

## Configuration and deployment order

Use the names in `.env.example`. Existing deployment environment variables override defaults, including an existing `NEWS_CALENDAR_STALE_MAX_MS=300000`.

1. Keep `NEWS_TRADING_ENFORCEMENT=false`, `WEEKEND_HOLDING_ENFORCEMENT=false`, and both rollout percentages at `0` throughout deployment and migration validation.
2. Create the new critical indexes using the existing index command. Mongo transactions and change streams require a replica set.
3. Coordinate the Trader and Funded backend contract deployment. The old Trader strict route schema rejects the new permission-version field; the new Trader requires it for new non-demo accounts. A rolling mixture is not automatically compatible. Use a controlled provisioning pause/drain or land a separate schema-only compatibility release first.
4. Deploy the frontends. Password recovery reuses the existing `/auth/callback` Supabase redirect, as described in the Funded notes.
5. Dry-run the versioned migration, review per-account results, then apply to a selected staging account/cohort. Missing historical selections need an explicit approved cutoff. Do not guess a cutoff from this document.
6. Collect shadow results and complete staging acceptance before raising either rollout percentage. Use the persisted control below to stop enforcement without configuration propagation/restart.

The customer-visible processing window must be reviewed before enabling weekend enforcement. T-5 is a target requiring sufficient quote availability and capacity, not a guaranteed fill time.

## Operator controls and observations

The service-authenticated, tenant-scoped endpoints under `/v1/internal/operations` require the existing `accounts:write` scope:

- `GET /enforcement-control` returns the current revision and disabled flags (revision zero means no override).
- `PATCH /enforcement-control` accepts `expectedRevision`, at least one of `newsDisabled`/`weekendDisabled`, and a nonempty `reason`. For example, `{ "expectedRevision": 0, "weekendDisabled": true, "reason": "Investigating delayed closures" }` stops subsequent weekend decisions for the authenticated tenant. Refresh the revision before re-enabling. An outdated revision returns `POLICY_CONTROL_CONFLICT`.
- `GET /weekend-actions/summary` returns counts by state, overdue-flat count, late confirmations and an `attentionRequired` signal over the last seven days. Connect this signal to the deployment's alerting system before live weekend enforcement.
- `GET /policy-metrics?hours=24` combines persisted policy counters across instances for the authenticated tenant. The lookback is 1–168 hourly buckets, including the current partial hour. Groups separate preview checks from execution checks and distinguish actions. Counters include allowed, blocked, would-block news/weekend, unavailable/grace calendar observations and evaluation errors; p95/p99 are histogram bounds, not exact percentiles.

Every relevant policy decision reads the control from Mongo's primary, without a process cache. Commands that have already passed their authorization may finish; the switch is not a rollback of committed/in-flight trades. Disabling weekend enforcement leaves interrupted jobs retryable so re-enabling before the deadline can resume them. Global environment flags and rollout percentages remain upper bounds: clearing a disabled override cannot turn an otherwise disabled policy on. Failed control reads pause new exposure/work rather than trusting a stale enabled value; manual reductions/closures remain available.

Changes and their reasons are saved atomically with `PolicyControlAudit` entries whose model rejects subsequent updates. The Funded admin account detail now displays effective policy modes, permission versions and durable weekend-job outcomes, including late confirmations.

Policy metrics are operational measurements, not the trade ledger: transaction retries are separate evaluations, and an allowed decision does not imply a committed fill. Counters update only memory on the execution path, flush every five seconds and expire after 180 days. Absolute counters per process/hour make repeated writes safe after an uncertain database acknowledgement. Memory is capped at 1,000 tenant/hour/action/stage groups per process; health exposes dropped observations and flush errors. A crash can lose buffered observations, and prolonged database outages can exhaust the buffer. Errors before tenant identification count as dropped observations. Missing metrics must never be interpreted as proof of zero policy failures. The existing per-account raw events retain their 30-day TTL.

## Repeatable verification

Normal suite: `node --test`, with `NODE_ENV=test`, `MARKET_GATEWAY_ENABLED=false` and a local placeholder `MONGODB_URI` (for example `mongodb://127.0.0.1:27017/acg_unit_test`) for configuration validation. Database cases skip unless `TEST_MONGODB_URI` is supplied. Do not use production configuration for tests.

Use a disposable, local replica set and database named exactly `acg_policy_test`. The integration suite drops that dedicated database at completion and rejects other database names/remote hosts:

```powershell
$env:TEST_MONGODB_URI='mongodb://127.0.0.1:<port>/acg_policy_test?replicaSet=<name>'
$env:MONGODB_URI=$env:TEST_MONGODB_URI
$env:NODE_ENV='test'
$env:MARKET_GATEWAY_ENABLED='false'
node --test tests/integration/enforcement-transactions.test.js
```

The process-recovery case forks actual Node workers, pauses one after its close transaction commits, confirms another process cannot take its live lease, kills the first process and lets the lease expire naturally. The replacement confirms the job with generation two and exactly one closing deal. It uses a five-second lease to keep the test short; the runtime default remains 30 seconds. This covers local process death after commit, not deployed network loss or database election.

Set `RUN_SCALE_TEST=1` to add 500 active accounts, each with three positions and three pending orders, two workers with concurrency four each, separate execution services and valuation caches, 1,000 concurrent policy reads and one second between worker batches. Each worker lane drains up to 32 jobs per batch while holding one account lease at a time. This checks persisted flattening, zero remaining pending entries and zero late confirmations. Quotes are synthetic; the database and execution transactions are real. Both workers share one application process. Seeding is excluded from the reported processing duration.

The Windows local run on 2026-10-04 cancelled **1,500 pending orders**, closed **1,500 positions** and confirmed all **500 accounts in 50,911 ms**, including the worker batch delay and persisted control reads. The 1,000-read policy batch took **1,595 ms**. This replaces the earlier one-position/one-order baseline: batching was improved at the same time as the workload increased, so the timings are not a like-for-like comparison. These are not production capacity guarantees or authenticated-trader results. Shutdown finishes existing claims without draining additional jobs; interrupted work remains recoverable through expiring durable leases.

## 1,000 authenticated trader soak

`scripts/load-trader-sessions.js` connects distinct existing test sessions, verifies initial account snapshots, subscribes to quotes and holds connections with application heartbeats. It performs no order mutations. It requires at least 500 distinct accounts with open positions in the snapshots.

Create a private local JSON file outside version control:

```json
{
  "websocketUrl": "wss://YOUR-STAGING-HOST/v1/ws",
  "origin": "https://YOUR-STAGING-FRONTEND",
  "symbols": ["EURUSD"],
  "sessions": [{ "token": "TEST-SESSION-TOKEN", "accountId": "TRADER-OBJECT-ID" }]
}
```

Supply 1,000 entries with distinct tokens. Tokens must stay valid for the ramp and soak. Run:

```powershell
$env:ACG_LOAD_MANIFEST='C:\private\acg-staging-sessions.json'
$env:ACG_LOAD_TARGET_HOST='YOUR-STAGING-HOST'
node scripts/load-trader-sessions.js
```

Defaults: 1,000 traders, 500 active accounts, 60-second ramp and 300-second hold. Override using `ACG_LOAD_TRADERS`, `ACG_LOAD_ACTIVE_ACCOUNTS`, `ACG_LOAD_RAMP_SECONDS`, `ACG_LOAD_SECONDS`. Output contains counts, synchronization/ping percentiles and load-generator event-loop delay, without tokens. A passing connection soak does not establish order throughput, provider failover behavior or the weekend deadline SLA. Collect server CPU, event-loop delay, database latency/pool pressure and WebSocket egress alongside it.

### Local authenticated baseline

`tests/integration/authenticated-session-capacity.test.js` seeds 1,000 distinct sessions and accounts, opens positions on 500 accounts, then uses the real `AuthService`, WebSocket server, valuation engine and MongoDB. It launches the same load harness as a separate process, with synthetic quotes at four ticks/second. Enable `RUN_SOCKET_SCALE_TEST=1` with a dedicated local `acg_socket_test` URI. The test deletes only that database and its temporary manifest afterward. It does not exercise passwords/federation-ticket issuance, external quote providers, all background risk workers or multiple app replicas.

Measured on the Windows workspace on 2026-10-04: 20-second ramp plus 75-second hold; all 1,000 sockets synchronized and stayed connected; 500 distinct active accounts; 2,000 authentication checks including periodic revalidation; zero subscription errors, disconnects, ping timeouts, dropped lossy messages or slow-client closures. Initial synchronization p95 was 76.8 ms, ping p99 315 ms, server event-loop p99 109.3 ms, and WebSocket egress approximately 190 MiB over 95 seconds. This is a local baseline, with measurable event-loop/egress costs to validate under staging CPU/network limits.

### Combined local workload

Set `RUN_COMBINED_SCALE_TEST=1` instead of `RUN_SOCKET_SCALE_TEST` to run the same fixture with 1,000 connected traders, 500 accounts holding three positions and three pending orders each, and two separate weekend-worker processes. The socket process and both worker processes run independent valuation engines and change-stream/sweep reconciliation. The test waits for all initial account snapshots before planning weekend jobs, then holds the connections for 120 seconds after the 20-second ramp.

The load generator remains read-only. It checks not just socket survival but the clients' final authoritative snapshots: 500 previously active accounts must show zero open positions/pending entries and all 1,500 closing fills. Ordinary user order traffic, provider feeds, all risk workers and full deployed replicas remain outside this fixture. The local capacity test is therefore stronger than the separate baselines but is not production acceptance.

The final 2026-10-05 local combined run passed: all 500 accounts confirmed without late jobs in **73,985 ms**, including worker-process startup and shutdown but excluding fixture seeding/planning. All 1,000 sockets remained connected and observed flat state for all 500 active accounts plus all 1,500 closing fills. There were zero connection/subscription errors, ping timeouts, dropped lossy messages or slow-client closures. The 140.7-second ramp/soak recorded 2,806 authentication checks, synchronization p95 **286.6 ms**, ping p99 **441 ms**, server event-loop p99 **410.5 ms**, and approximately **233.4 MiB** of socket egress. The substantial event-loop delay is an unresolved performance concern, not a passed latency SLA; profile it and validate CPU isolation/sizing before rollout.

The first combined run exposed client-refresh gaps and disconnected 25 sockets while concurrent closes changed valuation revisions. The fixes now propagate remote reconciliation to clients and read consistent database snapshots without mutating live execution caches. The final passing result above includes both fixes.

## Remaining acceptance work

- Execute the authenticated staging soak and trading/order workload against at least two actual application replicas.
- Profile the measured combined-load event-loop delay and define/validate an execution and WebSocket latency budget under staging resource limits.
- Exercise process termination, database primary election, network loss, stale quotes, reconnect storms, and pending-entry races during flattening on the deployed topology.
- Complete the real purchase-to-Phase-2-to-Master acceptance flow across both deployed backends. `tests/integration/funded-lifecycle-contract.test.js` now verifies real Funded provisioning, HTTP connector/Trader routes and Mongo persistence through all three phases, including replay/stale-version rejection. It uses a seeded purchased account and a local service-auth fixture; it is not a payment-provider/pass-decision end-to-end test. Supply `ACG_FUNDED_BACKEND_ROOT` and a dedicated local `acg_lifecycle_test` URI to run it.
- Connect overdue/retrying/missed job signals to production alerting and rehearse the persisted kill switch in staging.
- Connect the aggregate policy-metrics endpoint to the deployment's monitoring dashboard and review the resulting evidence. Mapping anomalies, provider invalid-payload/reschedule history and committed execution outcomes still need consolidated reporting; current counters cover policy evaluations. Review calendar/job retention: raw shadow events expire after 30 days and aggregate policy counters after 180 days, while calendar snapshots and durable jobs currently have no automatic deletion.
- Confirm authoritative market-feed/valuation ownership and sizing. Cache repair and transactional revalidation do not establish a single feed owner across replicas.
- Validate provider completeness guarantees and an operator workflow for quarantined/rescheduled events. A syntactically valid but silently incomplete first provider response cannot be proven complete from the current provider payload alone.
