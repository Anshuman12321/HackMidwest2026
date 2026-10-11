# Ripple — Hack Midwest 2026

Ripple starts with a business outcome, finds relevant organizational evidence, and prepares the right investigation work in DevRev for human review.

- [Data, completed work, UI instructions, and integration handoff](docs/data-and-integrations.md)
- [Agent architecture and build starting point](docs/agent-build-guide.md)
- [Shared investigation contract, exact types, and validated examples](contracts/README.md)
- [Native Ripple UI, service, preview, and deployment guide](apps/ripple/README.md)
- [Interactive architecture site](https://ripple-demo-architecture.pearlyperch6.chatgpt.site/)
- [Imported Maple Payments dataset and tools](imports/maple-payments/README.md)
- [Original vision](idea.md)

The native workspace contains 8,448 issues, 11,422 tickets, 30 active opportunities, 42 accounts, 62 customer contacts, 40 product parts, 73 published articles, and 26 discussion comments. The ticket backlog was stopped at the user's request; closed opportunities were not loaded. See the manifest and verification reports for exact scope and check coverage.

The demo uses Enterprise-Bench's Brazil subscription renewal incident. The native issue-component renderer, v2 ticket contract, authenticated review service, PostgreSQL ledger and durable worker are implemented in `apps/ripple`. The existing architecture site remains a static explanation. The outcome-led agent and local browser demo are connected through authenticated v2 HTTP endpoints. Live deployment requires an actor-delegated MCP connection, hosted service/database and Team01 installation verification. External Jira, GitHub, Slack, and Drive connections have not been created.

Local `.env` contains `DEVREV_PAT` and is excluded from Git. Never put credentials in the site or documents. Do not resume the full benchmark backlog without a new request.

## Verification

The shared contract runs locally without DevRev credentials:

```sh
npm ci
npm run check
npm test
npm run build:snap-in
npm run preview
# Live DevRev reads with simulated ticket creation (Python 3.11+):
RIPPLE_PYTHON=/path/to/python3 npm run preview:live
```

Existing data/site checks (run from the repository root):

```sh
python3 imports/maple-payments/verify_imported_scope.py
python3 imports/maple-payments/verify_active_opportunities.py
node --check sites/ripple-demo/dist/app.js
```

API checks need the local token and network access. Preview the buildless site with:

```sh
python3 -m http.server 8765 --directory sites/ripple-demo/dist
```

The hosting manifest points to the existing Site project. Site publishing uses the Sites source workflow; the GitHub repo stores a copy of its normal source files, not the Site's nested Git metadata.
