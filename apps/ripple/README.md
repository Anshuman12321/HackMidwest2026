# Ripple issue brief

The implementation renders native Snap-kit cards on an issue, accepts a validated v2 investigation, saves owner revisions, and executes an approved batch as internal DevRev tickets. Brazil creates one ticket containing scheduler investigation, replay-safety checks, and customer-update drafts. The separate-work fixture contains three tickets.

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

The white cards, compact actions, graph selection and yellow graph highlighting follow the three HTML references. Native DevRev controls inherit platform styling. This local renderer approximates that styling; it does not verify native component rendering.

## Deployment

1. Provide PostgreSQL and an HTTPS service origin. Copy `.env.example` to an ignored local configuration file and replace placeholders. Generate a new random `RIPPLE_SECRET`; keep it stable across worker restarts. Use a protected secret manager in deployment. Run `node --env-file=apps/ripple/.env apps/ripple/src/migrate.ts`, then `node --env-file=apps/ripple/.env apps/ripple/src/main.ts`. Migrations are idempotent. The service starts a durable polling worker; multiple instances claim jobs using PostgreSQL row locks and leases. The Dockerfile builds from the repository root; put an HTTPS reverse proxy in front of it.
2. Supply an actor-delegated DevRev MCP endpoint and the agent interfaces below. A chat connector session or a developer PAT is not a deployment credential. Production startup requires the MCP URL and agent URL; fixture adapters are never a production fallback. Owner search discovers `hybrid_search`, first discovers available actions and actual create/lookup schemas, and stops if required ticket fields differ. It explicitly includes authenticated self, then verifies candidates against current native records and the installation's assignment policy.
3. Set `RIPPLE_ACTOR_IDS` and `RIPPLE_ASSIGNABLE_OWNER_IDS` to the administrator-reviewed allowed actor and owner DONs for this installation. These narrow the native actor's authority; they do not grant native permissions. The first slice restricts plan access to its creating actor. Native source reads and active-owner checks run at review, approval and execution. DevRev enforces ticket-write/assignment permissions using the delegated actor token. The current connector exposes no reliable dry-run assignment-permission endpoint; verify that policy with actual native roles before enabling approval in Team01.
4. Create a developer **Snap-in Secret** keyring named `ripple_bridge_secret` with the same secret as `RIPPLE_SECRET`. Configure `ripple_service_url` to the HTTPS origin. Build the package with `npm run build:snap-in`; install `snap-in/manifest.yaml` and `snap-in/build.tar.gz` using the documented DevRev snap-in version/install flow. The package exports the official `functionFactory` shape and two user-triggered functions. It forwards only the platform actor-session token and issue context, signs the bridge request, and returns `snap_kit_body.body.snaps`. No timeline entries are used to emulate the component.
5. In Team01, verify installation rights, requested scope names against the current API-to-scope reference, initializer context, issue surface rendering on ISS-42, native owner-picker/form payloads, approval disabling while an owner revision is pending, and image fetching from the scoped HTTPS URL. Inspect grants using a fresh second-user session: that user cannot read the first user's plan, may create their own review if enabled, and cannot approve a copied signed control. Scope/actor-context behavior and rendering are rollout gates, not assertions from the local preview.

This checkout has no configured hosted agent/service/PostgreSQL instance or DevRev CLI. The package is built locally; it has not been installed in Team01, and a real ticket creation or second-user browser test has not been performed. No live business work was created by implementation checks.

## Agent boundary

The shared source of truth is `contracts/investigation.ts` with exact version `2.0`. The agent developer supplies two authenticated HTTP endpoints under `AGENT_URL`; the service sends `Authorization: Bearer AGENT_BEARER` and JSON:

```typescript
{ payload: InvestigationRequest | InvestigationResponse,
  context: { workspace: string, actor_id: string, actor_session_token: string } }
```

