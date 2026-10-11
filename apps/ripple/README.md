# Ripple issue brief

## Hosted deployment (Vercel)

Production URL: https://ripple-orpin-six.vercel.app (Vercel project `ripple`). Ripple is a single-user web app that reads and writes Team01 through one server-side DevRev credential. Design decisions and rollout challenges, with their root causes, are recorded in [docs/ripple-hosted-decisions.md](../../docs/ripple-hosted-decisions.md).

Build and deploy from the repository root:

```sh
npm run build:vercel
vercel deploy --prebuilt --prod
```

`build:vercel` writes Build Output API v3 to `.vercel/output`: the React app as static files, plus one Node 22 function (`api.func`) bundling `src/hosted-app.ts` with `imports/maple-payments/manifest.json` and `data.zip`. `sharp` is not bundled, so `/graph/*.png` is unavailable on Vercel; the React UI uses the SVG explorer.

- **Access:** Ripple's access code (`RIPPLE_ACCESS_CODE`) is checked at `/login` and sets a signed HttpOnly session cookie (12 hours). Vercel SSO protection is disabled, so this code is the gate. `/login` has no rate limit yet. Mutations require `Origin` equal to `RIPPLE_PUBLIC_URL`.
- **DevRev auth:** the server uses one `DEVREV_TOKEN`, currently the DEVU-6 personal access token by user decision. It was exposed in a session log and should be rotated. `RIPPLE_ACTOR_IDS` and `RIPPLE_ASSIGNABLE_OWNER_IDS` are the actor and owner allowlists. Credentials are read only on the server and never reach the browser bundle.
- **Investigator:** `src/hosted-agent.ts` is an in-process TypeScript port of the Python bridge: an MCP read-tool allowlist and exact revalidation against cited native records. Vercel runs no Python subprocess and uses no personal connector config. The Python path remains for local modes.
- **Storage:** Supabase Postgres schema `ripple_hosted`, with RLS on and no `anon`/`authenticated` grants. It is separate from legacy `public` rows and the local schemas. Migrations were applied via Supabase MCP on 11 October 2026 (see `migrations/hosted-setup.md`). `DATABASE_CA_CERT` holds the CA certificate PEM.
- **Worker:** Vercel runs no polling worker. After approval or reconcile, `workOnce` runs inline in the request. `/initialize` resumes pending or expired-lease jobs, and `/cron` does the same when called with `CRON_SECRET`.
- **Writes:** enabled only when `RIPPLE_WRITES_ENABLED=true`, which is set in production.
- **Approval flow:** the reviewer sees the exact title, body, part (CAPL-4 for ISS-42), owner, evidence and revision/digest. Title or body edits seal a new revision, and approval authorizes only that revision. Ripple never creates tickets on its own; a ticket is created only after approval in the UI. `action_key` is the DevRev `external_ref` plus a ledger fence against duplicates. Uncertain writes are reconciled with **Check write status**, never recreated. `works.create` sends `visibility: 1` (internal), per the DevRev OpenAPI `works-create-request-ticket`.
- **Multi-issue:** `?issue=<DON or ISS-n>` opens any Team01 issue; ISS-42 (`RIPPLE_ISSUE_ID`) is the default.
- **Snap-in:** `apps/ripple/snap-in` is a minimal launcher card showing Ripple status and an **Open in Ripple** link, on any Team01 issue. It calls `POST /native/status` (see `snap-in/BRIDGE_CONTRACT.md`) with only the viewer's DevRev actor session token. Ripple verifies active workspace membership and issue access with that token, and returns read-only status. The card has no write controls and needs no keyring: the earlier shared-secret proof was removed because DevRev never delivered the developer keyring to the function. Installed as package `45b70a9e-5e0d-44a7-81a3-acf5a4fbaaee`, installation `c27b5754-ccd3-4b35-9a66-16b3801f2f48`. Upgrade with `devrev snap_in_version upgrade --manifest manifest.yaml --archive build.tar.gz` from `apps/ripple/snap-in`, **never with `--force`**, which deletes the installation.
- **Review expiry:** a sealed revision expires 30 minutes after investigation. The decision rail then shows **Review expired** with **Investigate again**, and hides owner, edit and approve controls.

