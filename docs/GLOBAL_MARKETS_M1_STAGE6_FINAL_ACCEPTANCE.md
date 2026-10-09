# GLOBAL-MARKETS-M1 Stage 6 — final acceptance evidence

This stage adds a **staging-only** financial lifecycle probe. It is not a
production enablement or customer execution switch. The RELIANCE instrument
remains `executionEnabled=false` until the staging pilot is explicitly
enabled using the existing protected pilot command.

## New acceptance scope

`npm run acceptance:global-markets:final` proves, in a dedicated USD account:

1. Live staging-only RELIANCE pilot definition (NSE session, 1:10 stock
   leverage, v2 policy, INR denomination, corporate actions explicitly
   unsupported).
2. Exactly `$50` (or the configured positive USD amount) of intended stop
   risk, with backend quantity step rounding down and real conversion evidence.
3. Account-currency `AMOUNT` sizing and both INR-native and USD account
   exposure.
4. Previews do not mutate the account or financial revision.
5. Authoritatively sized market open with a maximum USD risk ceiling
   **revalidated** by Trader at execution.
6. Step-aligned fractional partial close preserving native INR PnL and
   immutable USD/INR conversion path, and correct remaining open volume.
7. Full close preserving its *own* native PnL and conversion evidence.
8. Exactly three financial revisions (open, partial close, full close), a flat
   account (`equity=balance`, zero used margin/floating PnL), and both
   immutable close deals accessible through trader deal history.

The pilot catalog defines RELIANCE as **simulated fractional equity exposure**,
with `minVolume=0.001` and `volumeStep=0.001` share equivalents, while all
other India chart-only names retain whole-unit quantities. This does not
represent routing real fractional NSE shares. Legal/commercial product terms
and corporate-action safeguards must be approved before customer activation.

## Running in STAGING only

Requirements:

- Trader and Funded staging healthy, with current financial-contract builds.
- A dedicated USD test account that is flat and trading-enabled.
- An open NSE session, current RELIANCE Accelpix quotes, and fresh USD/INR FX.
- The staging-only pilot explicitly enabled by an authorized operator using
  the existing `pilot:india:execution` command and readiness gate.
- An authenticated bearer granting access to **only** the dedicated test
  account.
- A stop loss explicitly chosen from the *current* RELIANCE execution quote;
  the runner never invents a price.

Example environment configuration (substitute secure values locally; do not
check secrets into the repo or CI logs):

```bash
export ACCEPTANCE_TARGET_ENVIRONMENT=staging
export ACCEPTANCE_TRADER_BASE_URL=https://discerning-presence-staging.up.railway.app
export ACCEPTANCE_TRADER_BEARER="<dedicated staging test account token>"
export ACCEPTANCE_ACCOUNT_ID="<dedicated staging ObjectId>"
export ACCEPTANCE_RELIANCE_STOP_LOSS="<valid INR stop below current BUY price>"
export ACCEPTANCE_RELIANCE_RISK_USD=50
export ACCEPTANCE_RELIANCE_AMOUNT_USD=196.90
export ACCEPTANCE_ALLOW_MUTATIONS=GLOBAL_MARKETS_RELIANCE_STAGING_ONLY

npm run acceptance:global-markets:final > stage6-evidence.json
```

The runner will **refuse** an HTTP URL, a host without `staging`, any
`production` host, missing account authorization, missing positive stop, or
missing explicit staging mutation acknowledgement. The runner does not turn
on pilot execution by itself.

On failure after open, it attempts a single idempotent full-close cleanup,
emits an explicit `cleanup.success` flag, and exits nonzero. If that cleanup
fails, the test operator must handle the surviving position and assess
protective policies before disabling the pilot.

## Closed NSE / EURUSD mixed-market acceptance

A separate controlled runner exercises the specific release gate the original
product plan requires: RELIANCE remains OPEN and NSE has CLOSED, but EURUSD
must be independently tradable on the same USD account.

Use a **separate staging account** with an approved RELIANCE position opened
during an earlier NSE session. Preserve the position for an after-hours test
on a weekday when EURUSD trading is live. Do not simulate NSE closure by
changing wall-clock time or marking a live quote stale.

Use the same dedicated staging URL, bearer, account and explicit mutation
acknowledgement configured above, then:

```bash
export ACCEPTANCE_EURUSD_VOLUME=0.01
npm run acceptance:global-markets:mixed-market > mixed-market-evidence.json
```

The runner requires an actual closed RELIANCE session, a live EURUSD session,
an intact open RELIANCE position and a complete USD account valuation. It
previews EURUSD, opens and closes that Forex position, and verifies that
RELIANCE retains its original ID and quantity. It deliberately does not
close RELIANCE or count an approved closing mark as authorization for Indian
share execution.

