# Ripple implementation handoff

Updated 10 October 2026. This handoff covers the merged agent/UI implementation plus optional issue-goal intake, the editorial redesign, and the scrolling/interaction fixes on `dev`.

## Current state

The agent, authenticated review service, durable worker, and Snap-in package are implemented. The local browser uses the shared controller and native-card renderer. Fixture mode is fully offline; live preview reads DevRev but creates only simulated `PREVIEW-*` tickets. A hosted deployment and native Team01 installation are still pending. Pushing this branch does not deploy or install Ripple.

The product decision is **the solved issue is the business outcome**. **Investigate issue** derives `Resolve <display ID>: <current title>` and anchors retrieval to the accessible native issue, including its description and acceptance criteria. **Refine goal or add constraints** is optional and starts collapsed. Blank or whitespace-only goals use the issue. Saved refinements survive re-investigation; **Fresh review** resets intake to the issue. Default constraints prohibit production-setting changes and keep customer updates as drafts. The v2 contract still contains a resolved outcome string; no schema or database migration was added for optional intake.

The Brazil demo proposes one internal ticket containing scheduler investigation, replay-safety checks, and customer-update drafts. It does not reroute traffic, resolve the original issue, or send customer messages. The separate-work fixture demonstrates three proposed tickets. Only approval of the current sealed revision permits execution.

## Local setup

Use Node 26 and Python 3.11+ for agent checks/live reads. Run from the repository root:

```sh
npm ci
npm run check
npm test
python3 scripts/test_retrieval.py
npm run build:snap-in
npm run preview
```

Check `python3 --version` first. macOS may supply Python 3.9, which fails with `No module named tomllib`; use an installed Python 3.11+ executable for the checks and set `RIPPLE_PYTHON` to that executable for agent/live-preview commands.

The fixture preview defaults to `http://127.0.0.1:8788`. An alternate port can be set with `PREVIEW_PORT=8798 npm run preview` (POSIX shell), or `$env:PREVIEW_PORT = '8798'; npm run preview` (PowerShell). The port is local configuration, not a committed deployment setting.

Live reads require the reviewer's existing local DevRev MCP connection:

```sh
RIPPLE_PYTHON=/path/to/python3 PREVIEW_PORT=8818 npm run preview:live
```

Open `http://127.0.0.1:8818`. This personal connector setup is a local demonstration, not deployment authentication. The live preview offers only its verified current reader as a simulated owner. Credentials stay inside the bridge; do not put tokens into browser code, URLs, documentation, or commits.

Preview assets are loaded at startup. Restart the process and reload the browser after HTML/CSS/JavaScript changes. Restarting clears the embedded simulation database. Build output `apps/ripple/snap-in/build.tar.gz` is ignored by Git and must be regenerated after checkout.

## Interaction and rendering changes

The design reference is [ripple-devrev-app.html](../references/ripple-devrev-app.html). The preview uses a restrained issue document, dark navigation/header, compact evidence cards, yellow highlights, and collapsible details. Findings lead after investigation; owners and approval remain explicit.

The inaccessible-scroll bug came from grid/flex children retaining their content minimum height while the viewport-sized workspace hid overflow. The fix gives rows and scroll containers explicit shrinkable bounds. Desktop issue and investigation panes scroll independently. At widths up to 820px, page scrolling takes over; preview controls remain available. The modal uses a bounded flex header and grid body, with independently scrollable canvas and inspector, including on mobile.

Previously decorative step tabs now jump to available sections and open issue context when needed. Unavailable steps are disabled. The issue/sidebar links navigate locally. The graph thumbnail and open button launch the viewer; graph nodes, record/relationship selectors, and citations use signed controller actions. Fit calculates actual canvas dimensions. Updates preserve modal scroll position, disclosure state, and selection focus, and closing restores focus to the graph launcher.

Pending requests disable conflicting action controls rather than blocking pointer events across the entire UI. Navigation, disclosures, scrolling, zoom, and dismissal remain available. Newly rendered controls inherit the pending state and unlock when the request finishes. The browser request timeout is 90 seconds; after a timed-out approval, reload to recover the stored review before taking another action. An uncertain write must be reconciled, never blindly recreated.

The editorial shell, clickable image overlay, navigation tabs, and expanded graph dialog are **preview features**. Native DevRev receives Snap-kit cards, form, selectors, owner pickers, signed image and actions; its platform controls supply native styling. The browser demonstration does not verify native modal behavior or native rendering.

## Browser acceptance checklist

Test real wheel/touch scrolling as well as clicks; locator auto-scrolling can conceal a clipped layout. Manual checks passed at 390×844, 800×800, 1024×800, and 1280×800 in the local fixture preview.

