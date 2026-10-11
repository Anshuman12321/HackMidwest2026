# Ripple investigation contract v1

This is the shared boundary between the investigation agent, the review UI, and the DevRev executor. It is implemented as strict Zod schemas with inferred TypeScript types in [investigation.ts](investigation.ts). Both developers import those definitions. The agent returns JSON that must pass validation before the UI displays a plan.

The first vertical workflow starts with **“Restore Brazil subscription renewals without double billing.”** Its evidence comes from the imported Maple Payments dataset. The contract and examples are ready; the agent, authenticated handlers, durable execution ledger, and live UI still need implementation. These files do not create DevRev work.

## Three operations

These are application operation names, not installed DevRev MCP tools or deployed routes. The same messages can pass through snap-in events, a service, or a custom MCP adapter.

| Operation | Request | Success response | Effect |
|---|---|---|---|
| `investigate` | `InvestigationRequest` | `InvestigationResponse` | Retrieve evidence and store a proposed plan; no work writes |
| `revise_plan` | `RevisePlanRequest` | Full new `InvestigationResponse` | Assign current owners, increment revision, compute a new digest; no work writes |
| `decide_plan` | `PlanDecisionRequest` | `ExecutionResult` | Reject with zero writes, or execute the approved task batch |

Each operation can return `OperationError` instead of a success response. It contains `schema_version`, `operation`, nullable `request_id` and `plan_id`, plus `error: { code, message, retry }`. Retry is `safe`, `reconcile_first`, or `never`. An unchanged request with a stale plan is not retryable: obtain a new preview. A timed-out write needs reconciliation before another create.

## Exact data layers

| Layer | Required fields and meaning |
|---|---|
| Outcome request | `schema_version`, `request_id`, `outcome`, `constraints`, `reference_time`, `scope_hints` |
| Scope hints | Native `part_ids`, native `account_ids`, nullable `starting_object`. Empty hints are valid; the agent resolves scope from the outcome. |
| Investigation response | `schema_version`, `request_id`, `investigation_id`, `generated_at`, `status`, `outcome`, `summary`, `questions`, `context_bundle`, nullable `action_graph` |
| Resolved outcome | `statement`, `success_criteria`, `constraints`, explicit `reference_time` |
| Context Bundle | `entities`, `evidence`, `claims`, `relationships`, `gaps`, `coverage` |
| Action Graph | `plan_id`, `revision`, `plan_digest`, `expires_at`, `existing_work_entity_ids`, `actions`, `dependencies` |
| Execution result | Investigation/plan IDs, `revision`, `plan_digest`, `idempotency_key`, nullable server `approval`, `status`, per-action `results`, nullable overall `error` |

`schema_version` is exactly `"1.0"`. All fields are required; use `null` for an unavailable nullable value and `[]` for an empty collection. Unknown fields are rejected. UUIDs identify requests, investigations, plans, approval receipts, and decision attempts. Timestamps use RFC 3339 with a timezone. The canonical file specifies every bound and enum.

The response states are `needs_input`, `review_required`, and `no_action`. Only `needs_input` contains questions; only `review_required` contains an Action Graph. Loading state and UI layout belong to the UI, not to this response.

### Entities, evidence, and claims

An entity has `entity_id`, `kind`, `label`, nullable `native`, and nullable `source_ref`. Kinds are issue, ticket, part, account, opportunity, article, or person. A native object has **DON `id`**, human `display_id`, and verified HTTPS `url` or `null`.

Keep three identity spaces separate:

| Identity | Example | Use |
|---|---|---|
| Local graph ID | `entity-iss-031`, `evidence-iss-031`, `task-replay` | References within this response |
| Benchmark ID | `ISS-031`, `TKT-124`, `PART-003`, `USER-*` | Source joins and historical provenance |
| Native DevRev ID | DON for `ISS-42`, `TKT-50`, `CAPL-4`, `DEVU-6` | Native reads, assignment, and writes |

An evidence item has `evidence_id`, `entity_id`, `source_ref`, `original_event_at`, `retrieved_at`, `source_owner`, `visibility`, `coverage`, and `excerpt`.

- `source_ref`: `dataset_id`, archive `path`, source `record_id`, and `content_sha256` for the complete original source row. V1 uses dataset `enterprise-bench/maple-payments`.
- `excerpt`: exact `text`, `field_path`, zero-based `start`, exclusive `end`, and `units: "unicode_code_points"`. Do not normalize text. `original_record.description` means the imported original-record wrapper; for an archive row, resolve the field after that prefix. For a non-string field, cite its canonical JSON representation.
- `source_owner`: original `person_id`, `name`, and resolution `resolved`, `missing`, or `conflicting`. This does not authorize assignment. The example deliberately leaves source owners unresolved.
- `coverage`: `native_imported` or `archive_only`. Native evidence requires a mapped native entity. Bundle coverage records the archive checksum, retrieval scope, and limitations. Archive-only evidence cannot appear under `imported_only`.

