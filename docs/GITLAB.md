# GitLab setup

Peerivo Reviewer supports GitLab.com and HTTPS GitLab Self-Managed instances. It performs fail-closed security review of merge requests without executing reviewed project code. It checks secrets, CI/CD authority, supply-chain/dependency integrity, migration execution paths and runtime-relevant security boundaries. Incomplete authoritative coverage fails instead of producing a false PASS. Customers authorize the existing Reviewer application, select projects, and Reviewer provisions Merge Request webhooks automatically.

## Install from GitLab

Open [Peerivo Reviewer in the GitLab CI/CD Catalog](https://gitlab.com/explore/catalog/peerivo/reviewer), then **Connect with GitLab**. Authorize the application in GitLab, select Maintainer/Owner projects on the Reviewer installation page, and save. Open or update a merge request to start a review.

Customers do not register a new OAuth application or supply a personal access token. Hosted webhook installation does not require YAML. The project-selection screen is hosted by Reviewer; a catalog resource is not a built-in **Settings → Integrations** entry.

The remaining deployment sections are for operators of the Reviewer service, not ordinary customers.

## 1. Register the OAuth application (service operators)

Register a confidential GitLab OAuth application on the instance Reviewer will connect to, with this redirect URI:

```text
https://<reviewer-host>/oauth/gitlab/callback
```

Grant `api` scope. GitLab's scope is broad: it permits API access to resources available to the authorizing account. Reviewer restricts configured targets to selected projects, but this does not narrow GitLab's OAuth grant itself. API write access is needed to manage webhooks and publish commit statuses.

The current implementation uses the confidential server-side Authorization Code flow, with `client_secret` used only in server-to-server token exchange and refresh requests and a one-time `state`. It does not send PKCE parameters to GitLab. This preserves the provider-compatibility fix; older documentation describing this path as PKCE was outdated. See [GitLab's supported OAuth flows](https://docs.gitlab.com/api/oauth2/).

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

Generate `GITLAB_TOKEN_ENCRYPTION_KEY` from at least 32 bytes of cryptographically random material. Persist the installation database on a volume. The Docker image prepares `/data` for that purpose.

For Self-Managed, set `GITLAB_BASE_URL` to that HTTPS instance and register the OAuth application on the same instance. One deployment is bound to one GitLab base URL.

## 3. Customer authorization and project selection

`GET /connect/gitlab` redirects the customer to GitLab. After authorization:

1. GitLab returns to `/oauth/gitlab/callback`.
2. Reviewer consumes the one-time state and exchanges the code server-side using the confidential application credentials.
3. Access and refresh tokens are encrypted at rest.
4. Reviewer lists projects where the user has at least Maintainer access.
5. The customer selects projects and saves.
6. Reviewer creates or updates each project's Merge Request webhook with a separate random secret.
7. The selected project is bound to its GitLab project ID for entitlement validation.

The installation UI uses a short-lived server-side session, an HttpOnly, Secure, SameSite=Lax cookie and a CSRF token. OAuth tokens and webhook secrets are not returned to the browser or written to application logs.

## 4. Token lifecycle

Reviewer refreshes expiring access tokens server-side and persists the rotated access and refresh tokens encrypted at rest.

Disconnecting removes project webhooks and revokes the OAuth grant where possible. It always removes the local installation so future webhooks are rejected.

## 5. Authoritative review path

GitLab sends Merge Request events to `POST /webhooks/gitlab`. Before acknowledging a reviewable event, Reviewer resolves the exact `project.id`, verifies that project's stored webhook secret and rejects unknown projects. It re-fetches authoritative state through GitLab REST API v4:

- project identity and visibility;
- merge-request base and head SHAs;
- paginated per-file diffs and the recursive repository tree;
- `.gitlab-ci.yml` and `.gitlab/ci/**/*.yml`;
- bounded head/base contents for security-relevant files.

Collapsed/oversized diffs, missing required patches, incomplete state and collection limits fail closed. The commit status **Peerivo Reviewer** is `pending` during review, `success` below the blocking threshold, and `failed` for blocking findings or collection errors.

For fork merge requests, the status is written to the source project commit. The authorizing user needs sufficient access there; publication does not silently pass when that access is missing.

## 6. Optional native CI job on Free / Premium / Ultimate

For a clickable job with a detailed trace, first connect the project through OAuth, then add the published GitLab.com component to the existing `.gitlab-ci.yml`:

```yaml
include:
  - component: gitlab.com/peerivo/reviewer/reviewer@1.0.3
```

The default stage is `.pre`. GitLab does not start pipelines containing only `.pre`/`.post` jobs: retain a normal-stage job, or choose a normal stage already in your pipeline through `inputs.stage`. Existing `workflow: rules` must allow merge-request pipelines. A custom job name can avoid collisions:

```yaml
include:
  - component: gitlab.com/peerivo/reviewer/reviewer@1.0.3
    inputs:
      job-name: "Peerivo security review"
      stage: "test"
```

Self-Managed installations need the component mirrored and released on the same instance; do not assume a GitLab.com component is available there automatically.

The job uses GitLab's built-in ephemeral `CI_JOB_TOKEN`. The bridge validates it through GitLab's current-job API, checks project/job/pipeline/SHA/MR identity against the connected installation, then submits bounded authoritative data to the private Reviewer engine.

The job prints the report before exiting. HTTP 200 with a nonempty response passes; blocking findings return HTTP 422. Other responses, missing reports and network failures fail. Findings include file paths, reviewed-commit links, risk explanations and remediation; supported terminals show colored status/category markers.

The component disables inherited default job settings, before/after scripts, caches, artifact dependencies, repository checkout and submodules. It does not run project builds, dependency installers, migrations, tests or application code. A job definition in the consuming project can still override component settings; protect the CI configuration as part of your project policy.

A failed job is not itself a merge policy. Enable **Settings → Merge requests → Merge checks → Pipelines must succeed** to enforce successful pipelines, and verify every relevant merge request receives the review job. The installer does not change this setting silently.

## 7. Legacy token fallback

Existing pilots can keep the explicit fallback by setting all three server-side values together:

```text
GITLAB_TOKEN=...
GITLAB_WEBHOOK_SECRET=...
GITLAB_PROJECTS=group/project,group/other-project
```

New customer installations should use OAuth.

## Security boundary

Reviewer never executes reviewed project code. It reads bounded repository material and sends normalized review snapshots to the private Reviewer API. Commercial access is resolved against the selected project identity; no long-lived customer credential is placed in the CI job.


## Catalog namespace migration

The catalog OAuth **actor** and the public catalog **namespace** are separate settings. This lets the existing administrative GitLab user (for example `triombus`) manage a branded group namespace such as `peerivo` without creating a new personal GitLab account.

Runtime variables:

```text
GITLAB_CATALOG_BOOTSTRAP_ACTOR=triombus
GITLAB_CATALOG_BOOTSTRAP_NAMESPACE=peerivo
GITLAB_CATALOG_BOOTSTRAP_PROJECT=reviewer
```

Do not delete the existing OAuth application before a replacement group-owned application has been created, configured and tested. Project transfer and OAuth application ownership are separate operations.


### One-time move from the personal namespace

After the `peerivo` group exists, set:

```text
GITLAB_CATALOG_BOOTSTRAP_ACTOR=triombus
GITLAB_CATALOG_BOOTSTRAP_NAMESPACE=peerivo
GITLAB_CATALOG_BOOTSTRAP_PROJECT=reviewer
GITLAB_CATALOG_TRANSFER_FROM=triombus/peerivo-reviewer
```

On the next controlled deploy, bootstrap transfers the existing project instead of creating a second catalog project. The transfer preserves project history and GitLab redirects the old project URL to the new namespace. Clear `GITLAB_CATALOG_TRANSFER_FROM` after the transfer is verified.
