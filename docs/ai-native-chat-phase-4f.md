# Phase 4F — Integrated acceptance and gated rollout

## Baseline and live smoke evidence (2026-11-27 UTC)
- Backend PR #110 baseline eec68e89d2255ee5edd4a94ac4824d483c06985b: Backend CI 45931374090 and paired 45931380434 passed.
- Frontend PR #244 baseline 9ae44ba630153643e02389900002a7af7bf1c3bf: six workflows passed, including paired 45925102076.
- Separate isolated verification branch commit 06fc2886354419c2c9e50d7010904b8700540253, Railway STAGING deployment 7374662e-9b66-498e-9e5e-cc6563b0def7: all startup checks true, original receipt absent, exclusive claim verified, gpt-6-luna VERIFIED (277 input and 79 output tokens, reference selection only), receipt preserved. No customer data exported or ACG credits deducted.
- Same-volume replay deployment 2d99fd7f-7279-4569-ac81-ff2895a09806: ORIGINAL_CLAIM_EXISTS then PREVIOUS_VERIFIED; no second provider dispatch. Owner usage screenshot shows one request, $0.00 rounded, 277 displayed total tokens. Exact billed amount and discrepancy with reported token total remain unresolved. No further billable test is authorized.
- Smoke is a standalone synthetic CLI, not an authenticated native chat dispatch. Its success does not approve a runtime model descriptor, customer data export, production credits, or production activation.

## Integrated acceptance gates
1. Connect native desktop/mobile chat in an isolated harness to the actual authenticated loopback API; capabilities, preflight, create/list/history/append/cancel/delete/analyze. Pin account and connection authority, use existing trader-session authentication, reject foreign scope and suppress stale responses after account/chart/session change or cancel. Explicit chart consent, only server-resolved evidence. Do not invent assistant responses.
2. Bind provider operation identity to immutable durable message identity before admission. Exercise provider transport with local TLS fixtures only; no external inference, no credit/payment activation. Verify returned references, persist only independently validated results, enforce cancellation, expiry, revocation, idempotency and unknown-outcome holds. This requires new server composition beyond existing isolated report and standalone smoke.
3. Cross-session real authentication, persistence/reload, pagination, desktop/mobile browser runs, network failures, account changes, revoked grants, and full trading/financial regressions. Require exact-head backend/frontend CI and paired acceptance; record actual runs, not predicted success.
4. Before rollout, review live model descriptor, key custody, retention/DLP, customer consent, actual billing and production distributed spend policy; explicitly approve any future billable tests. Preserve default-off behavior and rollback plan. Do not merge or activate production based on isolated acceptance alone.

## Initial implementation
Frontend transport boundary on PR #244 accepts an explicit isolated host-injected authenticated POST and current-authority fence. It pins authority, allowlists route/payload keys, rejects non-offline/charged/mismatched envelopes and suppresses late results. No terminal mount or production network transport. Unit fixtures are not integrated browser/API acceptance.