Dates have separate meanings: the March source event, October native import, retrieval time, and investigation reference time are not interchangeable. A null request reference time asks the server to resolve its current time; the response records the resolved value. A historical reference time scopes the question; it does not prove the source snapshot existed then. An as-of investigation must also filter records by source dates.

A claim has `claim_id`, `kind: "fact" | "inference"`, `statement`, and nonempty `evidence_ids`. A fact can state **what an issue says**; it cannot turn that diagnosis into independently observed runtime behavior. Missing information is a gap with `gap_id`, `question`, `why_it_matters`, `blocks`, and `next_step`. No synthetic confidence score is required.

A relationship has local endpoints, `kind`, `basis`, `statement`, and citations. A `candidate_relation` must have basis `inference`; other relationships use `native_link` or `source_record`. Shared subscription membership supports investigation context, not a proven shared payment worker.

V1 includes at most 60 entities, 40 evidence items, 40 claims, 80 relationships, 20 gaps, and 8 actions. Retrieve narrowly rather than send the entire imported dataset. Additional connectors will need a reviewed source-reference extension; do not label Slack or GitHub content as benchmark evidence. Opportunity values remain source evidence in v1, not a new normalized financial model; preserve original currencies and account joins.

### Tasks and dependencies

Every task has:

```typescript
{
  action_id, action_key, operation: "create_issue",
  title, body_markdown, priority, part_entity_id, owner_id,
  context_entity_ids, evidence_ids, acceptance_checks
}
```

`action_key` is stable per incident and task purpose, for example `ripple/maple/ISS-031/replay-safety`. It survives reruns. `part_entity_id` must resolve to a native product part. `owner_id` is a current native DevRev user DON or `null` during preview. All tasks need owners before approval. Historical source users and the importer are not automatically the right owners.

Dependencies have `prerequisite_action_id`, `dependent_action_id`, and `reason`. They form an acyclic investigation order. V1's execution result covers issue creation/reuse only; native linking is a later write operation with its own approval and result reporting. The UI must not claim native dependency links were created by v1.

The example reuses `ISS-42` as incident context and proposes three new checks: scheduler behavior, replay safety, and customer update drafts. It does not duplicate the incident. No outbound messages or production changes are in this contract.

### Review and execution

The UI sends owner edits as `{ schema_version, plan_id, expected_revision, owner_assignments: [{ action_id, owner_id }] }`. V1 permits owner edits only. Other task/evidence changes require a new generated preview. Do not silently merge a stale revision.

The decision request is:

```typescript
{
  schema_version: "1.0",
  plan_id,
  expected_revision,
  plan_digest,
  decision: "approve" | "reject",
  idempotency_key
}
```

The client sends no actor, organization, token, approval receipt, or `approved: true` flag. The handler loads the authoritative stored plan and derives the actor and workspace from authentication. It checks current access to every source, target part, and selected owner before writes. A DON that passes the schema is still not proof of existence or permission.

`plan_digest` is SHA-256 of the UTF-8 canonical JSON returned by `reviewSnapshot` in [review.server.ts](review.server.ts). Object keys are sorted, arrays retain order, and there is no whitespace. The snapshot includes schema version, investigation ID, resolved outcome, summary, complete Context Bundle, and complete Action Graph except its own `plan_digest`. Outer request ID, generated time, status, and questions are excluded; response-state validation still applies. Source row hashes use the same canonical JSON function. This is a defined v1 format, not a claim of general RFC 8785 compliance.

Owner edits increment the revision and change the digest. They retain the original expiry. Approval requires the exact ID, revision, digest, unexpired plan, assigned owners, and no gap that blocks `investigation` or `execution`. A `production_change` gap still permits these investigation tasks. Rejection needs no owners and can occur after expiry, but still must match the current stored plan.

Store plans, approval receipts, and execution records durably. Atomic compare-and-set on the stored revision must protect both edits and approval. After approval begins execution, lock that revision; return its recorded result for repeats. Pure functions in this folder do not supply storage, authentication, authorization, or transaction guarantees.

Use two duplicate checks:

1. Decision attempt: scope `idempotency_key` to workspace and plan. The same key with different request content is `idempotency_conflict`. A repeated identical request returns its recorded result.
2. Task: scope stable `action_key` to workspace. Record intent before create and native ID after create; reconcile timeouts by `external_ref`. A reused task must match its recorded approved content. If a changed plan would reuse an incompatible task, return `action_conflict` and request review. Do not silently overwrite it.

Approval receipts contain `approval_id`, authenticated `actor_id`, `recorded_at`, and the approved `plan_digest`. Execution statuses are `rejected`, `completed`, `partial`, `failed`, or `blocked`. Each action result has its IDs/key, status `created`, `reused`, `failed`, `uncertain`, or `not_attempted`, nullable native object, and nullable error. `uncertain` always requires reconciliation. Report every planned action after a batch attempt, including those not attempted. A pre-attempt blocked result can have no rows. Rejection has no approval receipt, attempts, or error.

Runtime schemas check internal references and state rules. `assertDecisionMatches`, `applyOwnerAssignments`, and `assertExecutionMatches` add cross-message checks, including complete batch coverage and decision-key matching. Call them at the server boundary. The JSON Schema bundle describes structural shapes; it cannot replace these semantic checks.

## DevRev MCP mapping confirmed on 10 October 2026

Read-only `discover_schema()` followed by `discover_schema(action_name="create_issue")` confirmed these actual create fields:

| Contract | Native create input |
|---|---|
| `title` | `title` |
| `body_markdown` | `body`; agent must include the reviewed checks and citation references in this text |
| Resolved `part_entity_id` | `applies_to_part`: native part DON |
| `owner_id` | `owned_by: [owner_id]` |
| `priority` | `priority_v2`: p0→1, p1→2, p2→3, p3→4 under the discovered stock enum |
| `action_key` | `external_ref`, documented as unique within the work type |

Required fields are `title`, `applies_to_part`, and `owned_by`. Leave stage and unrelated optional fields out of v1 unless a workspace-required default needs explicit review. Discover the schema in the runtime connection before using these mappings; tenant custom fields and enums can differ. A uniqueness guarantee helps reconciliation but does not replace a durable ledger.

`link_issue_with_issue` also exists, with `source`, `target`, and link types `is_parent_of`, `is_dependent_on`, and `is_duplicate_of`. We did not call create or link actions. Adding native dependency writes requires extending the plan and execution result so link failures are visible.

## Files and use

| File | Purpose |
|---|---|
| [investigation.ts](investigation.ts) | Shared runtime schemas and inferred TypeScript types |
| [review.server.ts](review.server.ts) | Server-only digest, revision, approval-match, and result-match guards |
| [investigation.schema.json](investigation.schema.json) | Six named JSON Schema documents, draft 2020-12 |
| [examples/investigation-response.json](examples/investigation-response.json) | Full cited context and initial unassigned task plan |
| [examples/revised-investigation-response.json](examples/revised-investigation-response.json) | Same plan with example current owner assignments and revision 2 |
| [examples/](examples/) | Requests, rejection result, error, and fixture provenance manifest |
| [investigation.test.ts](investigation.test.ts) | Contract, citation, stale approval, and partial-write checks |

```sh
cd contracts
npm ci
npm run check
npm test
npm run build:examples
```

Use Node 24 or later. Example regeneration also uses Python 3's standard library to read the existing archive. It checks the archive checksum and description excerpts, resolves native IDs from the import manifest, and makes no remote calls. Examples use fixed historical/reference times, a captured snapshot, illustrative UUIDs, and a fixed expiry; a live handler must generate new IDs/times and retrieve fresh evidence. Assigned owners are examples, not an approval. Mock successful writes exist only in the unit tests; no new task IDs are invented in the protocol examples.

This is a private source package. Frontend/backend builds can import the TypeScript schemas; do not publish raw TypeScript as a Node `node_modules` dependency without a compilation plan. Keep Node crypto imports in the server file. Breaking field changes require a schema version change and updated fixtures. Add the shared checks to both developers' CI before changing the contract.

## Two-person ownership

- Agent developer: normalization, permitted retrieval, source dates/owners, citations, claims/gaps, and a valid `InvestigationResponse`.
- UI/executor developer: display that response, resolve current owners, submit revision/decision requests, implement authenticated storage/approval/ledger, map approved actions to native tools, and return validated results.

Both use the same example response to build in parallel. First acceptance: a fresh user session retrieves the real four records, shows the reviewed checks, approves revision 2, and receives native task IDs. The denied and repeated-approval paths must produce zero extra work.
