# Phase 4B — Secure native chat API contract and model discovery

Phase 4A frontend draft PR #244, head 2242ab0608c67497e32419215561af0abb681897, passed all six workflows including native AI preview 45921241062 and paired acceptance 45921241224. Visual sign-off remains separate.

Backend base 957c07295748780e22498b80cfdd4399937e1cd9, Phase 3 disabled foundation.

## Isolated contract

The router is not mounted in the production application. Construction and request processing require the Phase 3 isolated Mongo guard. The test HTTP listener binds loopback only.

- POST /v1/ai/chat/capabilities: exact accountId and connectionId only. Returns native-chat-v1, planned provider targets (all runtime disabled), bounded synthetic rehearsal options filtered by the server registry and explicit purpose permission, disabled funding modes and sendEnabled false. No synthetic model is advertised as live. Custom endpoints are not selectable.
- POST /v1/ai/chat/preflight: same authority fields, exact provider/model/descriptor/funding selection, EDUCATION profile only. Validates the current descriptor and server policy. Only BYO synthetic rehearsal can validate. Returns VALIDATED_OFFLINE_ONLY, dispatchAllowed false, creditDeducted false, runtimeEnabled false. This is not a durable authorization, lease or payment quote.
- No message submission, streaming, stored conversations, API key handling, account values, trading tools, provider network calls or monetary operations. No prompt is accepted by either endpoint.

Real authenticated Supabase identity, personal demo account access, current native read grant, tenant governance revision, shared persisted user quota, bounded concurrency and strict uncompressed 8KB JSON boundary are required. Purpose permission is a separate trusted injected fixture, not production consent or entitlement. Repeat session, grant and policy validation before disclosure; no claim of atomic authorization across external delivery. Audits contain fixed operation metadata only. No response caching. Synthetic catalog discovery is bounded to 16 reviewed eligible descriptors; a denied descriptor is omitted. No arbitrary endpoint or live model selection.

## Acceptance
Real replica-set integration uses existing AuthService, account grant, quota, governance audit and current identity fixtures. Test absent authentication, foreign scope, invalid grant, stale/unregistered descriptor, disabled managed funding, extra prompt/context and query fields, unsupported media, denied/revoked purpose, no messages route and safe metadata. Actual application smoke asserts GET/POST on the new paths return 404 even with Phase 1 flag on. Existing financial, provider and security suites remain required.

## Next
4C durable scoped conversation lifecycle and message idempotency; 4D trusted workspace evidence and verified rendering; 4E live-provider readiness and activation controls; 4F integrated UI/production pilot. Frontend API wiring waits for the authorized lifecycle and runtime contract, not this rehearsal. No activation or production release from 4B.
