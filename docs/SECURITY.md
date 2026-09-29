# Security model

## Trust boundary

Pull-request content and webhook payload fields describing code are untrusted. The App verifies the GitHub webhook signature, then re-fetches pull-request state through the GitHub API using an installation token before making a review decision.

The runtime never runs repository code, package managers, build scripts, tests, migrations, containers from the reviewed repository, or PR-provided shell commands.

## Credentials

Server-side only:

- GitHub App private key;
- GitHub webhook secret;
- private Reviewer API token.

Short-lived GitHub installation tokens exist only in process memory for the request path. Secrets must not be written to logs, Check Run output, PR comments, or review payloads.

## Network destinations

The shell needs outbound HTTPS only to:

- `api.github.com`;
- the configured `REVIEWER_API_URL`.

Redirects are rejected by the HTTP client for both trust boundaries.

## Coverage bounds

The service fails closed on truncated repository trees, missing required text patches, incomplete workflow content, incomplete security-relevant head/base content, excessive file/workflow/security counts, oversized workflow/security data, invalid response schemas and review timeouts.

Binary changes may have no textual patch and are represented with an empty patch. They are not executed or downloaded for analysis by this shell.

## Webhook acknowledgement

After HMAC verification and JSON parsing, supported pull-request deliveries are acknowledged with HTTP `202` before the analyzer call completes. Review failure is expressed through the GitHub Check Run, not by holding the webhook connection open. A process crash before completion is detectable as a missing/incomplete check and must be covered by operational monitoring before paid production.

## Logging

Do not log raw webhook bodies, diff payloads, workflow content, security snapshot content, authorization headers, installation tokens or Reviewer API responses containing source fragments. Operational logs should contain only delivery/repository/PR identifiers and coarse success/failure state.

## Reporting vulnerabilities

Use Peerivo's private security contact channel for suspected vulnerabilities. Do not include production credentials, customer source code or exploitable secret material in public GitHub issues.
