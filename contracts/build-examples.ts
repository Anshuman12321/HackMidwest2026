import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import {
  ContractSchemas, InvestigationRequestSchema, InvestigationResponseSchema,
  RevisePlanRequestSchema, PlanDecisionRequestSchema, ExecutionResultSchema, OperationErrorSchema,
  type InvestigationResponse, VERSION,
} from './investigation.ts';
import { canonicalJson, sealPlan } from './review.server.ts';

// Source-derived evidence; proposed tasks and protocol UUIDs are illustrative.
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const snapshot = read('../sites/ripple-demo/dist/snapshot.json');
const manifest = read('../imports/maple-payments/manifest.json');
const inventory = read('../imports/maple-payments/inventory.json');
const archivePath = new URL('../imports/maple-payments/data.zip', import.meta.url);
if (createHash('sha256').update(readFileSync(archivePath)).digest('hex') !== manifest.archive_sha256)
  throw new Error('Archive checksum differs from the imported dataset');
const out = new URL('./examples/', import.meta.url);
mkdirSync(out, { recursive: true });
const write = (name: string, value: unknown) => writeFileSync(new URL(name, out), JSON.stringify(value, null, 2) + '\n');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const native = (family: string, key: string) => ({ ...manifest[family][key], url: null });
const request = InvestigationRequestSchema.parse({
  schema_version: VERSION, request_id: id(1),
  outcome: 'Restore Brazil subscription renewals without double billing',
  constraints: ['Do not change production settings', 'Keep customer updates as drafts'],
  reference_time: '2026-03-24T10:00:00Z',
  scope_hints: { part_ids: [], account_ids: [], starting_object: null },
});
const sourceRows = JSON.parse(execFileSync('python3', ['-c', `
import json,sys,zipfile
z=zipfile.ZipFile(sys.argv[1]); result={}
for path,field,keys in [('pm_json_data/issues.json','issue_id',['ISS-031']),('crm_json_data/tickets.json','ticket_id',['TKT-124','TKT-125','TKT-126'])]:
 for row in json.loads(z.read(path)):
  if row[field] in keys: result[row[field]]=row
print(json.dumps(result))
`, archivePath.pathname], { encoding: 'utf8' }));
const recordHash = (key: string) => createHash('sha256').update(canonicalJson(sourceRows[key]), 'utf8').digest('hex');
const workEvidence = snapshot.evidence.filter((e: any) => /^ISS-|^TKT-/.test(e.sourceId));
for (const e of workEvidence) {
  if (e.body !== sourceRows[e.sourceId]?.description) throw new Error(`Snapshot excerpt differs from source: ${e.sourceId}`);
}
const entities: any[] = workEvidence.map((e: any) => ({
  entity_id: 'entity-' + e.sourceId.toLowerCase(),
  kind: e.sourceId.startsWith('ISS-') ? 'issue' : 'ticket', label: e.title,
  native: native(e.sourceId.startsWith('ISS-') ? 'issues' : 'tickets', e.sourceId),
  source_ref: { record_id: e.sourceId, path: e.path },
}));
// Account entries include rev_org metadata in the manifest; only expose native fields.
const object = (family: string, key: string) => ({ id: manifest[family][key].id, display_id: manifest[family][key].display_id, url: null });
entities.push({ entity_id: 'entity-subscriptions', kind: 'part', label: 'Subscriptions',
  native: object('parts', 'PART-003'), source_ref: { record_id: 'PART-003', path: 'pm_json_data/maple_parts.json' } });
for (const [key, name] of [['ACC-001','TechFlow Payments Inc'],['ACC-002','GlobalCommerce Solutions'],['ACC-005','GlobalMart']])
  entities.push({ entity_id: 'entity-' + key.toLowerCase(), kind: 'account', label: name,
    native: object('accounts', key), source_ref: { record_id: key, path: 'crm_json_data/accounts.json' } });
