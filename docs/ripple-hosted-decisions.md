# Ripple hosted: design decisions and challenges

Updated 11 October 2026. This is the decision log for the hosted Ripple rollout: the React review UI, the Vercel deployment, approval-gated DevRev ticket creation, and the DevRev launcher snap-in. Each entry records what was decided, why, and what it costs. The challenges section records problems found during rollout, with root causes, so they are not rediscovered.

Runtime and setup details live in [the README](../apps/ripple/README.md#hosted-deployment-vercel). The snap-in status contract is in [BRIDGE_CONTRACT.md](../apps/ripple/snap-in/BRIDGE_CONTRACT.md). Broader project state is in [the handoff](ripple-handoff.md).

## Current topology

```
DevRev issue (any Team01 issue)
  └─ Ripple snap-in launcher card ── POST /native/status (actor token) ──┐
                                                                          ▼
Browser ── access code ──► Vercel: static React + one Node function (hosted-app.ts)
                              ├─ in-process investigator (hosted-agent.ts → DevRev MCP, read-only allowlist)
                              ├─ Supabase Postgres, schema ripple_hosted (plans, decisions, action ledger, jobs)
                              └─ DevRev REST works.create  (only after UI approval of one sealed revision)
```

- Production: https://ripple-orpin-six.vercel.app (Vercel project `ripple`).
- Snap-in package `45b70a9e-5e0d-44a7-81a3-acf5a4fbaaee`, installation `c27b5754-ccd3-4b35-9a66-16b3801f2f48` in Team01 (`1mWckJhGyy`).

## Decisions

### Product and approval

| # | Decision | Why | Consequence |
| --- | --- | --- | --- |
| P1 | Ripple generates the proposed ticket. DevRev receives it only after a human approves its content in the Ripple UI. No tool, script or agent creates the ticket directly. | The user owns the decision to create work. Approval must be a deliberate human act on reviewed content. | Ticket creation cannot be scripted around the UI. Verification is by DevRev readback after approval. |
| P2 | Before approving, the reviewer sees the exact title, body, product part, owner, evidence count, revision and digest. | Approval must cover exactly what will be written. | The review pane renders the sealed plan, not a summary of it. |
| P3 | Approval binds to one revision (`plan_id`, `revision`, `plan_digest`, signed into UI state). | Stale or replayed controls must not approve changed content. | Any change (owner, title, body) seals a new revision. Old approve controls stop working. |
| P4 | Title and body are editable in the UI, and each save seals a new revision (`content_edits` in `RevisePlanRequest`). Limits: title 1–200 characters, body ≤ 4000. | The reviewer should fix wording without re-running the investigation. | `action_key` / `external_ref` stays stable across edits. If a ticket already exists from an earlier revision, approving an edited one gives `action_conflict`, never a duplicate. Evidence, part or split changes still need a fresh investigation. |
| P5 | Revisions expire 30 minutes after investigation (service cap). | Evidence is revalidated at approval, so an old plan should not be approvable indefinitely. | An expired review can't take owner or content changes. The UI shows **Review expired** with **Investigate again** (see challenge C7). |
| P6 | Before writing, access and sources are revalidated, and uncertain writes are reconciled, never recreated. | Duplicate tickets are worse than a delayed one. | The `ripple_actions` ledger reserves the action key before `works.create`, and its fingerprint guards content. **Check write status** reconciles. |
| P7 | Tickets are created internal only: `visibility: 1`. | The DevRev OpenAPI schema `works-create-request-ticket.visibility` is an int64 enum (1 = internal). | Reads may return `{id,label}` or strings. `native.ts` normalises every form to `1` before fingerprinting. |

### Hosting and runtime

| # | Decision | Why | Consequence |
| --- | --- | --- | --- |
| H1 | Vercel Build Output API v3, prebuilt (`npm run build:vercel`, then `vercel deploy --prebuilt --prod` **from the repo root**). Static React, plus one Node 22 function bundled with esbuild. | No framework is needed, and it gives full control over routes and bundled files. | The function bundles `imports/maple-payments/manifest.json` and `data.zip`. `sharp` is not bundled, so `/graph/*.png` is unavailable and the UI uses the SVG explorer. |
| H2 | No polling worker. `workOnce` runs inline after approve or reconcile, on `/initialize` resume, and from `/cron` (guarded by `CRON_SECRET`). | Serverless functions have no background timers. | A job interrupted mid-request resumes on the next page load or cron run. |
| H3 | The investigator is an in-process TypeScript port of the Python MCP bridge (`hosted-agent.ts`): a read-tool allowlist, SSE parsing, zip reading via `inflateRawSync`, and exact revalidation. | Vercel can't run the Python subprocess, and the app must not use a personal connector config. | The Python path remains for local modes. Both must keep the same allowlist and revalidation semantics. |
| H4 | Supabase Postgres, in a dedicated schema `ripple_hosted` with RLS on and no `anon`/`authenticated` grants. Pool max 2, TLS verified with `DATABASE_CA_CERT`. | This isolates hosted rows from local and legacy schemas, and browsers never reach the DB. | The function never migrates. The schema is applied separately (`migrations/hosted-setup.md`). |
| H5 | Access is gated by Ripple's access code (`RIPPLE_ACCESS_CODE` → HttpOnly, Secure, SameSite=Strict session cookie, 12 hours). Vercel SSO protection is disabled. | User choice: a simple shared gate for a single-user demo. | `/login` has no rate limit yet. Mutations also need `Origin` = `RIPPLE_PUBLIC_URL`. |
| H6 | Single web identity: one server-side `DEVREV_TOKEN` (DEVU-6's PAT). | User choice, for now. | All writes are attributed to DEVU-6. A multi-user version needs per-user delegated auth. The PAT was exposed in a session log and should be rotated (update the Vercel env var). |
| H7 | `?issue=<DON or ISS-n>` opens any Team01 issue. `RIPPLE_ISSUE_ID` (ISS-42) is the default. | The launcher works on any issue. | The issue is resolved and access-checked with `issueBrief`, and signed UI state is bound to that issue. |
| H8 | Credentials are server-only. Secret values are never printed, logged or bundled. | Basic hygiene: the browser bundle and logs are public surfaces. | Snap-in logs record error messages and key names only, never values. |

### Frontend

| # | Decision | Why | Consequence |
| --- | --- | --- | --- |
| F1 | The redesign was stylistic, fixing bugs and problems only, not a rewrite. | User direction. | Existing controller, snaps and signed actions are reused unchanged. |
| F2 | Evidence map, Investigation and Description became real tabs (`role=tablist/tab/tabpanel`, keyboard-navigable, active tab kept in the URL hash). Before, they were anchor links that jumped around one long page. | That page was disorienting, and the user named it as the main problem. | The review steps and record card moved into the Investigation tab. |
| F3 | The right-hand aside was replaced with a decision rail (`review-pane.tsx`): Status → Key findings with citation chips → Proposed ticket (with owner picker and content editor) → Approval → Results. | The old pane didn't add value. The rail is ordered by the decision the reviewer has to make. | The rail reads a display-only projection (`preview_review` from `review-view.ts`). All actions still go through signed controller snaps. |
| F4 | Server action errors are shown in the rail. | The controller reports failures as a "Review needed" card, and the rail used to ignore it (challenge C7). | Any failed owner, content or decision action now shows its message. |

### DevRev snap-in

| # | Decision | Why | Consequence |
| --- | --- | --- | --- |
| S1 | The snap-in is a minimal launcher card: status line plus **Open in Ripple** (and **View TKT-n** once a ticket exists). It has no review or write controls in DevRev. | User choice. Approval stays in one place, the web UI (P1). | Scopes are `issue:read` and `dev_user:read` only. |
| S2 | It works on any issue in the workspace. | User choice. | The card passes the issue DON, and Ripple checks access with the viewer's own token. |
| S3 | The card authenticates to `/native/status` with the viewer's DevRev actor session token only. Ripple verifies it via `dev-users.self` (active, same workspace) and then reads the issue with that token. | The original shared-secret proof could not work: DevRev never delivered the developer keyring (challenge C5). The user chose this over a manual keyring link. | The endpoint is read-only and returns status only, never evidence or tokens. Any active workspace member can see an issue's Ripple status, which is acceptable for a launcher. |
| S4 | Upgrade in place without `--force`. Replace the installation only when an upgrade is incompatible. | A forced upgrade deletes the installation (challenge C3). | The old installation `639fd639…` was replaced by `c27b5754…` with the user's approval. |

### Process

| # | Decision | Why |
| --- | --- | --- |
| X1 | Subagents run on Haiku (default) or Sonnet (when more reasoning is needed), never as forks. | User direction. Forks inherit the parent model and ignore model overrides. |
| X2 | Production deploys, snap-in upgrades and DevRev writes each need explicit user permission. | These are outward-facing and hard to reverse. |
| X3 | Work happens on `dev`, committed only when the user asks. | User direction. |

## Challenges and fixes

| # | Challenge | Root cause | Fix / lesson |
| --- | --- | --- | --- |
| C1 | `works.create` was changed to send `visibility: 'internal'`. | A wrong assumption about the REST enum. | Checked against `developer.devrev.ai/openapi/public.yaml`: create takes integer `1`. Reverted. **Lesson:** check DevRev field types in the OpenAPI spec, not from memory. |
| C2 | Snap-in builds failed. | The manifest `display_name` must sit under `ui:`, and DevRev expects `dist/functions/<name>/index.js` plus `dist/function-factory.js`. | `build.ts` was rewritten to produce that layout. |
| C3 | The snap-in upgrade to the launcher was rejected as incompatible. | Adding a required input and new scopes can't be done as an in-place upgrade. `upgrade --force` **deletes the installation**. | A new installation was created on the new version, and the old one was removed. **Lesson:** never use `--force` on a live installation. |
| C4 | The card showed "Ripple status unavailable" with no button. | DevRev snap-kit events carry the issue at `payload.object_id`, but the code read `payload.context.object_id`. Real event shape: `{payload:{actor_id,dev_org,object_id}, context:{secrets:{actor_session_token,service_account_token},…}, input_data:{global_values,event_sources,keyrings,resources}, execution_metadata}`. | It now reads `payload.object_id` (falling back to `payload.context.object_id`). Found by temporarily logging event **key names only**. |
| C5 | The button rendered, but the status line stayed unavailable. | The developer keyring `ripple_bridge_secret` existed, but DevRev never delivered it: `input_data.keyrings` was `null` and `resources.keyrings` was `{}`. The docs say developer keyrings are mapped when a version is created through an interactive CLI prompt. Non-interactive `snap_in_version upgrade` sends no keyring mapping (confirmed with `--debug`), and there is no flag for it. | The shared-secret proof was dropped (S3). The keyring and `RIPPLE_BRIDGE_SECRET` are now unused and can be deleted. |
| C6 | The DevRev CLI and `gh` tokens expired mid-session. | Short-lived CLI sessions. | Re-authenticate (`devrev profiles authenticate -o <org> -u <email>`, `gh auth login`). The CLI error shows as `invalid JWT token … expired`. |
| C7 | Choosing an owner showed loading, then reverted to "Choose current owner". Approve never enabled. | The review was older than 30 minutes (P5), so the owner revision failed with "Plan expired". The rail ignored the server's "Review needed" error card, and `review-view.ts` listed "choose an owner" ahead of "expired". | `review-view` now exposes `expired` and puts it first in `blocked_reason`. The rail shows **Review expired** plus **Investigate again**, hides the owner, edit and approve controls, and displays server errors. |
| C8 | macOS has no `timeout` command, so wrapped `vercel logs` calls failed silently. | GNU coreutils is not installed. | Use the tool's own timeout instead. `vercel logs` also needs `--project ripple` when run outside the linked root. |
| C9 | A subagent printed the DevRev PAT while inspecting a local config file. | It read a config file that contains the credential. | The user chose to keep using the PAT, so rotation is pending (H6). **Lesson:** never cat credential files. Check key presence with redaction. |

## Open items

- Rotate the DevRev PAT and update `DEVREV_TOKEN` in Vercel.
- Delete the unused `RIPPLE_BRIDGE_SECRET` env var, the `ripple_bridge_secret` developer keyring, and the failed snap-in version `41ae608c`.
- Add a rate limit on `/login`.
- Automated browser and visual checks: UI checks so far are manual.
- Multi-user: per-user delegated DevRev auth, a second-user acceptance pass, and native assignment-role checks.
- Long investigations: the request currently waits about 20 seconds inline. If it approaches the function limit, move to an asynchronous job with polling.
