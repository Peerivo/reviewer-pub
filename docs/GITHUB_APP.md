# GitHub App configuration

## Identity

Recommended public identity:

- Name: **Peerivo Reviewer**
- Description: **Fail-closed pull-request security review without executing reviewed project code.**
- Homepage: the public Reviewer product page or this repository until the product page is live.
- Webhook URL: `https://<app-host>/webhooks/github`
- Webhook secret: generated random secret stored only in the deployment secret store.

## Repository permissions

Use the minimum permissions below:

| Permission | Level | Why |
| --- | --- | --- |
| Metadata | Read | GitHub App baseline repository identity |
| Contents | Read | Complete workflow content and repository tree |
| Pull requests | Read | Authoritative PR/base/head/files |
| Checks | Read & write | Publish/update the Reviewer Check Run |

Do not grant Contents write, Administration, Actions write, Secrets, Deployments write, or other unrelated mutation permissions.

## Events

Subscribe to **Pull request**.

The runtime processes only:

- `opened`
- `reopened`
- `synchronize`
- `ready_for_review`

Other actions are acknowledged without running a review.

## Private key

Generate a GitHub App private key and store it as `GITHUB_APP_PRIVATE_KEY` in the deployment secret store. Do not commit the `.pem` file.

The runtime creates a short-lived RS256 App JWT and exchanges it for an installation access token. Installation tokens are never returned to users or written to logs.

## External pilot

1. Deploy this service over HTTPS.
2. Configure the GitHub App with the exact permissions/events above.
3. Install the App on a repository outside the Peerivo organization.
4. Open a safe PR and confirm a successful `Peerivo Reviewer` Check Run.
5. Add a deliberately unsafe CI fixture and confirm the check blocks.
6. Push a new commit and confirm the new head receives a fresh check.
7. Break the Reviewer API connection and confirm the check fails closed.
8. Confirm no proprietary analyzer code is present in the customer repository or this public shell.

## Direct commits on default branch

Subscribe to GitHub App **Push** events in **Developer settings → GitHub Apps → Peerivo Reviewer → Permissions & events**. Existing Contents: read, Checks: read/write and Metadata: read permissions suffice for reading the bounded commit comparison and publishing a Check Run. New permissions are not required.

On push to the repository's authoritative default branch, the integration reviews the exact before/after SHA range and attaches a Check Run to the pushed commit. Changes are fetched by GitHub's compare endpoint, limited to fewer than 300 changed files; missing diffs, truncated comparisons, non-fast-forward pushes and incomplete coverage fail closed. Initial branch creation and deletion are not treated as ordinary direct commit reviews. An installed GitHub App must have the event subscription updated; deploying code alone does not subscribe it.

**Limitation:** GitHub has already accepted a direct commit before this check runs. A failing status cannot undo the push or reliably prevent it. Use a protected workflow/deployment gate or supported pre-receive hook for preventive enforcement. Hosted integration still reads selected repository contents and sends bounded source/diff data to the private Reviewer service. Customer-hosted local mode is a separate licensed deployment option, not a claim of no remote data exposure for the GitHub App.