const evidence = workEvidence.map((e: any) => ({
  evidence_id: 'evidence-' + e.sourceId.toLowerCase(), entity_id: 'entity-' + e.sourceId.toLowerCase(),
  source_ref: { dataset_id: 'enterprise-bench/maple-payments', path: e.path,
    record_id: e.sourceId, content_sha256: recordHash(e.sourceId) },
  original_event_at: e.date, retrieved_at: snapshot.capturedAt,
  source_owner: { person_id: null, name: null, resolution: 'missing' },
  visibility: 'internal', coverage: 'native_imported',
  excerpt: { text: e.body, field_path: 'original_record.description', start: 0,
    end: Array.from(e.body).length, units: 'unicode_code_points' },
}));
for (const e of workEvidence) {
  const base = evidence.find((x: any) => x.evidence_id === 'evidence-' + e.sourceId.toLowerCase());
  for (const field of ['components', ...(e.accountId ? ['account_id'] : [])]) {
    const value = sourceRows[e.sourceId][field];
    const text = typeof value === 'string' ? value : canonicalJson(value);
    evidence.push({ ...structuredClone(base), evidence_id: `evidence-${e.sourceId.toLowerCase()}-${field.replace('_','-')}`,
      excerpt: { text, field_path: 'original_record.' + field, start: 0, end: Array.from(text).length, units: 'unicode_code_points' } });
  }
}
const ticketRefs = ['evidence-tkt-124','evidence-tkt-125','evidence-tkt-126'];
const actions = [
  { action_id: 'task-scheduler', purpose: 'scheduler-check', title: 'Verify Brazil renewal scheduler and retry behavior',
    body: 'Investigate missing renewal attempts, retry jobs, and failure webhooks using ISS-42 and the three cited customer reports.',
    evidence: ['evidence-iss-031', ...ticketRefs], checks: ['Record queue observations or state that runtime access is unavailable', 'Distinguish scheduled renewal failure from manual charge behavior'] },
  { action_id: 'task-replay', purpose: 'replay-safety', title: 'Validate rerouting and missed-renewal replay safety',
    body: 'Review the US-East routing proposal in ISS-42. Use scheduler findings to define idempotency, no-double-billing, and webhook checks before any production change.',
    evidence: ['evidence-iss-031'], checks: ['Define a no-double-billing test', 'Define replay and webhook checks; do not claim that they passed'] },
  { action_id: 'task-customer-drafts', purpose: 'customer-update-drafts', title: 'Prepare cited Brazil renewal updates for affected accounts',
    body: 'Prepare drafts for TechFlow, GlobalCommerce, and GlobalMart. Include confirmed symptoms, remaining gaps, and the next investigation step. Do not send messages.',
    evidence: ticketRefs, checks: ['Link each draft to its customer report', 'Keep unverified ETAs and recovery claims out of the drafts'] },
].map(a => ({ action_id: a.action_id, action_key: `ripple/maple/ISS-031/${a.purpose}`,
  operation: 'create_issue', title: a.title,
  body_markdown: a.body + '\n\nAcceptance checks:\n' + a.checks.map(c => '- ' + c).join('\n') +
    '\n\nEvidence:\n' + a.evidence.map(ref => {
      const e = evidence.find((e: any) => e.evidence_id === ref)!;
      const entity = entities.find((entity: any) => entity.entity_id === e.entity_id)!;
      return `- ${e.source_ref.record_id} / ${entity.native.display_id} (${ref})`;
    }).join('\n'), priority: 'p1',
  part_entity_id: 'entity-subscriptions', owner_id: null,
  context_entity_ids: ['entity-iss-031', ...(a.action_id === 'task-customer-drafts' ? ['entity-acc-001', 'entity-acc-002', 'entity-acc-005'] : [])],
  evidence_ids: a.evidence, acceptance_checks: a.checks }));
