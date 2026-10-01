export const GITVERSE_REVIEWER_WORKFLOW_PATH = ".gitverse/workflows/reviewer.yml";

export const GITVERSE_REVIEWER_WORKFLOW = `name: Peerivo Reviewer

on:
  pull_request:

jobs:
  reviewer:
    name: Peerivo Reviewer
    runs-on: ubuntu-latest

    env:
      PEERIVO_REVIEWER_API: https://api.reviewer.peerivo.net
      PEERIVO_REVIEWER_CLIENT_URL: https://raw.githubusercontent.com/Peerivo/reviewer-pub/a6607c58d9a40c1540390d0f0d31b0958b0f0ae6/clients/remote-reviewer.mjs
      PEERIVO_REVIEWER_CLIENT_SHA256: bd5050b1003a3e8cf50e736ff18a01363bbd161c83580bb25b067a98ab89e1b4
      PEERIVO_LICENSE: ${{ secrets.PEERIVO_LICENSE }}
      PEERIVO_BASE_REF: ${{ github.event.pull_request.base.sha }}
      PEERIVO_PULL_REQUEST: ${{ github.event.pull_request.number }}
      PEERIVO_PLATFORM: gitverse
      PEERIVO_REPOSITORY_VISIBILITY: public
      GITVERSE_REPOSITORY: ${{ github.repository }}

    steps:
      - name: Checkout exact PR head
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false

      - name: Download pinned Reviewer
        shell: bash
        run: |
          set -euo pipefail
          curl --fail --silent --show-error --location \
            --proto '=https' --tlsv1.2 \
            "$PEERIVO_REVIEWER_CLIENT_URL" \
            --output /tmp/peerivo-reviewer-client.mjs
          printf '%s  %s\\n' \
            "$PEERIVO_REVIEWER_CLIENT_SHA256" \
            /tmp/peerivo-reviewer-client.mjs \
            | sha256sum --check --strict

      - name: Run Peerivo Reviewer
        run: node /tmp/peerivo-reviewer-client.mjs
`;
