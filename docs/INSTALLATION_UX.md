# Verified installation experience

GitLab and GitVerse share the same server-rendered installer experience. Start at `/install` for direct platform buttons and a brief product description; the customer does not need to find a README first. The external GitLab Catalog Components view itself is owned by GitLab, not by this server.

## Persistent status and next action

Saving selected projects redirects with HTTP 303 to `/gitlab/connected` or `/gitverse/connected`. That destination verifies the session-owned installation through the configured provider API. The same banner is present on the management page on every visit, without requiring `updated=1`.

The banner is green only after project identity, sufficient permissions and the exact stored webhook configuration are confirmed. Missing/disabled hooks or lost access produce actionable red states; network failures and incomplete verification produce amber states; no selected projects is neutral. It provides project, PR/MR, retry and management links. Failed writes and expired sessions render useful HTML with fixed messages, not provider response bodies.

Connection configuration is not a successful code review, a license entitlement, hard-gate execution or a passing pipeline. Verification does not create commits, run pipelines, submit reviews, or mutate remote project settings. The existing save action still provisions the hooks selected by the user.

Selected inputs, protected session cookies, CSRF and the existing GitVerse promo/hard-gate controls remain. OAuth exchange/refresh behavior and private engine code are unchanged.

## Product identity

Every installer view includes a localized brief explanation of Peerivo Reviewer, including that it does not execute reviewed project code. The header uses a text P monogram. The user's exact logo artwork has not yet been supplied; the monogram is not a claim that the final logo asset was installed. English and Russian are selected by Accept-Language or the explicit `?lang=ru` / `?lang=en` preference.

## Validation boundaries

`npm run check` includes real local HTTP tests with synthetic in-memory provider fixtures: save, redirects, persistent banners, permission and webhook errors, sessions, CSRF and product description. `tests/installation-persistence-regression.test.mjs` can run against the pre-change server to reproduce the four banner/destination assertion failures.

`tests/installation-render-fixtures.mjs` creates synthetic HTML for offline responsive layout checks at 320/390/768/1440 pixels. These are not live user screenshots.

The post-merge Installation Public Deploy Smoke checks the real hosted public description, direct buttons, script response and protected result/settings HTML. It does not perform user authorization or inspect private projects. Record exact commit, deployment and verified scenarios in the PR handoff; do not equate CI success with a verified live account connection.


## Repository licensing rule

The commercial default is one license activation per repository, independent of provider. A customer may use GitHub, GitLab or GitVerse, but a second repository requires a separate license/activation. Internal operator-issued owner-scoped gifts remain an explicit exception and are not the public default.

The unified installer shows all three providers. GitHub opens the Peerivo Reviewer GitHub App installation screen; customers should select the repository for that license. GitLab and GitVerse self-service forms accept at most one selected repository per save.
