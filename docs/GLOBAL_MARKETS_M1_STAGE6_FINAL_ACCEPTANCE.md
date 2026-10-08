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