- `POST /investigate` returns a complete validated `InvestigationResponse`. It must retain the request ID, outcome, constraints, reference date when supplied, and include the native starting issue in its Context Bundle. The agent owns retrieval, evidence validation, gaps, and decomposition into up to eight internal tickets. A null reference date asks the agent to resolve the investigation's date; the Brazil fixture deliberately chooses March 24, 2026 and is labelled as a replay.
- `POST /revalidate` receives the complete sealed response after authoritative IDs, owner edits and digest changes. Return `{ valid: true, investigation_id, plan_digest }`, where `plan_digest` is the supplied graph digest or `null` for a response with no graph. Verify access, exact excerpts/hashes and current evidence freshness; do not just echo the digest. On changed evidence return `{ valid: false, code: "evidence_changed" }`; use `permission_denied` for revoked access. The service blocks approval/execution on either. Credentials stay between trusted servers and are never included in UI state.

The service owns plan IDs, canonical sealing, original expiry (capped at 30 minutes), owner revisions, decisions and execution. Content or split changes start a fresh investigation. The bridge permits 90 seconds and the agent request 60 seconds; if real investigations exceed this, add an asynchronous investigation job and polling state before rollout. Approval execution is already asynchronous.

## Durable decisions and writes

`ripple_plans` scopes complete responses by workspace and creating actor. Revisions and decisions lock the plan row. Approval atomically stores a server-issued receipt, exact decision request/hash, and worker job. Rejection has no receipt/job and creates zero work. The UI signs workspace, actor, issue, revision and digest; it never supplies approval authority. Unsaved owner edits keep the old digest, so stale controls cannot approve a new revision.

`ripple_actions` uniquely reserves workspace/action key **before** `works.create`. Its fingerprint covers the exact reviewed native title, body, part, one owner, internal visibility `1`, and `external_ref`. Native lookup uses that reference and reuses only an exact match. Incompatible objects are never overwritten. Identical decision repeats return stored state; reused keys with changed content conflict.

The worker encrypts the delegated actor token at rest and clears it after finishing. A crash after durable intent, timeout, conflict response, failed readback, or lost result commit remains uncertain. Even repeated absence from lookup cannot authorize a create. **Check write status** only reconciles uncertain writes; confirmed terminal failures need a fresh review. Successful rows remain visible in partial batches and when later evidence revalidation blocks reconciliation. Configure encrypted database backups, restricted database roles, retention and key rotation for your deployment.

Graph PNGs are deterministic from validated data. Their signed URLs carry workspace/actor/plan/digest/view and expire after five minutes; stale revisions are denied. URLs are bearer grants, so proxy logs must redact the path. Responses use `no-store` and `no-referrer`. Revocation can take up to the existing grant's five-minute lifetime; refreshing the component rechecks access. The accessible relationship list and selectors expose citations separately from the image.

Native ticket creation is the sole approved work operation. Severity/stage, native dependency links, timeline summaries, customer messaging and production settings are not written.

## Validation coverage

Tests include the 19 preserved v1 checks, v2 single/multiple-ticket fixtures and semantic guards, PostgreSQL-schema integration workflows, concurrent revision/decision conflicts, no-write rejection/expiry/access/evidence failures, crash and timeout fencing, partial results, graph PNG generation and grants, native adapter readback, and actor-context bridge signing. PGlite runs the same migration/SQL locally; deployment still needs real PostgreSQL multi-process and fresh-session DevRev acceptance tests.

Official integration references: [Snap Components](https://developer.devrev.ai/snapin-development/references/snap-components), [Snap-kit](https://developer.devrev.ai/snapin-development/references/snapkit), [Function invocation](https://developer.devrev.ai/snapin-development/references/function-invocation), [Manifest](https://developer.devrev.ai/snapin-development/references/manifest), [Scopes](https://developer.devrev.ai/snapin-development/references/scopes), [API-to-scope reference](https://developer.devrev.ai/snapin-development/references/scope-reference), [official function factory](https://github.com/devrev/snap-in-examples/blob/main/1-starter/code/src/function-factory.ts).
