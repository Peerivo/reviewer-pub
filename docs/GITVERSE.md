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

The current documented GitVerse Public API exposes repository webhooks and pull-request comments, but the integration does not rely on an undocumented commit-status/check API. For a hard CI gate, use the existing checksum-pinned thin client in a protected GitVerse workflow. It exits non-zero when Reviewer reports blocking findings.

That workflow remains useful as a fallback and for customers who do not want OAuth installation.

## Token lifecycle and disconnect

OAuth access tokens are refreshed server-side before expiry and rotated refresh tokens are encrypted at rest.

Disconnect removes configured Reviewer webhooks and the local installation. GitVerse currently exposes user-side revocation under **Settings → Authorized Applications**; the integration therefore tells the user to revoke the OAuth grant there after disconnect when complete revocation is required.

## Security boundary

Reviewer never executes customer package installation, builds, tests, migrations, containers or application code. OAuth credentials, refresh tokens and webhook Authorization values stay server-side and are not written to normal application logs.
