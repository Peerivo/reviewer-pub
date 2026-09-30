# GitLab setup

Peerivo Reviewer supports GitLab.com and HTTPS GitLab Self-Managed instances through the public integration shell.

## 1. Create an access token

Create a server-side token with API access to the project(s) Reviewer will inspect and on which it will publish commit statuses.

Keep this token only in the Reviewer deployment secret store.

For a single customer project use the narrowest project/group scoped token available for that installation. Do not place the token in the reviewed repository.

## 2. Configure the integration service

Set:

```text
GITLAB_BASE_URL=https://gitlab.com
GITLAB_TOKEN=...
GITLAB_WEBHOOK_SECRET=...
GITLAB_PROJECTS=group/project
REVIEWER_API_URL=https://...
REVIEWER_API_TOKEN=...
```

`GITLAB_PROJECTS` is an exact comma-separated allowlist. A webhook for a repository outside that set is rejected before repository collection.

## 3. Create the webhook

In the GitLab project webhook settings:

- URL: `https://<reviewer-host>/webhooks/gitlab`
- Secret token: the value of `GITLAB_WEBHOOK_SECRET`
- Trigger: **Merge request events**

The endpoint verifies `X-Gitlab-Token` with a constant-time comparison.

## 4. What Reviewer reads

After accepting a reviewable MR event, the integration treats the webhook as a notification only and re-fetches authoritative state through REST API v4:

- project identity and visibility;
- merge-request `diff_refs.base_sha` and `head_sha`;
- paginated per-file diffs using the current MR diffs endpoint;
- recursive repository tree at the head SHA;
- `.gitlab-ci.yml` and `.gitlab/ci/**/*.yml`;
- bounded head/base content for security-relevant files.

If GitLab marks a diff `collapsed` or `too_large`, omits a required text diff, returns incomplete state, or collection exceeds configured limits, Reviewer fails closed.

## 5. Result

The integration publishes a commit status named **Peerivo Reviewer**:

- `pending` while collection/review is in progress;
- `success` when the configured blocking threshold is not reached;
- `failed` for blocking findings or fail-closed collection errors.

For fork merge requests the status is written to the source project commit. The integration token therefore needs permission to write that status; otherwise publication fails closed.

## Security boundary

The integration never executes customer build scripts, package installation, migrations, tests, containers, or application code. It reads bounded repository material and sends the normalized review snapshot to the private Reviewer API.
