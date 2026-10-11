import { z } from 'zod';

// Canonical wire contract. All fields are required; unavailable values are null.
export const VERSION = '1.0' as const;
const Version = z.literal(VERSION);
const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
const Text = z.string().trim().min(1).max(4000);
const Don = z.string().regex(/^don:[A-Za-z0-9_:/.-]+$/).max(512);
const UserDon = z.string().regex(/^don:identity:[A-Za-z0-9_./:-]+:devu\/[A-Za-z0-9_.-]+$/).max(512);
const Timestamp = z.iso.datetime({ offset: true });
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Refs = z.array(Id).max(50);
const CitedRefs = Refs.min(1);

export const NativeObjectSchema = z.strictObject({
  id: Don,
  display_id: z.string().min(1).max(120),
  url: z.url({ protocol: /^https$/ }).nullable(), // Verified URL only; otherwise null.
});
export const EntitySchema = z.strictObject({
  entity_id: Id,
  kind: z.enum(['issue', 'ticket', 'part', 'account', 'opportunity', 'article', 'person']),
  label: Text,
  native: NativeObjectSchema.nullable(),
  source_ref: z.strictObject({ record_id: Text, path: Text }).nullable(),
});
export const EvidenceSchema = z.strictObject({
  evidence_id: Id,
  entity_id: Id,
  source_ref: z.strictObject({
    dataset_id: z.literal('enterprise-bench/maple-payments'),
    path: Text,
    record_id: Text,
    content_sha256: Digest,
  }),
  original_event_at: Timestamp.nullable(),
  retrieved_at: Timestamp,
  source_owner: z.strictObject({
    person_id: Text.nullable(),
    name: Text.nullable(),
    resolution: z.enum(['resolved', 'missing', 'conflicting']),
  }),
  visibility: z.literal('internal'),
  coverage: z.enum(['native_imported', 'archive_only']),
  excerpt: z.strictObject({
    text: z.string().min(1).max(12000),
    field_path: Text,
    start: z.int().nonnegative(),
    end: z.int().positive(),
    units: z.literal('unicode_code_points'), // Zero-based, end exclusive; no normalization.
  }),
});
export const ContextBundleSchema = z.strictObject({
  entities: z.array(EntitySchema).max(60),
  evidence: z.array(EvidenceSchema).max(40),
  claims: z.array(z.strictObject({
    claim_id: Id,
    kind: z.enum(['fact', 'inference']),
    statement: Text,
    evidence_ids: CitedRefs,
  })).max(40),
  relationships: z.array(z.strictObject({
    relationship_id: Id,
    from_entity_id: Id,
    to_entity_id: Id,
    kind: z.enum(['applies_to_part', 'reported_by_account', 'documented_relation', 'candidate_relation']),
    basis: z.enum(['native_link', 'source_record', 'inference']),
    statement: Text,
    evidence_ids: CitedRefs,
  })).max(80),
  gaps: z.array(z.strictObject({
    gap_id: Id,
    question: Text,
    why_it_matters: Text,
    blocks: z.enum(['investigation', 'execution', 'production_change', 'none']),
    next_step: Text,
  })).max(20),
  coverage: z.strictObject({
    dataset_id: z.literal('enterprise-bench/maple-payments'),
    archive_sha256: Digest,
    retrieval_scope: z.enum(['imported_only', 'imported_and_archive']),
    limitations: z.array(Text).max(20),
  }),
});
export const TaskSchema = z.strictObject({
  action_id: Id,
  action_key: z.string().min(1).max(240), // Stable incident + purpose, not a random run ID.
  operation: z.literal('create_issue'), // v1 does not send messages or change production.
  title: z.string().trim().min(1).max(200),
  body_markdown: Text,
  priority: z.enum(['p0', 'p1', 'p2', 'p3']),
  part_entity_id: Id,
  owner_id: UserDon.nullable(), // Current authorized DevRev user; never a source USER-* ID.
  context_entity_ids: Refs,
  evidence_ids: CitedRefs,
  acceptance_checks: z.array(Text).min(1).max(10),
});
export const ActionGraphSchema = z.strictObject({
  plan_id: z.uuid(),
  revision: z.int().positive(),
  plan_digest: Digest,
  expires_at: Timestamp,
  existing_work_entity_ids: Refs,
  actions: z.array(TaskSchema).min(1).max(8),
  dependencies: z.array(z.strictObject({
    prerequisite_action_id: Id,
    dependent_action_id: Id,
    reason: Text,
  })).max(30), // Investigation order, not necessarily the order of task creation.
});
export const InvestigationRequestSchema = z.strictObject({
  schema_version: Version,
  request_id: z.uuid(),
  outcome: z.string().trim().min(1).max(2000),
  constraints: z.array(Text).max(12),
  reference_time: Timestamp.nullable(), // null: server resolves its current time explicitly.
  scope_hints: z.strictObject({
    part_ids: z.array(Don).max(10),
    account_ids: z.array(Don).max(10),
    starting_object: NativeObjectSchema.nullable(),
  }),
});
export const InvestigationResponseShape = z.strictObject({
  schema_version: Version,
  request_id: z.uuid(),
  investigation_id: z.uuid(),
  generated_at: Timestamp,
  status: z.enum(['needs_input', 'review_required', 'no_action']),
  outcome: z.strictObject({
    statement: Text,
    success_criteria: z.array(Text).min(1).max(12),
    constraints: z.array(Text).max(12),
    reference_time: Timestamp,
  }),
  summary: Text,
  questions: z.array(Text).max(5),
  context_bundle: ContextBundleSchema,
  action_graph: ActionGraphSchema.nullable(),
});
export type InvestigationRequest = z.infer<typeof InvestigationRequestSchema>;
export type InvestigationResponse = z.infer<typeof InvestigationResponseShape>;
export type ContextBundle = z.infer<typeof ContextBundleSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type ActionGraph = z.infer<typeof ActionGraphSchema>;

