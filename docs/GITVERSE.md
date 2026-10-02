# GitVerse setup

Peerivo Reviewer supports GitVerse through one OAuth installation with two capabilities:

1. **Hosted review** — authoritative server-side review with one updating Reviewer card in the pull request.
2. **Hard Merge Gate** — optional CI gate provisioned by the same installer. No workflow or secret is copied by the customer.

The proprietary analyzer remains in the private Reviewer service.

## Hosted OAuth installation

Register a GitVerse OAuth application with this callback:

```text
https://<reviewer-host>/oauth/gitverse/callback
```

Required scopes:

```text
read:user write:repository
```

Reviewer uses Authorization Code + PKCE (S256) plus a one-time state value. It validates the returned scope set before accepting an installation.

Configure:

```text
GITVERSE_WEB_BASE_URL=https://gitverse.ru
GITVERSE_API_BASE_URL=https://api.gitverse.ru
GITVERSE_PUBLIC_URL=https://<reviewer-host>
GITVERSE_OAUTH_CLIENT_ID=...
GITVERSE_OAUTH_CLIENT_SECRET=...
GITVERSE_INSTALLATIONS_DB=/data/gitverse-installations.sqlite
GITVERSE_TOKEN_ENCRYPTION_KEY=...
REVIEWER_API_URL=https://...
REVIEWER_API_TOKEN=...
```

Generate `GITVERSE_TOKEN_ENCRYPTION_KEY` from at least 32 bytes of cryptographically random material. Persist `/data` in production.

Customers start at:

```text
GET /connect/gitverse
```

After OAuth, Reviewer lists repositories where the account reports admin permission. The customer selects repositories and can enable **Block merge on HIGH/CRITICAL** before saving.

For every selected repository Reviewer creates:

- a repository-scoped `pull_request` webhook;
- a separate random webhook Authorization credential;
- an encrypted OAuth-token binding to the installation.

When Hard Merge Gate is enabled, Reviewer additionally:

- generates a separate repository-scoped CI credential;
- stores it as the GitVerse Actions secret `PEERIVO_GATE_TOKEN`;
- writes `.gitverse/workflows/reviewer.yml` to the repository default branch.

The user never needs to copy YAML or secret values.

### Trial, license and promo binding

Commercial access is bound server-side to the exact GitVerse repository id. The repository never receives a commercial license key.

On Save:

- if the repository already has an active entitlement, Reviewer keeps using it;
- if this is the first activation and no promo code is supplied, Reviewer creates the configured hosted trial;
- if a promo code is supplied, Reviewer redeems it for the selected repository;
- if a previous hosted trial has expired, reconnecting does not create a new trial;
- paid access is issued as a hosted entitlement and is validated by repository id on every review.

The installer therefore has one optional **Promo code** field. No license secret is copied into GitVerse. The only repository secret used by the optional Hard Merge Gate is the separate, repository-scoped `PEERIVO_GATE_TOKEN`, which authenticates the CI call but does not represent the commercial entitlement.

## Review flow

A valid webhook is only a notification. Reviewer authenticates the repository-scoped webhook, then re-fetches authoritative state through the GitVerse Public API:

- repository identity;
- pull request and base/head SHA;
- changed files and patches;
- head commit and recursive tree;
- `.github/workflows/**/*.yml` and `.gitverse/workflows/**/*.yml`;
- bounded head/base contents for security-relevant files.

Incomplete text patches, truncated trees, invalid SHA values, collection limits, token errors and Reviewer API errors fail closed.

The hosted integration upserts one marked **Peerivo Reviewer** comment on the pull request with checking/pass/blocking/fail-closed state. Blocking findings include the exact file, a link to that file at the reviewed commit SHA, a short explanation of why the pattern is risky, and the recommended remediation.

## Hard merge gate

The OAuth installer can provision the hard gate automatically. The installed workflow sends only the repository identity, pull-request number and expected head SHA to:

```text
POST https://pub.reviewer.peerivo.net/v1/ci/gitverse/review
```

The request is authenticated with the repository-scoped `PEERIVO_GATE_TOKEN`. Reviewer validates that token against the installed repository, re-fetches the pull request and all bounded review inputs through the GitVerse Public API, verifies that the PR head still matches the CI event, and then runs the private analyzer.

The workflow does not checkout or execute customer code.

Exit behavior:

- HTTP 200 → Reviewer PASS → CI job succeeds;
- HTTP 422 → blocking finding at the configured threshold → CI job fails;
- authentication, stale head, API, collection or service errors → fail closed.

Disabling the hard gate through the installer removes the workflow and repository secret. Disconnect also attempts to remove both before deleting the installation.

### E2E blocking fixture

To verify that a real Reviewer finding—not a synthetic `exit 1`—turns the GitVerse check red, add this file only on the PR branch:

```js
// security-gate.js
export function decide(input, threshold) {
  const elapsed = Number(input.elapsed ?? 0);
  return elapsed <= threshold ? "ALLOW" : "DENY";
}
```

Reviewer should report `FC-001` with high severity because a security-relevant numeric value defaults to zero before validation. With the default `high` threshold the CI job must fail. After replacing the permissive coercion with explicit validation, the same workflow should return green.

The fixture is deliberately small and deterministic. Do not merge it into the protected target branch.

## Token lifecycle and disconnect

OAuth access tokens are refreshed server-side before expiry and rotated refresh tokens are encrypted at rest.

Disconnect removes configured Reviewer webhooks, provisioned hard-gate workflow/secrets, and the local installation. GitVerse currently exposes user-side revocation under **Settings → Authorized Applications**; the integration therefore tells the user to revoke the OAuth grant there after disconnect when complete revocation is required.

## Security boundary

Reviewer never executes customer package installation, builds, tests, migrations, containers or application code. OAuth credentials, refresh tokens and webhook Authorization values stay server-side and are not written to normal application logs.
