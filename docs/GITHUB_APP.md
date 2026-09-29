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