const relationships: any[] = workEvidence.map((e: any) => ({
  relationship_id: 'relation-part-' + e.sourceId.toLowerCase(),
  from_entity_id: 'entity-' + e.sourceId.toLowerCase(), to_entity_id: 'entity-subscriptions',
  kind: 'applies_to_part', basis: 'source_record', statement: 'The source record lists subscription part PART-003.',
  evidence_ids: ['evidence-' + e.sourceId.toLowerCase() + '-components'],
}));
for (const e of workEvidence.filter((e: any) => e.accountId)) relationships.push({
  relationship_id: 'relation-account-' + e.sourceId.toLowerCase(),
  from_entity_id: 'entity-' + e.sourceId.toLowerCase(), to_entity_id: 'entity-' + e.accountId.toLowerCase(),
  kind: 'reported_by_account', basis: 'source_record', statement: 'The source ticket belongs to this account.',
  evidence_ids: ['evidence-' + e.sourceId.toLowerCase() + '-account-id'],
});
const response = sealPlan(InvestigationResponseSchema.parse({
  schema_version: VERSION, request_id: request.request_id, investigation_id: id(2),
  generated_at: inventory.captured_at, status: 'review_required',
  outcome: { statement: request.outcome, success_criteria: ['Renewals resume', 'Missed renewals can be replayed without duplicate billing'],
    constraints: request.constraints, reference_time: request.reference_time },
  summary: 'The reports distinguish missed scheduled renewals from working manual charges. The existing issue proposes rerouting with safe replay; validate the plan before acting.',
  questions: [], context_bundle: {
    entities, evidence,
    claims: [
      { claim_id: 'claim-manual', kind: 'fact', statement: 'The three customer reports say manual charges succeed while Brazil renewals fail.', evidence_ids: ticketRefs },
      { claim_id: 'claim-diagnosis', kind: 'fact', statement: 'The existing issue attributes renewal failures to scheduler instability after an infrastructure migration.', evidence_ids: ['evidence-iss-031'] },
      { claim_id: 'claim-safety', kind: 'fact', statement: 'The existing issue requires no double billing as part of recovery.', evidence_ids: ['evidence-iss-031'] },
      { claim_id: 'claim-context', kind: 'inference', statement: 'Shared subscription context and matching symptoms support a coordinated investigation; they do not independently prove runtime causality.', evidence_ids: ['evidence-iss-031', ...ticketRefs, ...workEvidence.map((e: any) => `evidence-${e.sourceId.toLowerCase()}-components`)] },
    ], relationships,
    gaps: [{ gap_id: 'gap-live-queue', question: 'Is replay safe in the current runtime?',
      why_it_matters: 'The benchmark supplies no running queue or duplicate-charge test results.',
      blocks: 'production_change', next_step: 'Create investigation checks; obtain permitted runtime evidence before a production change.' }],
    coverage: { dataset_id: 'enterprise-bench/maple-payments', archive_sha256: manifest.archive_sha256,
      retrieval_scope: 'imported_only', limitations: ['Example uses a static verified snapshot, not a live MCP run',
        'Native owner and dates reflect import; use original metadata', 'Historical source owners have not been resolved in this example',
        'Remaining closed ticket/deal backlogs are not native imported'] },
  },
  action_graph: { plan_id: id(3), revision: 1, plan_digest: '0'.repeat(64),
    expires_at: '2026-10-11T22:54:31Z', existing_work_entity_ids: ['entity-iss-031'], actions,
    dependencies: [{ prerequisite_action_id: 'task-scheduler', dependent_action_id: 'task-replay',
      reason: 'Use scheduler findings when defining replay safety checks.' }],
  },
}));
write('investigation-request.json', request);
write('investigation-response.json', response);
write('revise-plan-request.json', RevisePlanRequestSchema.parse({
  schema_version: VERSION, plan_id: response.action_graph!.plan_id, expected_revision: 1,
  owner_assignments: actions.map(a => ({ action_id: a.action_id, owner_id: manifest.owner })),
}));
const revised: InvestigationResponse = structuredClone(response);
revised.action_graph!.revision = 2;
revised.action_graph!.actions.forEach(a => { a.owner_id = manifest.owner; });
const ready = sealPlan(revised);
write('revised-investigation-response.json', ready);
const decision = PlanDecisionRequestSchema.parse({ schema_version: VERSION,
  plan_id: ready.action_graph!.plan_id, expected_revision: 2, plan_digest: ready.action_graph!.plan_digest,
  decision: 'approve', idempotency_key: id(4) });
write('plan-decision-request.json', decision);
write('reject-plan-request.json', PlanDecisionRequestSchema.parse({ ...decision, decision: 'reject', idempotency_key: id(5) }));
write('rejected-execution-result.json', ExecutionResultSchema.parse({ schema_version: VERSION,
  investigation_id: ready.investigation_id, plan_id: decision.plan_id, revision: 2,
  plan_digest: decision.plan_digest, idempotency_key: id(5), approval: null,
  status: 'rejected', results: [], error: null }));
write('operation-error.json', OperationErrorSchema.parse({ schema_version: VERSION, operation: 'decide_plan',
  request_id: null, plan_id: decision.plan_id,
  error: { code: 'stale_plan', message: 'The plan changed. Review the current revision.', retry: 'never' } }));
const schemas = Object.fromEntries(Object.entries(ContractSchemas).map(([key, schema]) => [key, z.toJSONSchema(schema)]));
writeFileSync(new URL('./investigation.schema.json', import.meta.url), JSON.stringify(schemas, null, 2) + '\n');
// Integrity manifest makes fixture drift visible, without a real approval or fabricated work IDs.
write('manifest.json', { fixture_only: true, archive_sha256: manifest.archive_sha256,
  snapshot_captured_at: snapshot.capturedAt, proposed_actions_are_generated: true,
  assigned_native_owner_is_an_example_not_authorization: true,
  evidence_sha256: createHash('sha256').update(canonicalJson(evidence)).digest('hex') });
console.log('Generated six message schemas and eight protocol examples. No remote calls or writes.');
