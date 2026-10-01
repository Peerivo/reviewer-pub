# GitVerse setup

Peerivo Reviewer supports GitVerse through two complementary modes:

1. **Hosted OAuth installation** — recommended for self-service onboarding and authoritative server-side review.
2. **Checksum-pinned CI thin client** — optional hard merge gate for teams that want the Reviewer result to fail a GitVerse CI job.

The proprietary analyzer remains in the private Reviewer service in both standard hosted modes.

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

After OAuth, Reviewer lists repositories where the account reports admin permission. The customer selects repositories and Reviewer creates a `pull_request` webhook for each one.

Each selected repository receives:

- a repository-scoped webhook URL: `/webhooks/gitverse/<repository-id>`;
- a separate random Authorization credential;
- an encrypted OAuth-token binding to the installation.

## Review flow

A valid webhook is only a notification. Reviewer authenticates the repository-scoped webhook, then re-fetches authoritative state through the GitVerse Public API:

- repository identity;
- pull request and base/head SHA;
- changed files and patches;
- head commit and recursive tree;
- `.github/workflows/**/*.yml` and `.gitverse/workflows/**/*.yml`;
- bounded head/base contents for security-relevant files.

Incomplete text patches, truncated trees, invalid SHA values, collection limits, token errors and Reviewer API errors fail closed.

The hosted integration upserts one marked **Peerivo Reviewer** comment on the pull request with checking/pass/blocking/fail-closed state.

## Hard merge gate

For a hard CI gate, use `examples/gitverse.yml`. The workflow downloads the public source-transparent collector from `clients/remote-reviewer.mjs`, verifies its SHA-256, checks out the exact PR head only as Git data and submits a bounded review payload to `https://api.reviewer.peerivo.net`.

The public example pins both the client URL and SHA-256 to an immutable reviewer-pub commit. The customer repository only needs this secret:

```text
Secret: PEERIVO_LICENSE
```

The client exits non-zero when Reviewer reports a finding at or above the configured blocking threshold, and exits with code 2 when coverage or service validation fails closed.

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

Disconnect removes configured Reviewer webhooks and the local installation. GitVerse currently exposes user-side revocation under **Settings → Authorized Applications**; the integration therefore tells the user to revoke the OAuth grant there after disconnect when complete revocation is required.

## Security boundary

Reviewer never executes customer package installation, builds, tests, migrations, containers or application code. OAuth credentials, refresh tokens and webhook Authorization values stay server-side and are not written to normal application logs.