1. Investigate with no separate goal; then start a fresh review and submit blank optional refinement. Both produce cited findings and a proposed ticket.
2. Scroll the issue document to its lower content and the Ripple panel to owners/approval. On narrow screens, scroll the page and expand Preview controls.
3. Use Issue, Context, Impact, Review and Act navigation. Expand supporting evidence, ticket details, and source details.
4. Open the graph from its thumbnail. Select nodes and the lower relationship options, open a citation, and scroll its source excerpt in the inspector. Switch Context/Proposed work; use zoom, Fit, close and Escape.
5. Select a current owner. Confirm approval becomes enabled for the saved revision, with no controls stuck disabled after the response. Approve and confirm `PREVIEW-*` completion; check write status, then start a fresh review.
6. Reject a review and confirm zero new work. For recovery demos, choose the write response before approval. Timeout-after-creation must reconcile the existing simulated ticket; separate-work plus partial failure must retain successful results.

The scrolling/interaction pass verified blank refinement, owner assignment, citations, graph modes/nodes/relationships, zoom/close, reset and simulated approval in the browser. Automated validation passes 88 TypeScript tests, the offline Python adapter checks, TypeScript validation, JavaScript syntax validation and the Snap-in build. Browser layout checks are manual; the automated suite does not prove native DevRev acceptance.

## Remaining DevRev deployment work

Use [the runtime/deployment guide](../apps/ripple/README.md#deployment) and [environment template](../apps/ripple/.env.example). The implementation has no configured hosted service, agent, PostgreSQL instance, or completed Team01 installation.

| Work | Handoff requirement |
| --- | --- |
| Service and database | Provision PostgreSQL and an HTTPS service origin. Apply `apps/ripple/migrations` through `migrate.ts`; start `main.ts`, which runs the durable polling worker. Configure database backups, restricted roles, stable encryption/signing secret, and log redaction. |
| Agent | Run `agent-main.ts` separately with Node/Python and the protected agent bearer secret. Make `/investigate` and `/revalidate` reachable from the service. Include the manifest and checksum-verified Maple archive used by retrieval. The Dockerfile defaults to the review service; an agent process needs its own start command. |
| Delegated auth | Provide a deployment-owned actor-delegated DevRev MCP endpoint. Verify allowed actor/owner DONs and native assignment roles. Personal connector credentials and a developer PAT are not substitutes for each user's delegated authority. |
| Snap-in | Regenerate the build archive. Configure `ripple_service_url` and developer secret keyring `ripple_bridge_secret` matching `RIPPLE_SECRET`. Install the manifest/package through the DevRev version/install flow. Verify scope names and installation rights with the current platform reference. |
| Native acceptance | On ISS-42, verify initializer context and actor token, nested/collapsed cards, one-click intake, blank optional refinement, owner picker/form payloads, signed PNG fetch, disabled approval during revision, and real ticket readback after explicit approval. |
| Second-user acceptance | A fresh authorized session must create its own review, fail to read another actor's plan or approve copied signed controls, and complete approved work only with its actual native permissions. |
| Runtime recovery | Exercise real PostgreSQL worker leases/concurrency and timeout-after-create reconciliation. Local PGlite and simulated writes do not establish multi-process or native-write behavior. |

Native writes create approved internal tickets only. Severity/stage changes, native dependency links, timeline summaries, outbound messages and production changes remain outside the implemented write scope. March evidence is historical replay, not proof of a current outage. No live business work was created during this UI validation.

## Code map

| Area | Files |
| --- | --- |
| Issue intake and actions | `apps/ripple/src/controller.ts`, `types.ts`, `ui.ts` |
| Native issue metadata | `apps/ripple/src/native.ts`, `local-native.ts` (`issueBrief` returns title/body separately from strict wire identity) |
| Graph | `apps/ripple/src/graph.ts`; preview graph data is added only in preview mode |
| Browser rendering | `apps/ripple/preview/index.html`, `preview.css`, `preview.js`; `src/preview.ts` serves the fixture/live preview |
| Agent and exact revalidation | `apps/ripple/src/agent-main.ts`, `agent-http.ts`, `agent-process.ts`, `contracts/investigate.server.ts`, `scripts/agent_bridge.py` |
| Approval, storage, recovery | `apps/ripple/src/service.ts`, `store.ts`, `security.ts`, `migrations/001_ripple.sql` |
| Native installation bridge | `apps/ripple/snap-in/manifest.yaml`, `src/bridge.ts`, `src/function-factory.ts` |
| Intake regression tests | `apps/ripple/src/ui.test.ts`, `native.test.ts`, `local-native.test.ts`, `agent-http.test.ts` |

The shared executable contract remains [contracts/investigation.ts](../contracts/investigation.ts) v2. Older agent/data documents retain historical proposals below their current-state notes; use this handoff and the runtime guide for current behavior.
