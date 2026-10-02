# Peerivo Reviewer — GitHub + GitLab + GitVerse integrations

Public, source-transparent GitHub/GitLab/GitVerse integration shell for **Peerivo Reviewer**.

Reviewer checks the security boundary of pull requests — CI authority, secrets, supply-chain references, caches, migrations and fail-open security logic — without executing the reviewed project's build, tests, install scripts or application code.

This repository contains only provider integration layers. The proprietary detection engine is hosted separately and is not distributed to customer repositories.

## What gets installed

Customers install a GitHub App. They do **not** add a reusable Action or copy Reviewer source into their repositories.

```text
pull_request webhook
        |
        v
Peerivo Reviewer GitHub App (this repo)
  - verifies GitHub webhook HMAC
  - exchanges App JWT for installation token
  - re-fetches authoritative PR/base/head/files
  - reads bounded workflow + security-relevant files with Contents: read
  - never executes repository code
        |
        v
Peerivo Reviewer API (private engine)
        |
        v
GitHub Check Run: pass / blocking findings / fail-closed error
```

## GitLab integration

GitLab.com and HTTPS GitLab Self-Managed are first-class providers. New customers connect through OAuth:

```text
GET /connect/gitlab
  -> GitLab OAuth Authorization Code + PKCE
  -> /oauth/gitlab/callback
  -> select Maintainer/Owner projects
  -> Reviewer provisions per-project Merge Request webhooks
```

OAuth access/refresh tokens are encrypted at rest, refreshed server-side, and never exposed to customer repositories. Each selected project has a separate random webhook secret. Incoming events resolve the exact `project.id` before Reviewer re-fetches authoritative MR, diff, tree and security-relevant contents through GitLab REST API v4.

The previous `GITLAB_TOKEN` + `GITLAB_PROJECTS` configuration remains only as a legacy fallback for existing pilots.

See [`docs/GITLAB.md`](docs/GITLAB.md).

## GitVerse integration

GitVerse customers can connect through OAuth and select repositories:

```text
GET /connect/gitverse
  -> GitVerse OAuth Authorization Code + PKCE
  -> /oauth/gitverse/callback
  -> select Owner/Admin repositories
  -> Reviewer provisions repository-scoped pull_request webhooks
```

OAuth access/refresh tokens and per-repository webhook Authorization credentials are encrypted at rest. Incoming events are authenticated against the exact installed repository before Reviewer re-fetches authoritative PR, patch, tree and workflow data from the GitVerse Public API.

Hosted mode publishes/upserts a **Peerivo Reviewer** PR comment. Commercial access is bound server-side to the selected GitVerse repository id: first-time installs can receive the configured trial, promo codes can activate an entitlement, and paid access is issued without placing a commercial license key in the repository. Reconnecting cannot restart an expired hosted trial.

The same installer can also enable **Block merge on HIGH/CRITICAL**: Reviewer creates the repository-scoped GitVerse Actions secret and installs the hard-gate workflow automatically, so customers do not copy YAML or credentials. The gate sends only PR identity to Reviewer; the server re-fetches authoritative review data and never executes repository code.

See [`docs/GITVERSE.md`](docs/GITVERSE.md).

## GitHub App permissions

Repository permissions:

- **Metadata:** read (implicit GitHub App permission)
- **Contents:** read
- **Pull requests:** read
- **Checks:** read & write

Events:

- **Pull request**

No `contents: write`, administration, secrets, Actions write, or repository mutation permission is required for the review path.

See [`docs/GITHUB_APP.md`](docs/GITHUB_APP.md).

## Runtime

Node.js 24+ and no third-party npm runtime dependencies.

```bash
cp .env.example .env
npm run check
npm start
```

Webhook endpoints:

```text
POST /webhooks/github
POST /webhooks/gitlab
POST /webhooks/gitverse/<repository-id>
```

Health endpoint:

```text
GET /healthz
```

## Bootstrap and required deployment secrets

The landing page and `/healthz` can boot before GitHub App credentials are provisioned. This lets us deploy the HTTPS shell first, use its URL when creating the GitHub App, and then add secrets without changing the public endpoint.

`GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` and `REVIEWER_API_TOKEN` are server-side secrets. They must never be committed to this public repository or delivered to customer repositories.

The GitHub App private key is used only to obtain short-lived installation tokens. The Reviewer API token authenticates this hosted integration to the private service; customer entitlement is resolved server-side from installation/repository identity.

## Fail-closed behavior

Valid GitHub webhooks are acknowledged with HTTP `202` before the potentially long review finishes, so GitHub's webhook response window is not coupled to analyzer latency. The background review still creates/updates the Check Run and fails closed.

The check fails rather than silently passing when:

- webhook authentication fails;
- authoritative PR metadata cannot be read;
- GitHub truncates the repository tree;
- a text patch needed for review is unavailable;
- workflow content cannot be obtained completely;
- collection exceeds configured safety bounds;
- the private Reviewer service times out or returns an invalid response;
- the PR head changes during collection.

## Data boundary

The integration sends bounded authoritative diff/workflow metadata plus bounded head/base contents for security-relevant changed files and the external runtime security profile to the private Reviewer API. This enables tenant/RLS, customer-secret, webhook, host/container and supply-chain checks without executing reviewed code.

The collector has explicit file-count, per-file byte and aggregate byte limits and fails closed when required security content cannot be obtained completely. Source payloads and detected secret material must not be written to application logs.

See [`docs/SECURITY.md`](docs/SECURITY.md).

## Status

`0.5.0` — GitHub App + self-service GitLab/GitVerse OAuth installation shell with bounded authoritative server-side review collection.

## License

Proprietary. See [`LICENSE-PROPRIETARY.md`](LICENSE-PROPRIETARY.md).
