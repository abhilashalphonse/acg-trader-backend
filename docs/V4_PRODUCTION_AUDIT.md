# V4 post-release production audit: read-only, private

## Coverage and separation

Two independent workflows are proposed. Neither runs from a PR and neither
changes production data, leverage, customer accounts, orders or risk policy.

- **Five-minute readiness:** unauthenticated GET-only "/health/ready" checks
  database, market gateway, trading runtime, reconciliation and platform events.
  GitHub schedules are best-effort, not a monitoring SLA. This does **not**
  establish per-symbol quote freshness, 4xx reason breakdown or customer correctness.
- **Hourly comprehensive financial inventory:** require a dedicated
  **MongoDB read-only role on acg_trader**, a private release-position baseline,
  and an AES-256-GCM key. Reads across collections use one snapshot transaction,
  with no fallback to inconsistent reads and no writes.
  Reconstructs ledger continuity from oldest to latest including opening
  balance and signed amounts, flags accounts with no ledger rows, checks
  exact open-position margin sums, full catalog ceilings, five disabled NSE
  execution flags, transient and expired orders, repeated open deals, risk
  event backlog and baseline position volume/margin conservation.

The comprehensive audit is limited to 200,000 records **per collection** and
aborts rather than silently skipping a larger inventory. The initial
read-only release guard stays available for disposable CI as before:
only the explicit additional '--comprehensive' flag selects this audit.

## Secrets and production safety

Create a restricted GitHub **production-audit** environment on the backend
repository, limited to the protected main branch. Configure these **environment
secrets**, never repository source, chat, screenshots or PR descriptions:

- ACG_PROD_AUDIT_READONLY_MONGODB_URI: a dedicated Atlas user with the *only*
  assigned role 'read' on 'acg_trader'. The script refuses credentials with
  admin, readWrite, or other roles, even if supplied.
- ACG_PROD_RELEASE_BASELINE_JSON: **optional** authentic private snapshot of positions from the
  approved pre-release point; capturedAt must be an ISO time and each entry
  needs its immutable positionId, openVolume and margin. Example format:
  '{"capturedAt":"2026-10-14T00:00:00Z","positions":[{"positionId":"REPLACE_WITH_PRIVATE_ID","openVolume":"1","margin":"50"}]}'.
  The example values are placeholders, **not an actual baseline**.
  **The previously reported two open positions are not sufficient to
  reconstruct this data.** Never synthesize it from the current DB and claim
  preservation since pre-rollout. With no authentic baseline, the historical
  margin-preservation gate is **UNVERIFIABLE** while current financial
  reconciliation still runs and reports its own PASS/FAIL.
- ACG_PROD_AUDIT_ENCRYPTION_KEY: a randomly generated 32-byte key expressed as
  64 hex characters. Store privately and separately from archived artifacts.

Because this GitHub repository is public, never print production audit JSON
in Actions logs or upload plaintext reports. The workflow writes its plaintext
only in the ephemeral runner, encrypts it with AES-256-GCM before upload, and
retains only an encrypted artifact for 30 days. Archived report metadata
remains visible publicly, but ciphertext is not readable without the key.

Create the encryption key offline with Node's crypto.randomBytes(32); do not
paste it in chat or a build log. To decrypt a downloaded encrypted artifact on
a trusted local machine:

    PR72_AUDIT_ENCRYPTION_KEY=<private-key> node scripts/pr72-decrypt-audit-report.js encrypted.json private-report.json

Do not upload decrypted JSON to GitHub. Review missing-ledger flags carefully:
a never-traded demo account may legitimately have no ledger activity; this
is flagged as an incomplete evidence chain, not automatically corruption.

## Baselines and interpretation

A release baseline from before deployment is required for a verified
grandfathered-margin comparison. Partial closes must have matching deal
volumes, with stored remaining margin close to the baseline proportion
(with a $0.02 tolerance); fully closed positions must have no margin left.
Do not recompute historic position margins using new catalog leverage.

Snapshot consistency eliminates skew from reads of different collection
timestamps. Reconciliation discrepancies can still reflect application
inconsistencies or historical records. Investigate journal/deals before
classifying as corruption. No automatic repair, no credential escalation,
and no trading config or leverage rollback.

Risk ingestion and retry duplication checks are structural, not an FX
outage simulation. Intentional FX outage, stop-out and recovery testing
remain isolated in the disposable paired acceptance environment.

## Coverage still requiring independent evidence

The database audit cannot directly establish:

- Actual Firebase-hosted commit (GitHub merge does not prove deployed bytes)
- Fresh per-symbol quotes and cross-currency FX conversions under live accounts
- Correct authenticated customer session/account-switching/refresh valuations
- Railway application log warning resolution, 4xx classification and rate limits
- ACG Funded end-to-end challenge risk event delivery

Collect this evidence separately with read-only observability and an explicitly
authorized production test account. Do not use real customers' accounts for
synthetic trades. A green audit must be called **financial inventory PASS**,
not **all production gates PASS**, until these independent checks are signed off.

## Release gates

Before enabling:
1. GitHub PR review + all tests pass. Keep production deployment separately
   approved (backend main automatically deploys to Railway).
2. Configure restricted MongoDB user + GitHub environment secrets securely.
3. Verify baseline authenticity if available; otherwise record historical
   preservation as UNVERIFIABLE. Prove encrypted report recovery.
4. Manually dispatch once, download/decrypt/report on a trusted machine.
5. Classify the exact ledger/risk/order exceptions before treating the
   scheduled audit as an unattended financial gate.

Once enabled, check readiness runs every five minutes and inventory hourly.
The inventory schedule can be reduced to daily after stabilization by review.
The job prints PASS/FAIL/BLOCKED/UNVERIFIABLE rather than laundering missing
historical evidence into an aggregate green status. A status of UNVERIFIABLE
remains a nonzero CI exit until historical proof is obtained.
GitHub Actions schedule execution is best-effort; use Railway/provider alerting
for time-critical operational signals.
