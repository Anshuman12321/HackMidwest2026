# Ripple implementation handoff

Updated 11 October 2026. This handoff covers the local React app, verified Supabase persistence, deployed snap-in inspection, and the existing agent/review safeguards on `dev`.

## Current state

The agent, authenticated review service, durable worker, and Snap-in package are implemented. The local browser uses the shared controller and native-card renderer. Fixture mode is fully offline; live preview reads DevRev but creates only simulated `PREVIEW-*` tickets. The React app in `apps/ripple/web` uses the same signed controller with persistent local or Supabase storage. The hosted Ripple app is deployed on Vercel at https://ripple-orpin-six.vercel.app (project `ripple`), with writes enabled in production. It runs the investigator in-process, stores state in Supabase schema `ripple_hosted`, and creates a ticket only after explicit approval in the UI. The Team01 snap-in installed earlier was read-only; the repository snap-in is now a launcher card that shows status and links to the hosted app. Pushing this branch does not deploy or install anything. See [the README Vercel section](../apps/ripple/README.md#hosted-deployment-vercel).

The product decision is **the solved issue is the business outcome**. **Investigate issue** derives `Resolve <display ID>: <current title>` and anchors retrieval to the accessible native issue, including its description and acceptance criteria. **Refine goal or add constraints** is optional and starts collapsed. Blank or whitespace-only goals use the issue. Saved refinements survive re-investigation; **Fresh review** resets intake to the issue. Default constraints prohibit production-setting changes and keep customer updates as drafts. The v2 contract still contains a resolved outcome string; no schema or database migration was added for optional intake.

The Brazil demo proposes one internal ticket containing scheduler investigation, replay-safety checks, and customer-update drafts. It does not reroute traffic, resolve the original issue, or send customer messages. The separate-work fixture demonstrates three proposed tickets. Only approval of the current sealed revision permits execution.

## React app and current verification

Run `RIPPLE_PYTHON=/path/to/python3.11-or-newer npm run app:read` and open `http://127.0.0.1:8788`. Configuration lives in ignored `apps/ripple/.env.local`; start from `local.env.example`. Read-only mode has no decision/owner controls, rejects those actions server-side and disables the worker. Investigations use current DevRev MCP evidence with the local contract planner. The fallback fixture mode creates only `PREVIEW-*` work. `npm run app:live` uses the personal MCP reader and local planner, with simulated writes. `connected` requires an explicitly configured v2 agent endpoint and delegated native credentials. Mode labels remain visible throughout review and approval.

Supabase MCP provisioned migrations 001–004 in project `qqzqgmlgzxkevgswnkzj`, with RLS enabled and browser roles denied access. The app connected through the IPv4 session pooler using the official CA and verified TLS. Browser intake, goal editing, owner revision, approval, completed simulation and application restart persisted to Supabase before the read-only scope change. The final read-only flow saved a separate live investigation with zero jobs, write rows or simulated tickets. One approved ticket produced one completed ledger row and one durable simulated native record. Tests also close/reopen the disk database and replay approval without duplicate creation. The React app polls genuine worker progress; it does not invent agent phases.

DevRev inspection used MCP for identity, issue, snap-in and function contexts. Because MCP exposes no snap listing/invocation tool, read-only REST located the installed snap and downloaded its deployed artifact. Snap `639fd639-f6d7-454c-8885-e5c944d17092`, version `5314e367-72bf-42c6-8eec-b67afe87d115`, artifact/360 implements actor-scoped read-only investigation and display-only proposed work. The actual function factory calls `hostedNative`, not the bundled HTTPS review bridge; installed inputs are empty and scopes lack ticket writes. The user confirmed this read-only snap is the current deployment and deferred building ticket creation/API triggers to a fresh run. The React app does not claim hosted-agent execution. Local fixture, live-preview and read-only tables are isolated in separate Supabase schemas; connected/public remains a separate integration boundary. No deployed agent configuration was changed. Vercel hosting is now in use; it is documented in the README.

The initial Supabase verification created fixture records in `public` before mode isolation was introduced. Those records remain preserved; all new local runs use isolated schemas. Before enabling a future connected/public runtime, separate those legacy simulation records from the native execution namespace.

The current suite passes 126 TypeScript tests. Native ticket creation is implemented behind explicit approval in the hosted app. Local read-only actions are tested to reject signed approvals/owner changes without scheduling work.

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

The earlier preview scrolling/interaction pass verified blank refinement, owner assignment, citations, graph modes/nodes/relationships, zoom/close, reset and simulated approval in the browser. That earlier implementation passed 88 TypeScript tests, the offline Python adapter checks, TypeScript validation, JavaScript syntax validation and the Snap-in build. Browser layout checks are manual; the automated suite does not prove native DevRev acceptance.

## Remaining DevRev deployment work

