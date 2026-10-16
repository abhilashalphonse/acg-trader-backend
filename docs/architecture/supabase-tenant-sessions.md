# AUTH-1B: Supabase identity → tenant-scoped trading sessions and live grant reconciliation

This PR is **stacked on** `feat/supabase-identity-foundation` (draft PR #81).
Neither PR may be merged directly to production without coordinated acceptance.
Existing native account/password sessions and ACG Funded federation are unchanged.

## Opt-in deployment contract

- `SUPABASE_IDENTITY_BOOTSTRAP_ENABLED=false` by default; requires `SUPABASE_PROJECT_REF`.
- `SUPABASE_TRADING_SESSIONS_ENABLED=false` by default; requires bootstrap enabled.
- Both switches must be explicitly enabled before these new endpoints appear.
- Setting `SUPABASE_TRADING_SESSIONS_ENABLED=false` also rejects **existing**
  SUPABASE-origin sessions during HTTP authorization/refresh and on the next
  WebSocket grant check. Native and federated sessions are not affected.
- Existing ACG Trader refresh cookies and opaque access tokens are reused.
- Signed Supabase JWTs are accepted **only** to exchange a verified global identity for an ACG Trader session; they are never treated as trading permissions.

## Session creation

1. `POST /v1/identity/bootstrap` verifies a Supabase token and idempotently
   establishes global `User` + `LoginIdentity`, returning `SETUP_REQUIRED`.
2. A trusted tenant integration provisions an explicit account-access grant.
   `PUT /v1/internal/identity/accounts/:accountId/access/:userId`, authorized by
   an existing tenant-scoped service key with `accounts:write`, accepts
   `{ "permissions": ["TRADE", "VIEW"] }`. Only an account belonging to that
   tenant can be granted. Admin membership alone is never sufficient.
   `DELETE` at the same path revokes only `source: PARTNER` grants.
   Personal grants cannot be replaced or revoked by this partner endpoint.
3. `POST /v1/auth/supabase/exchange` accepts a Supabase access JWT as Bearer
   and `{ "tenantId": "<24-hex Mongo ID>" }`. It looks up an **existing**
   verified login identity; it never links an account or creates a user.
   It requires at least one current `TRADE` grant in that tenant and returns
   the established ACG Trader trader session response and an HttpOnly rotating
   refresh cookie. New session `authMethod=SUPABASE`, `userId` and
   `loginIdentityId` are persisted. Sessions retain exactly one tenant.
4. Sessions with only `VIEW` or `MANAGE` grants do not get trading access;
   read-only experiences need explicit route permission separation later.

## Revocation and tenancy

- Every HTTP trader request re-authenticates the ACG session; Supabase sessions
  resolve *current* user status, provider identity status, active tenant,
  active non-expired `TRADE` grants, and accounts in that exact tenant.
- Expired/revoked grants result in no authorized accounts. Disabled user,
  linked identity or tenant invalidates the trader session. Refresh rotation
  also resolves live grant state; stored session account IDs never authorize
  new Supabase requests.
- WebSockets check current grants on every incoming command and poll
  MongoDB every 2 seconds for Supabase-origin sessions, on each backend
  replica. Revoked accounts are removed from active subscriptions, buffered
  account events and scheduled valuation deliveries. An invalidated person
  session causes the socket to close. Account snapshot responses additionally
  filter against the currently active socket account set.
- The WS revocation target is **2 seconds plus DB/query/event-loop latency**,
  not zero-latency guarantee. Integration and load testing must bound measured
  p95/p99 latency under normal and failure conditions before rollout.
- No claim is made that ACG Funded's historical owner-reference federation
  grants use this new explicit-grant policy. Their migration is separate.

## Remaining work

- End-to-end staging smoke with real signed Supabase tokens and tenant grants.
- Frontend Supabase OAuth/auth forms, trader-context selection and switching.
- Idempotent DEMO provisioning for standalone users; no accounts created here.
- Sender/provider email auto-link audit and proof-of-control linking policy.
- Explicit VIEW-only route semantics, profile migration, secure partner OIDC.
- Production security/performance audit for 2-second socket revalidation load,
  and audit log retention for partner account-grant changes.

## Safety

Do not enable the new flags in production merely by merging these PRs.
Do not migrate legacy trader sessions or automatically attach partner accounts
based on matching email, owner references, or organization membership.
