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


## Reuse the previous Funded acceptance credentials (Stage 6 bootstrap)

Run the bootstrap from a trusted operator shell on the Stage 6 branch. It
reuses the existing **Funded lifecycle acceptance** customer, admin bearer and
Challenge A fixture. It requests a customer trading-launch ticket, exchanges
the ticket for a short-lived Trader token, confirms the token grants precisely
the selected account, checks a flat/complete valuation, obtains an
authoritative RELIANCE BUY preview, and derives a 2%-below-fill tick-aligned
stop from the actual fresh Accelpix-backed preview (override percentage with
`ACCEPTANCE_RELIANCE_STOP_DISTANCE_PERCENT` only when justified).

Required existing secure acceptance environment variables:

- `ACCEPTANCE_CUSTOMER_ID`, `ACCEPTANCE_CUSTOMER_BEARER`, `ACCEPTANCE_ADMIN_BEARER`
- `ACCEPTANCE_CHALLENGE_A_ID` (or `ACCEPTANCE_CHALLENGE_ID`) for a **currently
  active**, dedicated acceptance-customer Trader account
- `ACCEPTANCE_TARGET_ENVIRONMENT=staging`
- `ACCEPTANCE_TRADER_BASE_URL=https://discerning-presence-staging.up.railway.app`
- `ACCEPTANCE_FUNDED_BASE_URL=https://zealous-benevolence-staging.up.railway.app`

If the previous lifecycle acceptance account progressed to review/closed or
is not flat, provision a new **dedicated acceptance-customer** test fixture
through the existing authorized Funded staging flow. Never select a live
customer or silently recycle a mutated account.

Perform the read-only bootstrap check, *after* the authorized STAGING pilot
activation and a fresh NSE session quote:

```bash
npm run acceptance:global-markets:bootstrap
```

The bootstrap returns a sanitized JSON evidence summary containing account ID,
execution-preview INR BUY price, fresh quote timestamp/source, calculated
tick-aligned stop, and financial revision; it never prints the federation
ticket or Trader access token. It refuses production URLs, non-acceptance
identities, missing grants, stale quotes, incomplete/non-flat accounts,
disabled RELIANCE execution, and closed NSE sessions.

For the live, state-mutating Stage 6 lifecycle test, **explicitly** set
`ACCEPTANCE_ALLOW_MUTATIONS=GLOBAL_MARKETS_RELIANCE_STAGING_ONLY`, then:

```bash
npm run acceptance:global-markets:bootstrap -- --execute
```

The bootstrap passes the discovered Trader account ID and ephemeral access
token **in process memory** to the original `acceptance:global-markets:final`
runner. Capture its PASS/FAIL financial evidence. The baseline runner retains
its idempotent cleanup attempt after a partial failure.

**Pilot activation is not automated by this bootstrap.** An authorized operator
must separately run `npm run pilot:india:execution -- status` and (only with
the staging MongoDB connection and the three explicit
`INDIA_EXECUTION_PILOT_*` guard values set) run
`npm run pilot:india:execution -- enable`. After acceptance, verify no
position remains and run `npm run pilot:india:execution -- disable`.

Both existing acceptance bearers can expire; this script cannot regenerate a
Funded customer/admin login token when they have expired. Refresh them via the
normal staging identity login, never by copying production credentials. Never
commit secrets or put tokens in the acceptance report.
