# GitLab setup

Peerivo Reviewer supports GitLab.com and HTTPS GitLab Self-Managed instances. The recommended path is a self-service OAuth installation: the customer authorizes Reviewer, selects projects, and Reviewer creates the required Merge Request webhooks automatically.

## 1. Register the OAuth application

Register a confidential GitLab OAuth application on the GitLab instance Reviewer will connect to.

Use this redirect URI:

```text
https://<reviewer-host>/oauth/gitlab/callback
```

Grant the application the `api` scope. Reviewer needs API write access because it creates/removes project webhooks and publishes commit statuses. The integration does not execute repository code.

GitLab OAuth authorization uses Authorization Code + PKCE (S256) and a one-time `state` value.

## 2. Configure Reviewer

Set:

```text
GITLAB_BASE_URL=https://gitlab.com
GITLAB_PUBLIC_URL=https://<reviewer-host>
GITLAB_OAUTH_CLIENT_ID=...
GITLAB_OAUTH_CLIENT_SECRET=...
GITLAB_INSTALLATIONS_DB=/data/gitlab-installations.sqlite
GITLAB_TOKEN_ENCRYPTION_KEY=...
REVIEWER_API_URL=https://...
REVIEWER_API_TOKEN=...
```

Generate `GITLAB_TOKEN_ENCRYPTION_KEY` from at least 32 bytes of cryptographically random material. The Docker image prepares `/data` for a persistent volume. Production deployments must persist the installation database.

For GitLab Self-Managed, set `GITLAB_BASE_URL` to that HTTPS instance and register the OAuth application on the same instance. One deployment is bound to one GitLab base URL.

## 3. Customer installation flow

Open:

```text
GET /connect/gitlab
```

Reviewer redirects the customer to GitLab. After authorization:

1. GitLab returns to `/oauth/gitlab/callback`.
2. Reviewer exchanges the code using PKCE.
3. OAuth access and refresh tokens are encrypted at rest.
4. Reviewer lists only projects where the user has at least Maintainer access.
5. The customer selects projects.
6. Reviewer creates or updates a project webhook for Merge Request events.
7. Each selected project receives its own random webhook secret.
8. The project is bound to its GitLab project ID for entitlement validation.

The short-lived installation UI session is stored server-side and protected with an HttpOnly, Secure, SameSite=Lax cookie plus a CSRF token.

## 4. Token lifecycle

GitLab OAuth access tokens expire. Reviewer refreshes them server-side before use and persists the rotated access and refresh tokens encrypted at rest.

Disconnecting GitLab removes configured project webhooks where possible, revokes the OAuth grant where possible, and always removes the local installation so future webhooks are rejected.

## 5. Webhook review path

GitLab sends Merge Request events to:

```text
POST /webhooks/gitlab
```

Before acknowledging a reviewable event, Reviewer resolves the exact `project.id`, verifies that project's stored webhook secret, and rejects unknown projects. It then uses that installation's OAuth credential to re-fetch authoritative state through GitLab REST API v4:

- project identity and visibility;
- merge-request `diff_refs.base_sha` and `head_sha`;
- paginated per-file diffs;
- recursive repository tree at the head SHA;
- `.gitlab-ci.yml` and `.gitlab/ci/**/*.yml`;
- bounded head/base content for security-relevant files.

If GitLab marks a diff `collapsed` or `too_large`, omits a required text diff, returns incomplete state, or collection exceeds configured limits, Reviewer fails closed.

The result is published as a commit status named **Peerivo Reviewer**:

- `pending` while collection/review is in progress;
- `success` when the blocking threshold is not reached;
- `failed` for blocking findings or fail-closed collection errors.

For fork merge requests the status is written to the source project commit. The authorizing GitLab user therefore needs sufficient access for that source project, otherwise publication fails closed.

## 6. Legacy token fallback

Existing pilots can continue to use the previous server-side token mode by setting all three variables together:

```text
GITLAB_TOKEN=...
GITLAB_WEBHOOK_SECRET=...
GITLAB_PROJECTS=group/project,group/other-project
```

This mode remains an explicit fallback. New customer installations should use OAuth.

## Security boundary

Reviewer never executes customer build scripts, package installation, migrations, tests, containers, or application code. It reads bounded repository material and sends the normalized review snapshot to the private Reviewer API.

OAuth tokens and per-project webhook secrets are not written to application logs or returned to the customer browser.
