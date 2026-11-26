# ACG Trader AI — Foundation implementation (Stage 1A)

Status: draft, read-only native pilot code; disabled by default. Stage 1A policy plus Stage 1B–E implementation increment. No production activation.

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


## Stage 1B–E implementation increment (native personal demo only)

Opt-in `ACG_AI_READ_GATEWAY_ENABLED=true` mounts `/v1/ai/read`. Default is absent; no production environment changes are part of this PR. Requires existing Supabase personal-demo session path, live VIEW account grant and current tenant/user-owned demo account. Legacy password/federated sessions, partner accounts, external MCP and agents are not enabled. This is an intentionally narrow pilot; no real-money or Funded access.

- GET /tools: authenticated discovery of implemented tools (not a grant).
- GET /grants/:accountId: current session/account grant.
- POST /grants: explicit first-party user consent to a nonempty allowlist of implemented tools.
- POST /grants/revoke: revoke the exact current session/account connection.
- POST /invoke: strict envelope {accountId, connectionId, toolId, args}, authenticated independently on every request and again before result disclosure.
- Persisted grants are limited to one per session/account, with a server-generated connection ID, maximum one-hour lifetime, no reactivation within the same session and majority writes. Revocation and expiry fail closed; a new authenticated session is needed for a new grant. The _id index is sufficient for point lookups. Retention/cleanup and reauthorization UX are pending; do not enable broadly until resolved.
- Implemented tools: account.valuation.read (persisted account state, explicitly not live), account.positions.read, account.orders.read (bounded to 50 records; truncation disclosed). All data queries are tenant/account scoped and output is field-projected. No market quote/candle or policy tools are dispatched yet: entitlement, provenance, freshness and policy response review remain pending.
- Session tokens remain in first-party client/server boundaries; never expose them to a model. The connection ID is not a bearer credential. Grant management is not a tool. No financial writes are registered. No provider calls, model runtime, or automatic approvals.
- Store reads use primary/majority and query limits; session-bound request limit is 30/min per process. Distributed rate limiting and durable audit are later Phase 1 gates. Revocation is checked again before returning data; already disclosed results cannot be recalled and in-flight races require further evaluation.
- Tests cover policy and gateway scope/expiry/revocation/unknown tools/projection and HTTP authentication/envelope. Real replica-set and real auth integration acceptance, race/failure tests, full security review, staging and production remain outstanding. Do not activate production from unit tests alone.