Environment variable names (values are never committed or documented):

| Variable | Purpose |
| --- | --- |
| `RIPPLE_SECRET` | Signs session and UI state; at least 32 characters. |
| `RIPPLE_ACCESS_CODE` | Ripple's access code for `/login`. |
| `RIPPLE_PUBLIC_URL` | Public origin; the mutation `Origin` check and `open_url`. |
| `CRON_SECRET` | Guards `/cron`. |
| `DEVREV_TOKEN` | Server-side DevRev credential. |
| `DEVREV_WORKSPACE_ID` | Team01 workspace. |
| `DEVREV_APP_URL` | Optional; builds ticket links (`<app>/works/<id>`). |
| `RIPPLE_ACTOR_IDS` | Comma-separated actor DON allowlist. |
| `RIPPLE_ASSIGNABLE_OWNER_IDS` | Comma-separated owner DON allowlist. |
| `RIPPLE_ISSUE_ID` | Default issue. |
| `RIPPLE_WRITES_ENABLED` | Must be `true` to enable approved writes. |
| `DATABASE_URL` | Privileged Postgres connection for `ripple_hosted`. |
| `DATABASE_CA_CERT` | PEM CA certificate for database TLS. |

Optional: `RIPPLE_IMPORT_ROOT` overrides the directory containing the bundled Maple import.

Verification: 125 tests pass (`npm test`). Remaining: real ticket creation awaits the user's approval in the UI; browser visual verification is not automated; `/graph/*.png` is not bundled on Vercel; `/login` has no rate limit.

## Local React app

Run `npm ci`, then `RIPPLE_PYTHON=/path/to/python3.11-or-newer npm run app:read` from the repository root and open `http://127.0.0.1:8788`. This pass focuses on read-only live investigation; approval-gated ticket creation runs only in the hosted Vercel deployment described above. The current ignored local configuration selects read-only mode for `npm run app` too. `npm run build:app` bundles React locally into `web/build`; browser assets require no CDN. The existing `npm run preview` remains the separate simulation lab.

The React app uses the shared controller, v2 contract, source revalidation, sealed owner revisions, approval receipts and durable worker. The main workspace now contains an interactive evidence map with ID/customer/topic search, immediate record and relationship inspection, connection highlighting, a focused neighborhood view, source excerpts, pointer-centered zoom, drag panning, Fit, and an expanded viewer. Arrow keys pan; +/− zoom; 0 fits; Escape closes the viewer. Proposed-work mode connects every cited context record to its proposed ticket. Native DevRev cards retain their signed PNG. The issue heading displays native ISS-42 separately from imported source ISS-031, so the title no longer appears to identify a different issue. Set `RIPPLE_LOCAL_ISSUE_ID` in `.env.local` to the verified native DON to change the starting issue; the demo is configured for `don:core:dvrv-us-1:devo/1mWckJhGyy:issue/42`. **Edit goal & scope** creates a fresh investigated plan; owner changes seal a new revision. Approval always applies to the complete saved revision. Rejection creates no work.

Copy `local.env.example` to the ignored `.env.local` for local configuration. Four explicit modes are available:

| Mode | Investigation | Ticket creation |
| --- | --- | --- |
| `read-only` (`npm run app:read`) | Current DevRev MCP evidence and local contract planner | No write controls, server rejects decision/owner actions, worker disabled |
| `fixture` (fallback when no mode configured) | Offline contract fixtures | Durable `PREVIEW-*` simulation |
| `live-preview` (`npm run app:live`) | Existing personal MCP reader and local outcome planner; Python 3.11+ | Durable `PREVIEW-*` simulation |
| `connected` | Configured `AGENT_URL` implementing `/investigate` and `/revalidate` | Existing native DevRev adapter, after signed explicit approval |

