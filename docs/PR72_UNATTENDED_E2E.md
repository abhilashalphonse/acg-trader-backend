# PR72 unattended dual-commit acceptance (CI-only)

The release candidate is the **pair of exact, immutable commit SHAs** on backend
PR #72 and frontend PR #109. The backend's
`.github/workflows/pr72-dual-commit-e2e.yml` is also invoked from the
frontend PR via a reusable workflow. Either head moving invalidates the older
attestation; rerun and require green checks for both new heads.

## One-time setup (no credentials in chat or Git)

In **both** GitHub repositories configure protected Actions secrets:

- `ACG_E2E_REPO_READ_TOKEN` — fine-grained GitHub token with **read-only Contents
  and Pull requests metadata** access to the two ACG Trader repositories.
- `ACG_E2E_TWELVE_DATA_API_KEY` — a dedicated staging-only Twelve Data credential
  supporting BTC/USD and EUR/USD live quotes. Never use a production trading
  platform service credential as a substitute.

GitHub `GITHUB_TOKEN` alone may not read the other private repository. Do not
write any session tokens, federation tickets or passwords to repository secrets;
these are generated per-run and kept in a 0600 file under `RUNNER_TEMP` only.

Mark `dual-commit-acceptance` on backend PR #72 and
`dual-commit-acceptance / dual-commit-acceptance` on frontend PR #109 as
**required release status checks** in each repository's branch protection /
ruleset. A green build without these checks is not a release authorization.
Configure the required-check rules only after confirming the actual check
names on the Actions UI. Production deployment remains a separate owner-approved
step: do not automatically merge or deploy production from this workflow.

## Execution contract

1. Resolve the latest SHA on both draft pull requests through GitHub API;
   reject moved commits and check out exactly those two commits.
2. Run a containerized MongoDB **replica set** at localhost in the ephemeral
   GitHub runner, using only `acg_pr72_browser_e2e`. The harness refuses any
   other hostname or DB. Disposable accounts use known USD/EUR initial balances,
   unique account IDs, and explicit permissions. Source fixtures create both a
   native login and a **single-use** federated login ticket.
3. Start the actual backend application with a real Twelve Data gateway,
   trading service, valuation, WebSocket server and no upstream Funded event
   relay. Start the exact frontend commit in V4 audit mode.
4. Playwright drives the real login form and in-app federated exchange, account
   switcher and cookie refresh. Playwright's browser/API request context then
   exercises authenticated market/pending/protection/partial/full close and
   cross-currency EUR account endpoints against current provider quotes.
5. An **isolated, localhost-only test-control endpoint** suppresses new
   EURUSD quote-store updates, verifies that conversion-dependent exposure
   is refused, then resumes the provider and verifies recovery.
   This tests application-level quote interruption, not Twelve Data's
   proprietary outage mechanics.
6. Run the existing **read-only inventory guard** against the disposable
   accounts and assert all class ceilings plus balance and reserved-margin
   reconciliation. Neither the production database nor the Funded account
   lifecycle is accessed.
7. On pass or failure remove the container and runner-only secret file.
   Upload only a small aggregate JSON result, **never** authentication state,
   API access tokens, complete HTTP transcripts, recordings or screenshots.

If the real feed is down, the market is closed, credential is unavailable,
or a quote is stale, the test must fail/mark the release **blocked**, never
report a pass. This pipeline **does not rerun** the completed 538-test
synthetic/controlled-price suite. Deterministic trigger/stop-out thresholds
remain covered by the previously completed isolated acceptance.

## Scope and final sign-off

The federated ticket is created by the real ACG Trader AuthService in
disposable CI and exchanged through the actual browser route. It validates
the Trader federated login surface, **not** the separate upstream ACG Funded
ticket issuer or paid challenge lifecycle. Test the upstream Funded handoff
separately before declaring complete end-to-end Funded integration.

This acceptance proves real-provider execution and browser workflow only
when all required secrets are present and the full paired run succeeds.
Protect existing open-position margins and the `ACG_LEVERAGE_BY_ASSET_CLASS`
mapping throughout deployment and rollback. The pre-commercial production
financial audit remains separate, read-only and private; never publish
account-level snapshots in this repository.
