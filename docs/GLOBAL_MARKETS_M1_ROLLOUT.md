# GLOBAL-MARKETS-M1 staged rollout

This runbook is the operational contract for the first India pilot. It does not authorize production activation.

## Safety invariants

- ACG Trader remains the authority for execution, valuation, FX conversion and immediate financial risk.
- ACG Funded consumes the versioned financial snapshot for challenge decisions.
- RELIANCE is the only Stage 2 execution pilot symbol.
- India pilot catalog synchronization defaults every India symbol back to `executionEnabled=false`.
- The pilot activation script refuses the Railway production environment.
- Existing positions retain their stored margin. Leverage policy v2 applies to new/increased exposure.
- Equity corporate actions are explicitly `UNSUPPORTED`.
- Never use a closed-session mark for customer execution or stop-out liquidation.
- Do not activate production until the complete release-gate evidence is signed off.

## Required staging configuration

The staging Trader service must have:

```text
MARKET_PROVIDER=multi
INDIA_MARKET_ENABLED=true
ACCELPIX_API_KEY=<staging credential>
INDIA_EXECUTION_PILOT_ENVIRONMENT=staging
```

Keep these disabled until the exact pilot window:

```text
INDIA_EXECUTION_PILOT_ALLOWED=false
INDIA_EXECUTION_PILOT_CONFIRM=
```

The current Stage 2 code does not contain or infer the Accelpix secret.

## 1. Deploy Stage 2 to staging

Deploy the Stage 2 backend only after Stage 0 and Stage 1 are included and CI is green.

Do not enable RELIANCE during deployment. A restart/catalog synchronization is expected to leave the India pilot disabled.

Verify normal service health and Funded event relay before continuing.

## 2. Check Global Markets readiness

Use the authenticated operations endpoint:

```http
GET /v1/operations/global-markets/readiness?symbol=RELIANCE
```

The report is `GLOBAL_MARKETS_READINESS_V1`.

Before pilot enable, the expected successful state is:

```text
status = READY_TO_ENABLE_PILOT
activationReady = true
executionReady = false
instrument.executionEnabled = false
instrument.defaultLeverage = 10
instrument.leveragePolicyVersion = 2
instrument.corporateActionPolicy = UNSUPPORTED
marketData.underlying.status = LIVE
marketData.fx.status = LIVE
```

The report must not expose credentials. A blocked result includes named blockers for provider config, India enablement, Accelpix credential presence, instrument terms, session state, underlying quote, USD conversion path or platform-event relay.

Run this gate during the NSE execution session. A closed session is intentionally not execution-ready.

## 3. Inspect pilot state

From the staging service environment:

```bash
npm run pilot:india:execution -- status
```

Expected before activation:

```text
executionEnabled=false
executionProvisionVersion=0
leverage=10
leveragePolicyVersion=2
quoteCurrency=INR
```

## 4. Open the staging-only pilot window

Only for the acceptance window:

```text
INDIA_EXECUTION_PILOT_ALLOWED=true
INDIA_EXECUTION_PILOT_CONFIRM=RELIANCE-STAGING-ONLY
INDIA_EXECUTION_PILOT_ENVIRONMENT=staging
```

Then:

```bash
npm run pilot:india:execution -- enable
```

Re-run the readiness endpoint. Expected:

```text
status = EXECUTION_READY
activationReady = true
executionReady = true
executionProvisionVersion = 1001
```

If any readiness check fails, disable the pilot instead of overriding the check.

## 5. Run the RELIANCE lifecycle acceptance

Use a dedicated clean USD staging account with zero open positions.

Required environment:

```text
ACCEPTANCE_TRADER_BASE_URL=<staging Trader URL>
ACCEPTANCE_TRADER_BEARER=<test customer bearer>
ACCEPTANCE_ACCOUNT_ID=<clean test account ObjectId>
ACCEPTANCE_RELIANCE_VOLUME=1
```

Run during an open NSE session:

```bash
npm run acceptance:global-markets:reliance
```

The acceptance runner proves:

1. RELIANCE is INR equity, leverage 1:10, policy v2 and explicitly corporate-actions unsupported.
2. The starting account is flat and its valuation is complete.
3. The server preview uses USD account currency and exposes USDINR conversion evidence.
4. Positive INR margin conversion uses the executable inverse ASK side.
5. Preview does not change balance, financial revision or position count.
6. A RELIANCE market position opens with INR PnL currency and USD-account margin.
7. Full close succeeds.
8. Open + close advance `financialRevision` exactly twice.
9. The final flat account has:
   - `positionCount=0`
   - `floatingPnl=0`
   - `usedMargin=0`
   - `equity=balance`

Keep the JSON report as release evidence.

## 6. Measure the non-mutating preview path

The capacity probe creates no trades.

Required environment:

```text
CAPACITY_TRADER_BASE_URL=<staging Trader URL>
CAPACITY_TRADER_BEARER=<test customer bearer>
CAPACITY_ACCOUNT_ID=<test account ObjectId>
CAPACITY_SYMBOL=RELIANCE
CAPACITY_VOLUME=1
CAPACITY_REQUESTS=<approved sample size>
CAPACITY_CONCURRENCY=<approved concurrency>
```

Optional release thresholds must be explicitly approved before use:

```text
CAPACITY_MAX_P95_MS=<approved p95 milliseconds>
CAPACITY_MAX_ERROR_RATE=<approved ratio from 0 to 1>
```

Run:

```bash
npm run capacity:global-markets:preview
```

The report returns request count, success/errors, error rate, p50/p95/p99/max/mean latency, HTTP status distribution and error-code distribution. The script intentionally does not invent product thresholds.

## 7. Close the pilot window

Immediately after the acceptance/capacity run:

```bash
npm run pilot:india:execution -- disable
```

Restore:

```text
INDIA_EXECUTION_PILOT_ALLOWED=false
INDIA_EXECUTION_PILOT_CONFIRM=
```

Verify:

```text
executionEnabled=false
executionProvisionVersion=0
```

A normal service restart/catalog synchronization also returns India pilot instruments to disabled, but the explicit disable command is the required rollback step.

## 8. Production gate

Do not enable production from this runbook.

Production activation requires, at minimum:

- Stage 0 financial correctness evidence.
- Stage 1 FX outage/recovery and mixed-market evidence.
- RELIANCE staging lifecycle PASS.
- deterministic restart/replay evidence.
- stop-out-under-FX-loss evidence.
- explicit corporate-action limitation visible to users/operators.
- approved capacity thresholds and a passing capacity report.
- monitoring/alert thresholds for quote age, FX availability, event relay and risk processing.
- documented rollback tested in staging.
- final operator sign-off.

Until those gates are complete, India customer execution remains OFF.
