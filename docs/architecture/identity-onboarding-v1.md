# AUTH-0/1: ACG Trader global identity foundation (first PR)

## Trust boundaries

1. Supabase Auth authenticates a **person** through a signed JWT. This service
   verifies asymmetric JWTs against the exact ACG Trader Supabase project's JWKS
   and requires issuer, audience, role, signature, expiry and an appropriate subject.
   No service-role key or JWT signing secret is stored in ACG Trader.
2. `User` is a global person, `LoginIdentity` is a provider-specific verified
   identity. Users are **never merged by email**. Linking a second provider
   requires a separately approved proof-of-control workflow (not in this PR).
3. Existing `Tenant` is the organization boundary. `OrganizationMembership`
   describes administrative roles, never permission to view or trade accounts.
4. `AccountAccessGrant` is explicit, tenant/account/user-scoped and has separate
   VIEW, TRADE and MANAGE rights. Grant checks fail closed on missing user,
   inactive tenant, mismatched account tenant, revoked grant or expired grant.
   Access is not derived from matching emails, profile references or membership.
5. Trading execution, ledger, catalog, existing password login, ACG Funded
   federation and existing WebSocket subscriptions are **unchanged** in this PR.

## Opt-in bootstrap

`SUPABASE_IDENTITY_BOOTSTRAP_ENABLED=false` by default. When explicitly enabled
and `SUPABASE_PROJECT_REF` is set to the ACG Trader project, the backend exposes:

`POST /v1/identity/bootstrap` with `Authorization: Bearer <Supabase access JWT>`.

A verified provider identity is idempotently connected to a global user record.
The response contains only `{ userId, status: "SETUP_REQUIRED" }`; it grants
**no** organization membership, trading account, trading session, or access to
`/v1/trading` and WebSockets. The endpoint has an additional rate limit.
The deterministic first-user ID is derived from the issuer+subject, never email.
Existing explicitly linked identity records take precedence over that candidate
ID, leaving future proof-of-control account linking possible.

Missing JWT, incorrect project, untrusted algorithm, invalid audience/role,
expired token, disabled identity or untrusted signing key fail closed.
JWKS errors return 503, not an unverified session. Only RS256/ES256 asymmetric
keys are supported; verify that the Supabase project publishes such keys
before enabling bootstrap. Issuer is fixed by the configured project ref to
prevent attacker-supplied JWKS URLs.

## Sequencing — not yet implemented

- AUTH-1B: introduce explicit tenant context and grant-backed global-user
  **trading** sessions. Check current grants on every HTTP command and
  reconcile WebSocket access on revocation. Do not rely on a stale access token
  or a 45-second frontend grant refresh for immediate revocation.
- AUTH-2: preserve ACG Funded ticket compatibility; make owner-wide vs named
  federation access explicit and test ticket replay prevention.
- AUTH-3: email/Google signup + proof-of-control account linking; verify
  Supabase provider-side auto-link behavior against the application policy.
- AUTH-4: idempotent personal DEMO account provisioning with recoverable
  failure and a unique provisioning key.
- AUTH-5: frontend onboarding, profile migration, account selection.
- AUTH-6: generic partner OIDC (authorization code + PKCE), Cloud organization
  signup, SSO and broader white-label integration.

Do **not** copy the ACG Funded Supabase project keys, introduce Supabase Postgres
as a parallel ledger, or use Supabase UUID/email directly as an account grant.

## Release requirements

Keep flag off in production until real Supabase JWT exchange and the account
grant/identity tests pass in isolated staging. Audit provider auto-linking,
revocation, account cross-tenant access, live WebSocket subscriptions, and the
unchanged ACG Funded flows before any rollout. All Mongo indexes must exist
before enabling bootstrap. Never enable public signup merely by merging this PR.