// Boundary checks also enforce cross-references and graph semantics, beyond JSON Schema.
export const InvestigationResponseSchema = InvestigationResponseShape.superRefine((r, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  const unique = (ids: string[], label: string) => {
    if (new Set(ids).size !== ids.length) fail(`Duplicate ${label}`);
  };
  const c = r.context_bundle;
  unique(c.entities.map(x => x.entity_id), 'entity IDs');
  unique(c.evidence.map(x => x.evidence_id), 'evidence IDs');
  unique(c.claims.map(x => x.claim_id), 'claim IDs');
  unique(c.relationships.map(x => x.relationship_id), 'relationship IDs');
  unique(c.gaps.map(x => x.gap_id), 'gap IDs');
  const entities = new Map(c.entities.map(e => [e.entity_id, e]));
  const evidence = new Set(c.evidence.map(e => e.evidence_id));
  const cite = (ids: string[]) => { for (const id of ids) if (!evidence.has(id)) fail(`Unknown evidence: ${id}`); };
  for (const e of c.evidence) {
    const entity = entities.get(e.entity_id);
    if (!entity) fail(`Unknown evidence entity: ${e.entity_id}`);
    if (e.coverage === 'native_imported' && !entity?.native) fail('Native evidence needs a verified native object');
    if (e.coverage === 'archive_only' && c.coverage.retrieval_scope === 'imported_only') fail('Undeclared archive-only evidence');
    if (e.excerpt.end - e.excerpt.start !== Array.from(e.excerpt.text).length) fail('Excerpt offsets do not match its text length');
    if (e.source_owner.resolution === 'resolved' && (!e.source_owner.person_id || !e.source_owner.name)) fail('Resolved source owner needs ID and name');
    if (entity?.source_ref && (entity.source_ref.record_id !== e.source_ref.record_id || entity.source_ref.path !== e.source_ref.path)) fail('Evidence source does not match its entity');
  }
  c.claims.forEach(x => cite(x.evidence_ids));
  for (const rel of c.relationships) {
    if (!entities.has(rel.from_entity_id) || !entities.has(rel.to_entity_id)) fail('Unknown relationship entity');
    if ((rel.kind === 'candidate_relation') !== (rel.basis === 'inference')) fail('Candidate relationships must be labeled as inference');
    cite(rel.evidence_ids);
  }
  if ((r.status === 'review_required') !== Boolean(r.action_graph)) fail('Only review_required responses contain an action graph');
  if ((r.status === 'needs_input') !== Boolean(r.questions.length)) fail('Questions are required only for needs_input');
  if (!r.action_graph) return;
  const g = r.action_graph;
  unique(g.actions.map(x => x.action_id), 'action IDs');
  unique(g.actions.map(x => x.action_key), 'action keys');
  const actions = new Set(g.actions.map(x => x.action_id));
  for (const id of g.existing_work_entity_ids) {
    const e = entities.get(id);
    if (!e?.native || !['issue', 'ticket'].includes(e.kind)) fail('Existing work must resolve to a native issue or ticket');
  }
  for (const action of g.actions) {
    const part = entities.get(action.part_entity_id);
    if (part?.kind !== 'part' || !part.native) fail('Every task needs a verified native product part');
    action.context_entity_ids.forEach(id => { if (!entities.has(id)) fail(`Unknown action context: ${id}`); });
    cite(action.evidence_ids);
  }
  const adjacency = new Map<string, string[]>();
  unique(g.dependencies.map(d => `${d.prerequisite_action_id}/${d.dependent_action_id}`), 'dependencies');
  for (const d of g.dependencies) {
    if (!actions.has(d.prerequisite_action_id) || !actions.has(d.dependent_action_id)) fail('Unknown dependency action');
    const next = adjacency.get(d.prerequisite_action_id) ?? [];
    next.push(d.dependent_action_id); adjacency.set(d.prerequisite_action_id, next);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) if (!visit(next)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  if (g.actions.some(a => !visit(a.action_id))) fail('Action dependencies must be acyclic');
});
export const RevisePlanRequestSchema = z.strictObject({
  schema_version: Version,
  plan_id: z.uuid(),
  expected_revision: z.int().positive(),
  owner_assignments: z.array(z.strictObject({ action_id: Id, owner_id: UserDon })).min(1).max(8),
}).superRefine((r, ctx) => {
  if (new Set(r.owner_assignments.map(x => x.action_id)).size !== r.owner_assignments.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate owner assignments' });
});
export const PlanDecisionRequestSchema = z.strictObject({
  schema_version: Version,
  plan_id: z.uuid(),
  expected_revision: z.int().positive(),
  plan_digest: Digest,
  decision: z.enum(['approve', 'reject']),
  idempotency_key: z.uuid(),
});
export type RevisePlanRequest = z.infer<typeof RevisePlanRequestSchema>;
export type PlanDecisionRequest = z.infer<typeof PlanDecisionRequestSchema>;

export const FailureSchema = z.strictObject({
  code: z.enum(['invalid_request', 'not_found', 'permission_denied', 'stale_plan', 'expired_plan', 'evidence_changed', 'missing_owner', 'blocked', 'rate_limited', 'create_failed', 'ambiguous_write', 'invalid_response', 'idempotency_conflict', 'action_conflict']),
  message: Text,
  retry: z.enum(['safe', 'reconcile_first', 'never']),
});
export const OperationErrorSchema = z.strictObject({
  schema_version: Version,
  operation: z.enum(['investigate', 'revise_plan', 'decide_plan']),
  request_id: z.uuid().nullable(),
  plan_id: z.uuid().nullable(),
  error: FailureSchema,
});
export type OperationError = z.infer<typeof OperationErrorSchema>;
export const ExecutionResultShape = z.strictObject({
  schema_version: Version,
  investigation_id: z.uuid(),
  plan_id: z.uuid(),
  revision: z.int().positive(),
  plan_digest: Digest,
  idempotency_key: z.uuid(),
  approval: z.strictObject({
    approval_id: z.uuid(),
    actor_id: UserDon, // Server records this from authentication; never from the client request.
    recorded_at: Timestamp,
    plan_digest: Digest,
  }).nullable(),
  status: z.enum(['rejected', 'completed', 'partial', 'failed', 'blocked']),
  results: z.array(z.strictObject({
    action_id: Id,
    action_key: z.string().min(1).max(240),
    status: z.enum(['created', 'reused', 'failed', 'uncertain', 'not_attempted']),
    native: NativeObjectSchema.nullable(),
    error: FailureSchema.nullable(),
  })).max(8),
  error: FailureSchema.nullable(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultShape>;
export const ExecutionResultSchema = ExecutionResultShape.superRefine((r, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new Set(r.results.map(x => x.action_id)).size !== r.results.length) fail('Duplicate execution action IDs');
  if (new Set(r.results.map(x => x.action_key)).size !== r.results.length) fail('Duplicate execution action keys');
  const success = r.results.filter(x => ['created', 'reused'].includes(x.status)).length;
  const outputs = r.results.flatMap(x => x.native ? [x.native.id] : []);
  if (new Set(outputs).size !== outputs.length) fail('Different actions need distinct native work objects');
  if (r.status === 'rejected' && (r.approval || r.results.length || r.error)) fail('A rejected plan has no approval or execution attempts');
  if (r.status !== 'rejected' && !r.approval && r.status !== 'blocked') fail('Execution needs a server-issued approval receipt');
  if (!r.approval && r.results.length) fail('Without an approval receipt no action can be attempted');
  if (r.approval && r.approval.plan_digest !== r.plan_digest) fail('Approval digest mismatch');
  if (r.status === 'completed' && (!r.results.length || success !== r.results.length || r.error)) fail('Completed means all actions succeeded');
  if (r.status === 'partial' && (!success || success === r.results.length)) fail('Partial means mixed action outcomes');
  if (['failed', 'blocked'].includes(r.status) && (success || !r.error)) fail('Failed/blocked needs a reason and no successful actions');
  for (const item of r.results) {
    const ok = ['created', 'reused'].includes(item.status);
    if (ok !== Boolean(item.native) || ok === Boolean(item.error)) fail('Native IDs exist only for successful actions; other outcomes need errors');
    if (item.native && !/:issue\/[^/]+$/.test(item.native.id)) fail('v1 task outputs must be native issues');
    if (item.status === 'uncertain' && item.error?.retry !== 'reconcile_first') fail('Uncertain writes require reconciliation');
  }
});

// Logical operation schemas; these names are not installed DevRev MCP endpoints.
export const ContractSchemas = {
  investigation_request: InvestigationRequestSchema,
  investigation_response: InvestigationResponseShape,
  revise_plan_request: RevisePlanRequestSchema,
  plan_decision_request: PlanDecisionRequestSchema,
  execution_result: ExecutionResultShape,
  operation_error: OperationErrorSchema,
};
