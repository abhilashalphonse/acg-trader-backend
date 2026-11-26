# ACG Trader AI — Foundation implementation (Stage 1A)

Status: proposed, isolated, no runtime activation. This patch introduces only a pure read-tool candidate policy and tests.

## Product invariants
- Equal access to supported capabilities; no mandatory subscription or feature-tier gating. Inference uses explicitly selected BYOAI allowance or prepaid ACG credits. Infrastructure quotas, entitlements and safety restrictions are independent of funding.
- Native conversation, approved external chat integration and persistent agents share an authoritative tool catalog and security boundary. External chat final responses belong to the host; never assume access to the entire host conversation or universal free-plan availability.
- Model outputs, external tool calls, retrieved content and memory are untrusted. Models never hold trading credentials, direct database access or the authority to grant themselves privileges.
- Existing manual trading, protection orders and account rules remain independent of AI. AI cannot guarantee profitability or prevent all losses.

## Existing integration points (initial inspection)
- src/app.js / src/server.js: Express routers and runtime lifecycle; do not mount AI routes in this patch.
- src/modules/trading/trading.routes.js: trader sessions, account grants, strict command schemas, policy checks.
- src/modules/trading/trading.runtime.js: account command queue, idempotency, market/pending services, valuation, risk and protection engines, reconciliation.
- src/modules/alerts/alert.routes.js: persistent rules, scoped ownership, quota transactions. Evaluate reuse of durable alert/event patterns for AI monitoring; do not duplicate market subscriptions.

## Staged release gates
1A. Read-only policy candidate contract. No HTTP routes, credentials, database changes, calls to providers or financial operations.
1B. Audit identity/tenant grant and data entitlements; implement trusted principal and persisted revocable grants, tool argument schemas and dispatcher; test default deny, cross-tenant/account and revoked connections. A positive pure-policy decision alone never authorizes dispatch.
2. Live context and quality: timestamped source evidence, quote freshness, deterministic calculations, knowledge provenance, response schemas and reproducible benchmarks. Reject unsupported facts rather than claim verified accuracy.
3. Provider adapters and isolated secret vault; explicitly chosen funding source, atomic prepaid reservation/settlement, usage limits, no unauthorized fallback; enforce egress allowlists and redaction.
4. Native workspace and conversation state; maintain provider-neutral memory and explicit context permissions.
5. Trade thesis tracking and event-driven read-only companion; durable jobs, checkpoints, bounded retries and notifications, stop on exhausted inference allowance.
6. Confirmed execution: transaction-specific immutable intent, server confirmation, expiry and revalidation; atomically reserve risk with core command processing, reconcile ambiguous broker outcomes, no blind retries. Account/broker/prop policies always win; no bypass.
7. External MCP integrations: OAuth resource/audience validation, scoped tokens and provider-specific tool policy. External host writes only where permitted; never circumvent host policy.
8. Strategy research, point-in-time backtesting and forward testing; versioned strategy and independent acceptance.
9. Bounded autonomy: separately approved versioned mandates, capital/exposure/loss/frequency limits, protective orders, kill switch, revocation and atomic risk accounting. Simulation then shadow then controlled live rollout only after independent review. Slippage and gaps can exceed modeled thresholds.

## Required acceptance before any live trading
Adversarial inputs, stale/incorrect quotes, cross-tenant access, concurrent orders, replay, partial fills, outage and restart, broker uncertainty, protective order continuity, credit exhaustion, injection and unauthorized strategy changes. Define quantitative acceptance thresholds and collect evidence before each release. No live execution authority in Stage 1A.