Use [the runtime/deployment guide](../apps/ripple/README.md#deployment) and [environment template](../apps/ripple/.env.example). Supabase schema `ripple_hosted` is provisioned and the Vercel deployment is live (README, "Hosted deployment (Vercel)"). Real ticket creation awaits the user's explicit approval in the UI. The repository snap-in is a launcher card; it must be rebuilt and reinstalled to ship. The table lists rollout items still open. The Vercel path replaces the separate review service and polling worker, and does not reconfigure the teammate's existing agents.

| Work | Handoff requirement |
| --- | --- |
| Service and database | Hosted schema is `ripple_hosted` (applied per `migrations/hosted-setup.md`; the function never migrates). Configure database backups, restricted roles, stable `RIPPLE_SECRET` and log redaction. `migrate.ts` and `main.ts` apply only to the container path. |
| Agent | Vercel uses the in-process `hosted-agent.ts` port; no separate agent process is needed there. `agent-main.ts` remains for connected/local modes and needs its own protected bearer and start command. |
| Delegated auth | `DEVREV_TOKEN` is the DEVU-6 personal access token by user decision, which suits this single-user app. Rotate it, since it was exposed in a session log. Any multi-user rollout needs a deployment-owned actor-delegated MCP endpoint and verified native assignment roles. |
| Snap-in | Regenerate `build.tar.gz`, configure `ripple_service_url`, and set keyring `ripple_bridge_secret` to the value of `RIPPLE_BRIDGE_SECRET` (not `RIPPLE_SECRET`). Install through the DevRev version/install flow, and verify scope names and installation rights against the current platform reference. |
| Native acceptance | On ISS-42, verify the launcher card status, the **Open in Ripple** link, the signed `/native/status` call, and that the snap-in exposes no write controls. Then approve one revision in the web app and verify real ticket readback. |
| Second-user acceptance | Not applicable to the single-user deployment. Required before any multi-user rollout: a fresh authorized session must create its own review, fail to read another actor's plan or approve copied signed controls, and complete approved work only with its actual native permissions. |
| Runtime recovery | Inline `workOnce` replaces the polling worker on Vercel. Verify lease resumption through `/initialize` and `/cron`, and exercise timeout-after-create reconciliation against the real native API. Local PGlite and simulated writes do not establish multi-process or native-write behavior. |

Native writes create approved internal tickets only. Severity/stage changes, native dependency links, timeline summaries, outbound messages and production changes remain outside the implemented write scope. March evidence is historical replay, not proof of a current outage. No live business work was created during the earlier local validation.

## Code map

### Brazil subscription investigation example (October 11)

The local read-only React app was rerun on native **ISS-42** (source ISS-031) with the refinement **“Restore Brazil subscription renewals without double billing.”** Live MCP retrieval produced 12 context records, 7 source-record relationships and 16 citations: the issue, TKT-50/TKT-52/TKT-53, CAPL-4, TechFlow Payments/GlobalCommerce Solutions/GlobalMart, and four explicitly archive-only guides. The review is saved in `ripple_read_only`; its execution jobs and action ledger remain empty. Customer reports distinguish missing scheduled payment attempts from successful manual API charges; current runtime cause and safe recovery remain unverified.

Known local retrieval limitation: `issueOutcome` uses the imported issue title, while `retrieve_investigation.py` scores candidates against the first eight outcome terms with an 0.8 threshold. The default rerouting title filters out these three customer reports despite their semantic search relevance. The focused refinement retrieves all three without hardcoded evidence IDs. Improving this ranking remains separate work; the deployed teammate snap-in was not changed.

A subsequent broader run kept native ISS-42 as the verified `starting_issue` and used **“Restore subscription renewals without double billing.”** Constraints focus on Brazil, compare historical renewal/retry/dunning/webhook symptoms, prohibit shared-cause assumptions, and prohibit production changes or sending updates. This retrieved **15 records, 10 source-record relationships and 22 citations**. Added records are the distinct native ISS-13 auto-renewal issue (source ISS-002), TKT-7's historical report of 400 uncharged subscriptions, and FEAT-22 Renewal & Cancellation Workflows. GlobalCommerce appears in both the historical general renewal report and a Brazil report. These are comparison records, not proof the incidents share a runtime cause; there is no invented issue-to-issue causal edge. The retrieved set contained no plan-migration, seat-quantity or cancellation-only work.

| Area | Files |
| --- | --- |
| Issue intake and actions | `apps/ripple/src/controller.ts`, `types.ts`, `ui.ts` |
| Native issue metadata | `apps/ripple/src/native.ts`, `local-native.ts` (`issueBrief` returns title/body separately from strict wire identity) |
| Graph | `apps/ripple/src/graph.ts`; preview graph data is added only in preview mode |
| Browser rendering | `apps/ripple/web/app.tsx`, `app.css`, `build-web.ts`; `src/local-app.ts` serves React. `preview` remains the separate simulation lab. |
| Agent and exact revalidation | `apps/ripple/src/agent-main.ts`, `agent-http.ts`, `agent-process.ts`, `contracts/investigate.server.ts`, `scripts/agent_bridge.py` |
| Approval, storage, recovery | `apps/ripple/src/service.ts`, `store.ts`, `security.ts`, `migrations/001_ripple.sql` |
| Native installation bridge | `apps/ripple/snap-in/manifest.yaml`, `src/bridge.ts`, `src/function-factory.ts` |
| Intake regression tests | `apps/ripple/src/ui.test.ts`, `native.test.ts`, `local-native.test.ts`, `agent-http.test.ts` |

The shared executable contract remains [contracts/investigation.ts](../contracts/investigation.ts) v2. Older agent/data documents retain historical proposals below their current-state notes; use this handoff and the runtime guide for current behavior.
