# Peerivo Reviewer — GitHub App

Public, source-transparent GitHub App shell for **Peerivo Reviewer**.

Reviewer checks the security boundary of pull requests — CI authority, secrets, supply-chain references, caches, migrations and fail-open security logic — without executing the reviewed project's build, tests, install scripts or application code.

This repository contains only the GitHub integration layer. The proprietary detection engine is hosted separately and is not distributed to customer repositories.

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
  - reads workflow files with Contents: read
  - never executes repository code
        |
        v
Peerivo Reviewer API (private engine)
        |
        v
GitHub Check Run: pass / blocking findings / fail-closed error
```

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

Node.js 22+ and no third-party npm runtime dependencies.

```bash
cp .env.example .env
npm run check
npm start
```

Webhook endpoint:

```text
POST /webhooks/github
```

Health endpoint:

```text
GET /healthz
```

## Required deployment secrets

`GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET` and `REVIEWER_API_TOKEN` are server-side secrets. They must never be committed to this public repository or delivered to customer repositories.

The GitHub App private key is used only to obtain short-lived installation tokens. The Reviewer API token authenticates this hosted integration to the private service; customer entitlement is resolved server-side from installation/repository identity.

## Fail-closed behavior

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

The integration sends bounded diff/workflow metadata to the private Reviewer API. Reviewed project code is not executed. Source payloads and detected secret material must not be written to application logs.

See [`docs/SECURITY.md`](docs/SECURITY.md).

## Status

`0.1.0` — initial GitHub App shell for external pilot preparation.

## License

Proprietary. See [`LICENSE-PROPRIETARY.md`](LICENSE-PROPRIETARY.md).
