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


## Stage 1F: financial safety boundary (read-only release)

An independent immutable allowlist now gates HTTP invocation, gateway dispatch and registry resolution. It also constrains permission creation and rechecks persisted grant scope before result disclosure. All financial writes, including close/reduce/cancel/protection changes, remain prohibited through this AI path even if a future registry change accidentally lists them. Tools receive only a scope-bound read port, not grant mutation, runtime or execution services. No manual trading route or trading-engine logic changed. This is a code-level boundary, not process isolation against arbitrary code execution.

The normal trader bearer credential is still powerful and must never be exposed to a model or agent. Scoped model-facing credentials, separated worker privileges and durable governance are prerequisite to provider integration. This increment is not a proof that all other trading endpoints reject a stolen normal user token.

### Future execution contract (not activated or implemented in Stage 1)

- Model output is a proposal, never an authorization. Immutable server-side intent binds actor, tenant, account, instrument, order/position reference, exact quantity/prices/protection and acceptable price deviation; no client-controlled approval flag. Authorize a single intent with expiry and replay protection.
- Core risk engine checks authoritative executable bid/ask freshness, market session, account and broker policy, position size, margin, stop-loss geometry, currency conversion, aggregate exposure, daily loss and drawdown. Fail closed on missing/stale inputs. Risk reductions are also authorized.
- Serialize/reconcile competing manual and AI commands against the same authoritative financial revision; reserve risk atomically with execution. Stable idempotency key and uncertain-outcome reconciliation, never blind retries.
- Autonomous mandates require separate versioned user authorization, allowed symbols/strategy, capital allocation, risk ceilings, frequency, time scope and revocation. Agents may not modify their own mandate or approve increases. No autonomous authority until Phase 9.
- Kill switch must prevent new AI requests without disabling existing broker/engine protection or manual trading. Explicit treatment of in-flight and pending orders is required.
- Acceptance must exercise actual replica-set data, concurrency, broker uncertainty, slippage/gaps, authorization/revocation races, simulated outage, and protected manual-path regression before enabling financial actions. No guarantee of realized maximum loss.

Phase 1F tests cover exact allowlist, registry alignment, scoped capability surface, malformed limits, corrupt grants and HTTP write rejection. Real integration and production acceptance remain outstanding.


## Stage 1G: audit and governance

- The read gateway is still default-off. A mounted gateway additionally requires a positive, revisioned tenant control record; missing or unavailable control fails closed. No production enablement or new credentials are part of this PR.
- A server-generated correlation ID connects durable ATTEMPT and ALLOWED/DENIED/FAILED events. An ALLOWED record means operation completed, not that the client received its data. A subsequent control change can create a SUPPRESSED event. A missing outcome is an unresolved attempt, not evidence of success.
- Authenticated known HTTP operations are audited, including malformed envelopes, unauthorized tool requests, grants and revocations. Pre-authentication failures, rate-limit failures, unmatched paths, admin audit reads and service authorization denials are not covered by this durable event stream; existing HTTP handling applies. Broader security telemetry is outstanding.
- Records contain only scoped identity references, validated requested account identifiers (not proof of entitlement), fixed operation/tool identifiers, bounded reason codes, revision and timestamps. No prompts, arguments, balances, token values, raw errors or results are stored in the audit event. Unknown identifiers are not logged verbatim. Admin actors are represented by a hashed client ID.
- Durable append failures block ordinary operation before work or prevent disclosure afterward. Revocation intentionally remains available during a tenant pause or audit failure, while the route is mounted; audit failure is logged without request content. A grant write can have committed even if outcome logging fails; inspect current state before retrying. Revocation and already completed reads cannot be retroactively undone.
- Internal service routes: GET /v1/internal/ai/control requires ai:governance:read, PATCH /v1/internal/ai/control requires ai:governance:write, GET /v1/internal/ai/audit requires ai:audit:read. Exact scope required; wildcard alone is rejected. Tenant derives from the authenticated service principal, never request parameters. Control changes compare expectedRevision and atomically write the control and audit event with majority transaction commit. Reason is a fixed enum. Audit listing is bounded to 100, tenant-scoped, newest first.
- Pause is a suspension, not permanent grant revocation. Re-enabling may restore still-valid grants; user revocation remains permanent for its existing session/account. Every gated request checks control before work, after work and after audit completion; a revision change prevents disclosure. Final in-flight network/disclosure races and grant revocation during audit writes still need integration testing; this is not an atomic delivery guarantee.
- Audit append-only restrictions are application/model-level, not tamper-proof against privileged database or arbitrary code access. Dedicated DB privileges, export/retention policy, monitoring for unresolved attempts, distributed rate limits, and independent worker isolation are later gates.
- Before isolated staging activation explicitly create and verify AiAuditEvent indexes (tenantId, occurredAt, _id) and both governance collections. No automatic AI index changes in core trading startup. Test replica-set majority writes, transaction rollback, revision conflict, denial under outage, pause propagation, tenant isolation and capacity. No retention TTL is selected until a retention policy is approved.