Connected mode requires the server-only actor token, workspace, actor/owner allowlists, issue DON, MCP URL and agent bearer in `local.env.example`. It verifies authenticated identity and issue access, and never falls back to fixture or personal-connector credentials. This single-user local server binds to loopback and checks Host and mutation Origin; it is not a hosted multi-user login service.

Without `DATABASE_URL`, reviews, decisions, worker jobs, simulator native records and the signing key persist under ignored `.preview-data`. Restarting preserves reviews and reconciles existing simulation IDs. Do not run two local processes against the same PGlite directory. With `DATABASE_URL`, the same transaction/ledger implementation uses PostgreSQL/Supabase. Fixture, live-preview and read-only use separate schemas, preventing reviews or jobs from crossing modes. Local schema migrations are applied automatically; connected/public migrations remain explicit via `npm run migrate`. Use a stable `RIPPLE_SECRET` and a privileged server database connection: RLS is enabled with no browser policies, and `anon`/`authenticated` grants are revoked.

On 11 October 2026, the configured Supabase MCP project `qqzqgmlgzxkevgswnkzj` received migrations 001–004, including local mode isolation. Browser roles have no table access. The local app was verified against that database using the session pooler and certificate-verified TLS: intake, fresh goal review, owner revision, explicit simulated approval, completed worker result, and process restart all persisted. The ignored `.env.local` contains the server connection; download the official CA from Database Settings and configure `sslmode=verify-full&sslrootcert=/absolute/path/to/certificate`. See [Supabase connection guidance](https://supabase.com/docs/guides/database/connecting-to-postgres). No database credential is bundled into React.

Historical (superseded by the launcher installation above). Earlier integration discovery: DevRev MCP verified Team01 (`1mWckJhGyy`), actor DEVU-6, ISS-42, and active Ripple snap-in `639fd639-f6d7-454c-8885-e5c944d17092` (modified 11 October). Its deployed version `5314e367-72bf-42c6-8eec-b67afe87d115` wires `ripple_initialize` and `ripple_action`; its manifest grants read scopes, with empty configured inputs. Read-only inspection of deployed artifact/360 confirms actor-scoped MCP retrieval and an internal v2 investigation, returned as rendered Snap cards. Proposed work is display-only: those handlers contain no owner revision, approval or ticket-write path. The bundled service bridge exists but is not called by the deployed function factory. MCP exposes no function invocation/API-trigger configuration tool. The user confirmed this is the current deployed capability and deferred building ticket creation and API triggers to a later run. `connected` therefore remains a configured contract boundary, not proof that this app calls the hosted flow. No teammate agent or snap-in configuration was changed.

Local verification includes HTTP intake → citation → owner revision → approval → worker results, rejection/no jobs, duplicate approval, cross-origin blocking, and disk database restart. The read-only app uses current MCP evidence with the local planner, as its on-screen provenance explains; it does not invoke the hosted snap function. Native ticket creation is handled by the hosted Vercel deployment, after explicit approval. Snap-component development is outside this local app change.

For the current change summary, browser acceptance checklist, and remaining rollout work, see [the handoff](../../docs/ripple-handoff.md).

The implementation renders native Snap-kit cards on an issue, accepts a validated v2 investigation, saves owner revisions, and executes an approved batch as internal DevRev tickets. Resolving the current issue is the default goal: **Investigate issue** reads the native title and anchors retrieval to its description and acceptance criteria. A collapsed **Refine goal or add constraints** form is optional; a blank refined goal uses the issue. Re-investigation preserves a saved refinement, and **Fresh review** starts again from the issue. Brazil creates one ticket containing scheduler investigation, replay-safety checks, and customer-update drafts. The separate-work fixture contains three tickets.

## Run and inspect

Use Node 26. From the repository root:

```sh
npm ci
npm run check
npm test
npm run build:snap-in
npm run preview
```

Open `http://127.0.0.1:8788`. The preview uses the production controller, renderer, guards, SQL schema and worker with an embedded PostgreSQL test database and explicit fixture adapters. It makes no network calls to DevRev or the agent. Its in-memory results are labelled `PREVIEW-*`; they are not native work IDs. Choose the separate-work fixture before investigating to demonstrate a partial batch. Choose timeout-after-creation before approval, then **Check write status** to see reconciliation without another create. Restarting the preview process clears its simulated state.

The preview follows `references/ripple-devrev-app.html` with a dark workspace rail, a minimal issue document, and a compact Ripple panel. Its editorial hierarchy uses restrained type, thin dividers, yellow primary actions, collapsible evidence/source details, and clear approval/results. After investigation, issue intake collapses to put findings first. The expanded preview graph supports node and relationship selection, citations, zoom, keyboard dismissal, and responsive layout. It uses the same signed controller actions and graph data as the native cards. Native DevRev controls inherit platform styling; the browser shell and expanded dialog belong to the local preview and do not establish native rendering or a native graph modal.

The issue document and Ripple panel scroll independently on desktop; narrow layouts use page scrolling and retain preview controls. Step buttons navigate to available sections. The graph thumbnail opens the viewer, whose canvas and inspector scroll independently. Requests disable only conflicting action controls, leaving navigation, disclosures, scrolling and dialog dismissal available. The viewer preserves selection focus and inspector position through updates; **Fit** uses its actual available space.

Preview HTML/CSS/JavaScript are read when the process starts. Restart the preview after editing those assets, then reload the browser. To avoid an occupied default port, run `PREVIEW_PORT=8798 npm run preview` and open `http://127.0.0.1:8798`; restarting also clears simulated reviews and writes.

## Integrated local browser demo

The teammate's outcome-led retrieval and planner now use the same v2 contract as this UI. Live investigations propose one internal ticket containing scheduler investigation, recovery/replay-safety checks and customer-update drafts. The browser runs the actual `AgentClient` against authenticated loopback `/investigate` and `/revalidate` endpoints.

Use Python 3.11+ and the existing local DevRev MCP connection. From the repository root:

```sh
RIPPLE_PYTHON=/path/to/python3 PREVIEW_PORT=8818 npm run preview:live
```

On this Mac, the bundled Python is `/Users/mdv/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3`. Open `http://127.0.0.1:8818`, investigate ISS-42, open the evidence, select the verified current reader as owner, and approve simulated ticket creation. Results use `PREVIEW-*` IDs. The live preview reads current DevRev source access and original imported March records; it does not establish a current outage. Documentation remains explicitly archive-only. Restarting clears the local simulation database.

The local bridge reads credentials inside Python and never puts them into browser state, URLs or command arguments. Native reads have an explicit allowlist; the preview has no real ticket-write adapter. Its actor is the verified local connector reader, and only that reader is offered for simulated assignment. The production agent never falls back to this personal configuration.

The original `npm run preview` remains an offline fixture lab, including multiple-ticket and partial-write scenarios. Fully offline HTTP integration tests cover the real planner, sealed owner revisions, approval and simulated worker, plus evidence/access failure blocking.

## Deployment

1. Provide PostgreSQL and an HTTPS service origin. Copy `.env.example` to an ignored local configuration file and replace placeholders. Generate a new random `RIPPLE_SECRET`; keep it stable across worker restarts. Use a protected secret manager in deployment. Run `node --env-file=apps/ripple/.env apps/ripple/src/migrate.ts`, then `node --env-file=apps/ripple/.env apps/ripple/src/main.ts`. Migrations are idempotent. On a container host the service starts a durable polling worker (Vercel runs none; see the Vercel section); multiple instances claim jobs using PostgreSQL row locks and leases. The Dockerfile builds from the repository root; put an HTTPS reverse proxy in front of it.
2. Supply an actor-delegated DevRev MCP endpoint. Start the included agent with `AGENT_BEARER=<protected-secret> RIPPLE_PYTHON=/path/to/python3 npm run start:agent` and point `AGENT_URL` at its protected HTTPS origin (loopback HTTP is supported locally). A chat connector session or a developer PAT is not a deployment credential. Production startup requires the MCP URL and agent URL; fixture adapters are never a production fallback. Owner search discovers `hybrid_search`, first discovers available actions and actual create/lookup schemas, and stops if required ticket fields differ. It explicitly includes authenticated self, then verifies candidates against current native records and the installation's assignment policy.
3. Set `RIPPLE_ACTOR_IDS` and `RIPPLE_ASSIGNABLE_OWNER_IDS` to the administrator-reviewed allowed actor and owner DONs for this installation. These narrow the native actor's authority; they do not grant native permissions. The first slice restricts plan access to its creating actor. Native source reads and active-owner checks run at review, approval and execution. DevRev enforces ticket-write/assignment permissions using the delegated actor token. The current connector exposes no reliable dry-run assignment-permission endpoint; verify that policy with actual native roles before enabling approval in Team01.
4. Configure `ripple_service_url` to the HTTPS origin. No keyring is needed. Build with `npm run build:snap-in`; install `snap-in/manifest.yaml` and `snap-in/build.tar.gz` using the DevRev CLI (`npm install -g devrev`; Homebrew is no longer supported). The snap-in is a minimal launcher: it calls `POST /native/status` with the platform actor token, shows the issue's Ripple status in one snap-kit card, and offers an **Open in Ripple** link button (`href`) to `${ripple_service_url}/?issue=<issue DON>`. If status fails the link still renders with a "status unavailable" note. Review and approval happen only in the web app; the snap-in requests `issue:read` and `dev_user:read` only.
5. In Team01, verify installation rights, requested scope names against the current API-to-scope reference, initializer context, issue surface rendering on ISS-42, native owner-picker/form payloads, approval disabling while an owner revision is pending, and image fetching from the scoped HTTPS URL. Inspect grants using a fresh second-user session: that user cannot read the first user's plan, may create their own review if enabled, and cannot approve a copied signed control. Scope/actor-context behavior and rendering are rollout gates, not assertions from the local preview.

The local React app has verified Supabase persistence. An active read-only Ripple snap-in is installed in Team01; the installed Team01 snap-in was read-only. The repository snap-in is now a launcher card, and the hosted Vercel app handles approval and ticket creation. Second-user browser acceptance remains a future rollout check. No live business work was created by implementation checks.

## Agent boundary

The shared source of truth is `contracts/investigation.ts` with exact version `2.0`. The included `agent-main.ts` supplies two authenticated HTTP endpoints under `AGENT_URL`; the service sends `Authorization: Bearer AGENT_BEARER` and JSON:

```typescript
{ payload: InvestigationRequest | InvestigationResponse,
  context: { workspace: string, actor_id: string, actor_session_token: string } }
```

- `POST /investigate` returns a complete validated `InvestigationResponse`. It must retain the request ID, outcome, constraints, reference date when supplied, and include the native starting issue in its Context Bundle. The agent owns retrieval, evidence validation, gaps, and decomposition into up to eight internal tickets. A null reference date asks the agent to resolve the investigation's date; the Brazil fixture deliberately chooses March 24, 2026 and is labelled as a replay.
- `POST /revalidate` receives the complete sealed response after authoritative IDs, owner edits and digest changes. Return `{ valid: true, investigation_id, plan_digest }`, where `plan_digest` is the supplied graph digest or `null` for a response with no graph. The included implementation authenticates the actor, rereads exact cited native IDs and related source mappings, checks full original hashes and excerpts, and reopens checksum-verified archive documents. New read timestamps are allowed while reviewed provenance stays sealed. It does not rerun ranked search or derive an as-of cutoff from the resolved response date. On changed evidence return `{ valid: false, code: "evidence_changed" }`; use `permission_denied` for revoked access. The service blocks approval/execution on either. Credentials stay between trusted servers and are never included in UI state.

The service owns plan IDs, canonical sealing, original expiry (capped at 30 minutes), owner revisions, decisions and execution. Reviewers may edit a ticket's title and body (`content_edits`, same limits as the plan schema) before approving; each edit seals a new revision and digest like an owner change, and approval covers exactly the edited text. The `action_key`/`external_ref` stays stable, so a ticket already created from an earlier revision turns a later edited approval into `action_conflict` rather than a duplicate. Evidence, part or split changes still start a fresh investigation. The bridge permits 90 seconds and the agent request 60 seconds; if real investigations exceed this, add an asynchronous investigation job and polling state before rollout. Approval execution is already asynchronous.

## Durable decisions and writes

`ripple_plans` scopes complete responses by workspace and creating actor. Revisions and decisions lock the plan row. Approval atomically stores a server-issued receipt, exact decision request/hash, and worker job. Rejection has no receipt/job and creates zero work. The UI signs workspace, actor, issue, revision and digest; it never supplies approval authority. Unsaved owner edits keep the old digest, so stale controls cannot approve a new revision.

`ripple_actions` uniquely reserves workspace/action key **before** `works.create`. Its fingerprint covers the exact reviewed native title, body, part, one owner, internal visibility `1`, and `external_ref`. Native lookup uses that reference and reuses only an exact match. Incompatible objects are never overwritten. Identical decision repeats return stored state; reused keys with changed content conflict.

The worker encrypts the delegated actor token at rest and clears it after finishing. A crash after durable intent, timeout, conflict response, failed readback, or lost result commit remains uncertain. Even repeated absence from lookup cannot authorize a create. **Check write status** only reconciles uncertain writes; confirmed terminal failures need a fresh review. Successful rows remain visible in partial batches and when later evidence revalidation blocks reconciliation. Configure encrypted database backups, restricted database roles, retention and key rotation for your deployment.

Graph PNGs are deterministic from validated data. Their signed URLs carry workspace/actor/plan/digest/view and expire after five minutes; stale revisions are denied. URLs are bearer grants, so proxy logs must redact the path. Responses use `no-store` and `no-referrer`. Revocation can take up to the existing grant's five-minute lifetime; refreshing the component rechecks access. The accessible relationship list and selectors expose citations separately from the image.

Native ticket creation is the sole approved work operation. Severity/stage, native dependency links, timeline summaries, customer messaging and production settings are not written.

## Validation coverage

Tests include the 19 preserved v1 checks, v2 single/multiple-ticket fixtures and semantic guards, PostgreSQL-schema integration workflows, concurrent revision/decision conflicts, no-write rejection/expiry/access/evidence failures, crash and timeout fencing, partial results, graph PNG generation and grants, native adapter readback, and launcher status authentication. PGlite runs the same migration/SQL locally; deployment still needs real PostgreSQL multi-process and fresh-session DevRev acceptance tests.

The local React change passed 95 TypeScript tests, 15 offline Python checks, TypeScript validation and the React build; the current suite passes 125 tests (see the Vercel section). The earlier native package validation also passed its Snap-in build. Earlier live-preview verification on ISS-42 opened an exact source citation, saved the current reader as simulated owner and completed one approved `PREVIEW-1` ticket. The final read-only React mode verified current issue intake, saved investigation reload, graph node/relationship selection, wheel zoom/Fit and exact native excerpts; it has no owner or approval controls. Native retrieval and exact-source revalidation both succeeded; no live DevRev work was created.

Official integration references: [Snap Components](https://developer.devrev.ai/snapin-development/references/snap-components), [Snap-kit](https://developer.devrev.ai/snapin-development/references/snapkit), [Function invocation](https://developer.devrev.ai/snapin-development/references/function-invocation), [Manifest](https://developer.devrev.ai/snapin-development/references/manifest), [Scopes](https://developer.devrev.ai/snapin-development/references/scopes), [API-to-scope reference](https://developer.devrev.ai/snapin-development/references/scope-reference), [official function factory](https://github.com/devrev/snap-in-examples/blob/main/1-starter/code/src/function-factory.ts).
