# Peerivo Reviewer for GitLab

Fail-closed security review for merge requests. Hosted analysis plus an optional native GitLab CI/CD component.

## Connect Peerivo Reviewer

### [Connect with GitLab →](https://pub.reviewer.peerivo.net/connect/gitlab)

Start in GitLab: **Search or go to → Explore → CI/CD Catalog → Peerivo Reviewer**.

1. Open **Connect with GitLab** on this page and authorize the existing Peerivo Reviewer application in GitLab.
2. Select your Maintainer/Owner projects in the Reviewer installation screen and press **Save GitLab projects**.
3. Open or update a merge request. Reviewer provisions the webhook automatically and publishes a **Peerivo Reviewer** commit status.

You do not need to register your own OAuth application, create a personal access token, or copy YAML for hosted webhook reviews. The project-selection screen is hosted by Reviewer; this is not a built-in entry in GitLab **Settings → Integrations**.

**По-русски:** откройте GitLab → Explore → CI/CD Catalog → Peerivo Reviewer, нажмите **Connect with GitLab**, подтвердите доступ и выберите проекты. Создавать своё OAuth-приложение или передавать токены не нужно. Выбор проектов выполняется на странице Reviewer.

## Optional: a native pipeline job

To add a clickable job with a detailed report to GitLab.com merge-request pipelines, connect the project as above, then add the catalog component to the existing `.gitlab-ci.yml`:

```yaml
include:
  - component: gitlab.com/triombus/peerivo-reviewer/reviewer@1.0.1
```

The component adds **Peerivo Reviewer** in the `.pre` stage. It does not replace the rest of your pipeline. Existing `workflow: rules` must allow merge-request pipelines. If that job name is already used, choose another name:

```yaml
include:
  - component: gitlab.com/triombus/peerivo-reviewer/reviewer@1.0.1
    inputs:
      job-name: "Peerivo security review"
      stage: ".pre"
```

A completed passing report makes the job green. Blocking findings, authorization failures, unavailable analysis, incomplete responses and network errors fail the job. Findings are printed before the job exits so the file path and remediation remain visible in the trace.

A failed job is not by itself a project merge policy. To enforce it, enable **Settings → Merge requests → Merge checks → Pipelines must succeed**. Verify that all relevant merge requests actually receive this pipeline. The installer does not silently change that setting.

For GitLab Self-Managed, use a component mirrored/released on that same instance and register the hosted connection for that instance; do not assume a GitLab.com component is available there automatically.

## Access and security

GitLab's `api` OAuth scope is broad: it allows API access to resources available to the authorizing account. Reviewer limits its configured review targets to the projects you select, but this selection does not narrow the OAuth scope at GitLab. API write access is needed to manage project webhooks and publish statuses.

OAuth access/refresh tokens are encrypted at rest and refreshed server-side. The optional CI job uses GitLab's built-in ephemeral `CI_JOB_TOKEN`; no long-lived customer secret is copied into CI.

The component disables inherited default jobs settings, setup/cleanup scripts, caches and artifact dependencies, and does not check out the repository or submodules. It sends only merge-request/job identity to Reviewer. The hosted service re-fetches bounded authoritative GitLab data and does not execute reviewed project builds, tests, dependency installers, migrations or application code.

## Checks

CI and supply-chain risks; secrets in changed code; dependency and lockfile integrity; migration execution paths; external runtime and public-repository security boundaries.

[Open CI/CD Catalog](https://gitlab.com/explore/catalog/triombus/peerivo-reviewer) · [Connect / manage projects](https://pub.reviewer.peerivo.net/connect/gitlab) · [Integration source and documentation](https://github.com/Peerivo/reviewer-pub)
