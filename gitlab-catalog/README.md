# Peerivo Reviewer for GitLab

**Peerivo Reviewer** is a fail-closed security reviewer for GitLab merge requests. It checks security-sensitive changes before merge **without executing code from the merge request**.

## What “fail-closed” means

Reviewer never turns missing evidence into a green result. If GitLab returns an incomplete diff or repository tree, a required file cannot be read, the reviewed HEAD changes during collection, or Reviewer cannot complete authoritative analysis, the check fails instead of silently passing.

**Complete evidence or no PASS.**

## What it checks

- **Secrets and credentials** — token/private-key patterns and production credentials added in changed code.
- **CI/CD authority and permissions** — risky pipeline behavior, privilege expansion and unsafe supply-chain execution paths.
- **Dependencies and lockfiles** — manifest/lockfile drift and dependency integrity.
- **Migrations** — migration files without a controlled execution path.
- **Runtime security boundaries** — tenant/RLS-sensitive code, webhooks, admin/control-plane paths, containers and infrastructure-relevant configuration when evidence is available.
- **Coverage integrity** — truncated or unavailable review data becomes a failed-closed result, not a false PASS.

Reviewer reads bounded authoritative repository data through GitLab APIs. It does **not** run your build, tests, dependency installers, migrations or application code.

## Connect Peerivo Reviewer

### [Connect with GitLab →](https://pub.reviewer.peerivo.net/connect/gitlab)

1. Authorize the existing **Peerivo Reviewer** application in GitLab.
2. Select the projects Reviewer should protect and press **Save and verify connection**.
3. Reviewer verifies project access and webhook configuration.
4. Open or update a merge request. Reviewer publishes a **Peerivo Reviewer** status on the exact reviewed commit.

You do not need to register your own OAuth application, create a personal access token, or copy Reviewer source into the repository.

### По-русски

**Peerivo Reviewer** — fail-closed проверка безопасности merge request. Она ищет секреты, опасные CI/CD-права и supply-chain изменения, проблемы зависимостей/lockfile, неконтролируемые миграции и риски runtime-границ. Код merge request не запускается.

**Fail-closed означает:** если Reviewer не смог доказать полноту проверки — например, GitLab вернул неполный diff, нужный файл недоступен или HEAD изменился во время анализа — зелёного PASS не будет.

Нажмите **Connect with GitLab**, выберите проекты и сохраните. После этого Reviewer автоматически проверяет новые и обновлённые merge request.

## Optional native pipeline job

Hosted webhook review works without customer YAML. If you also want a clickable GitLab pipeline job with the detailed console report, add the catalog component:

```yaml
include:
  - component: gitlab.com/peerivo/reviewer/reviewer@1.0.3
```

The default stage is `.pre`. Existing `workflow: rules` must allow merge-request pipelines. You can override the job name and stage:

```yaml
include:
  - component: gitlab.com/peerivo/reviewer/reviewer@1.0.3
    inputs:
      job-name: "Peerivo security review"
      stage: "test"
```

A completed non-empty HTTP 200 report passes the job. Blocking findings, incomplete analysis, authorization failure, service/network failure or missing report fail the job.

To make a failed job block merge, enable **Settings → Merge requests → Merge checks → Pipelines must succeed** and verify the review job is present on relevant merge requests.

## Access and data boundary

GitLab's `api` OAuth scope is broad. Reviewer only configures the projects selected in its installer, but that project selection does not narrow GitLab's OAuth grant itself. OAuth access/refresh tokens are encrypted at rest and refreshed server-side.

The optional CI job uses GitLab's ephemeral `CI_JOB_TOKEN`; no long-lived customer token is copied into CI. The hosted service re-fetches authoritative GitLab state and sends only bounded review material to the private Reviewer engine.

[Open CI/CD Catalog](https://gitlab.com/explore/catalog/peerivo/reviewer) · [Connect / manage projects](https://pub.reviewer.peerivo.net/connect/gitlab) · [Integration source and docs](https://github.com/Peerivo/reviewer-pub)
