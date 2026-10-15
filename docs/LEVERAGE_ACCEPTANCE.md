# Leverage transition and acceptance

Existing open positions retain their stored account-currency margin. A partial
close releases that reservation proportionally; a full close releases the rest.
Each new opening uses the current instrument ceiling, lower account leverage,
and any stricter margin rate. No position migration or automatic repricing is
part of this release. Ordinary P&L, challenge loss rules and stop-out still apply.

Pending orders use current terms at execution. Insufficient margin remains a
recorded terminal rejection. Missing or stale conversion quotes abort execution
without changing the order to REJECTED. The engine logs the error and retries on
a later qualifying instrument tick, reloading cancellation/expiry and checking
current price, permissions and margin. FX recovery alone does not promise an
immediate fill. LIMIT and STOP conditions are rechecked; an activated STOP_LIMIT
retains its TRIGGERED state and limit protection. This preserves existing STOP
semantics rather than introducing a new latched market-order state.

## Automated verification

- `node --test tests/trading/pending-fx-recovery.test.js`: real execution planner,
  converter, queue, service and engine with in-memory persistence; missing/stale
  FX, recovery, duplicate attempts, cancellation, expiry, trigger rechecks,
  insufficient margin and engine restart.
- `node --test tests/trading/asset-class-leverage-policy.test.js`: catalog ceilings,
  stricter limits, existing reservation, partial/full close and ordinary loss rules.
- `scripts/pr72-acceptance.js`: disposable MongoDB replica set, real session-token
  authentication over HTTP, trading routes, transactional execution, valuation
  and pending worker. Synthetic accounts and controlled quotes; this is not a
  live market-data provider acceptance test or a complete Funded lifecycle test.

The acceptance script refuses all database URLs except a local or isolated Railway
Mongo instance named `acg_pr72_acceptance`, and requires
`PR72_ISOLATED_ACCEPTANCE=1`. It resets that disposable database. Never supply
production credentials. Run this as a one-shot Node 20 job in an isolated Railway
project, checking out the exact PR commit before `npm ci`, `npm test` and
`node scripts/pr72-acceptance.js`. Ordinary deployments are unchanged.

## Release evidence required

Keep the PR draft until the corrected commit passes CI and isolated acceptance.
Run a read-only inventory of all account types, open positions, active pending
orders, position-margin sums and latest ledger balances. Retain the private
report outside the public repository. Classify cached equity differences
separately from ledger/margin discrepancies; do not silently repair records.

Confirm the real quote feed, SL/TP triggering, stop-out liquidation and challenge
lifecycle in the intended deployment configuration before a production release.
Repeat the account inventory immediately before rollout because trading can
change exposure after an audit. Preserve position reservations and account
history. Startup enforces catalog values in MongoDB, so rolling back application
code can also restore old catalog leverage; test a rollback that does not silently
re-enable the blanket 100x policy. Monitor pending FX failures, margin/ledger
discrepancies and unexpected liquidation after deployment.

## Non-negotiable production rollback contract

**Never restore the old pre-policy backend binary while trading can open new
positions.** Its startup catalog sync can reapply 100x to stocks, indices,
commodities and crypto. Roll back only to a known-good, *post-policy* revision
which retains `ACG_LEVERAGE_BY_ASSET_CLASS`, the authoritative margin floor and
startup policy enforcement. If such a revision does not exist, pause new
exposure and perform a forward fix rather than a binary rollback. Preserve
all existing position margins and ledger balances.

Required operational gates (read-only):
- Before deployment: run
  `PR72_READONLY_RELEASE_AUDIT=1 PR72_AUDIT_DATABASE=acg_trader node scripts/pr72-release-readonly-inventory.js`
  with an authorized MongoDB URI. Retain the output in private release evidence,
  **never in public PR comments**.
- Immediately after deployment and after every rollback: rerun with
  `--expect-approved`. All seven classes must match the catalog policy:
  Forex 100x, Metals/Energy/Other 50x, Indices 20x, Equities 10x,
  Crypto 2x. The guard fails on an unexpected leverage value, a
  stored-position margin discrepancy, or a latest-ledger balance mismatch.
- An existing-position margin discrepancy is a release STOP, not permission
  to reprice the position automatically. Examine any valuation-cache warnings
  separately; do not alter balances or ledger history merely to clear them.
- A passing guard does not substitute for authenticated frontend, Funded
  lifecycle, provider-fed execution, or liquidation monitoring.

These checks use collection reads only. Inventory is not a transactional
snapshot across collections: retain the observation time and repeat at the
release boundary when trading can alter positions.
