# Peerivo Reviewer for GitLab

Fail-closed merge-request security review for GitLab. Reviewer analyzes bounded authoritative repository data and does **not** execute reviewed project code.

## Install from GitLab CI/CD Catalog

Add the published component to your `.gitlab-ci.yml`:

```yaml
include:
  - component: $CI_SERVER_FQDN/triombus/peerivo-reviewer/reviewer@1.0.0
```

The component adds one clickable GitLab job named **Peerivo Reviewer** to merge-request pipelines.

Before first use, connect the GitLab project once:

https://pub.reviewer.peerivo.net/connect/gitlab

Reviewer stores the OAuth grant encrypted, refreshes it server-side, provisions the Merge Request webhook automatically, and uses GitLab API data as the authoritative review source.

## Checks

- CI and supply-chain risks
- secrets added in changed code
- dependency and lockfile integrity
- database migration execution paths
- external runtime and public-repository boundaries

## CI security boundary

The component uses GitLab's built-in ephemeral `CI_JOB_TOKEN`. No long-lived customer secret is required in CI. The job does not run project builds, dependency installers, migrations, tests, containers, or application code.

Hosted service: https://pub.reviewer.peerivo.net