A failure after EURUSD opens attempts a one-time idempotent EURUSD cleanup
close, then exits nonzero. Manual operator recovery is required if cleanup
fails. If the NSE closing mark is unexpectedly stale or missing, the test
fails rather than masking the valuation outage.

## Additional required acceptance, not covered by this runner

**Do not mark production authorized** from this probe alone. Also retain
independent, verifiable evidence for:

- Closed NSE + held RELIANCE + live EURUSD mixed-market trading.
- FX expiry, provider outage, protective-close retry and restart recovery.
- Stop-out triggered by a USD/INR-only loss with market availability separated
  from valuation completeness.
- Trader payout checkpoint → Funded approval → one durable reservation →
  provider-success/replay → one immutable USD ledger debit → exact Funded
  financial revision, plus verified failure and cancellation.
- Actual process-kill/restart, transactional failover, multiwriter ownership
  and pending webhook races.
- Corporate-action protection for open positions, explicit approved FX-outage
  close policy, approved post-payout risk-baseline recalculation.
- Global Markets operational gate, approved quote/FX ages and capacity p95,
  alerting thresholds and tested rollback.

Keep RELIANCE customer execution OFF until those requirements, product
compliance, data-feed entitlements and independent release review all pass.


## Stage 6: fresh fixture from staging SUPER_ADMIN session

**Dependency:** Funded staging must first deploy the audited
`/api/admin/launch-readiness/:runId/stage6-ticket` endpoint from Funded
Stage 6 PR #57. Trader stage 6 bootstrap is run **locally** on the current
Trader Stage 6 branch, not through Railway's service command.

The bootstrap uses only the valid **staging SUPER_ADMIN bearer** obtained
from the user's own authenticated staging admin session. Do not paste JWTs
into chat, source control, reports, logs, PowerShell transcripts or screenshots.
Only the trusted operator environment should hold this bearer.

```powershell
$env:ACCEPTANCE_TARGET_ENVIRONMENT="staging"
$env:ACCEPTANCE_TRADER_BASE_URL="https://discerning-presence-staging.up.railway.app"
$env:ACCEPTANCE_FUNDED_BASE_URL="https://zealous-benevolence-staging.up.railway.app"
# Securely place the authenticated staging admin JWT into
# $env:ACCEPTANCE_ADMIN_BEARER in the local operator session.
npm run acceptance:global-markets:bootstrap -- --create-fixture
```

The create-fixture command asks Funded's existing admin-only launch-readiness
factory to create a new dedicated acceptance customer and two **active $10k
USD Challenge accounts**, instead of recycling a challenge consumed by
the previous lifecycle runner. It returns only the run ID and test fixture
identifiers. Record the returned run ID locally:

```powershell
$env:ACCEPTANCE_RUN_ID="<runId output from --create-fixture>"
```

An authorized operator must independently enable the **RELIANCE STAGING
pilot only** through `npm run pilot:india:execution -- enable` after
verifying the staging MongoDB URI and required
`INDIA_EXECUTION_PILOT_*` controls. Check the configured session and live
Accelpix quote. Never run pilot activation with a production Mongo URI.

Then run the staging bootstrap preflight:

```powershell
npm run acceptance:global-markets:bootstrap
```

The preflight asks the authenticated Funded staging admin endpoint for
a **one-use federation ticket** scoped to its own clean acceptance Challenge,
exchanges it with Trader, verifies account access, complete USD valuation,
1:10 RELIANCE pilot policy, and fresh Accelpix execution-preview price.
It computes an approximate 2%-below-buy-price **tick-aligned stop loss**.
Neither ticket nor Trader bearer appears in the JSON output.

After the preflight passes, with the NSE session open and the authorized
account still flat, explicitly acknowledge mutation and execute:

```powershell
$env:ACCEPTANCE_ALLOW_MUTATIONS="GLOBAL_MARKETS_RELIANCE_STAGING_ONLY"
npm run acceptance:global-markets:bootstrap -- --execute
```

The original Stage 6 runner remains responsible for authoritative USD
risk/amount preview, fractional RELIANCE open/partial/full close, immutable
INR/USD settlement, three financial revisions and final flat state.
On failures inspect cleanup evidence, verify the account is fully flat,
then **disable the RELIANCE pilot** using the staging database.
Do not mistake unit/CI pass for live acceptance.

**Fail-closed:** Production/non-ACG hosts, missing admin authentication,
foreign/consumed acceptance runs, invalid staging confirmation, disabled
RELIANCE, stale/non-Accelpix quote, closed NSE, non-flat accounts and missing
trading mutation acknowledgement all prevent execution.
