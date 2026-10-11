import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  InvestigationRequestSchema, InvestigationResponseSchema, NativeObjectSchema,
  type InvestigationRequest, type InvestigationResponse, type ContextBundle, type Evidence, type Task,
} from './investigation.ts';
import { canonicalJson, sealPlan, computePlanDigest } from './review.server.ts';

// Internal adapter protocol only. The shared public contract stays in investigation.ts.
const SourceSchema = z.object({
  kind: z.enum(['issue', 'ticket', 'article']), source_id: z.string(), path: z.string(), label: z.string(),
  native: NativeObjectSchema.nullable(), original: z.union([z.record(z.string(), z.unknown()), z.string()]),
  coverage: z.enum(['native_imported', 'archive_only']), retrieved_at: z.iso.datetime({ offset: true }),
  part_source_id: z.string().nullable(), account_source_id: z.string().nullable(),
});
export const RetrievalSchema = z.object({
  records: z.array(SourceSchema).max(12),
  entities: z.array(z.object({ kind: z.enum(['part', 'account']), source_id: z.string(), path: z.string(), label: z.string(), native: NativeObjectSchema })).max(16),
  archive_sha256: z.string().regex(/^[a-f0-9]{64}$/), limitations: z.array(z.string()).max(20),
  discovered_tools: z.array(z.unknown()), trace: z.array(z.unknown()), started_at: z.iso.datetime({ offset: true }),
});
export type Retrieval = z.infer<typeof RetrievalSchema>;
type Source = z.infer<typeof SourceSchema>;
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
const localId = (prefix: string, key: string) => prefix + '-' + hash(key).slice(0, 16);
const entityId = (key: string) => localId('entity', key);
const evidenceId = (key: string, field: string) => localId('evidence', key + '/' + field);

export function sourceField(original: Source['original'], field: string): string {
  if (field === 'original_record' && typeof original === 'string') return original;
  if (!field.startsWith('original_record.') || typeof original === 'string') throw new Error('Unknown citation field');
  const name = field.slice('original_record.'.length);
  if (!Object.hasOwn(original, name)) throw new Error('Missing citation field');
  const value = original[name];
  return typeof value === 'string' ? value : canonicalJson(value);
}

function eventAt(source: Source): string | null {
  if (typeof source.original === 'string') return null;
  const date = source.original.created_at;
  if (date == null) return null;
  return z.iso.datetime({ offset: true }).parse(date);
}
function owner(source: Source): Evidence['source_owner'] {
  const id = typeof source.original === 'string' ? null : source.original.assignee_id;
  return { person_id: typeof id === 'string' ? id : null, name: null, resolution: 'missing' };
}
function cite(source: Source, field: string, start = 0, length = 12000): Evidence {
  const points = Array.from(sourceField(source.original, field));
  const end = Math.min(points.length, start + length);
  return {
    evidence_id: evidenceId(source.source_id, field), entity_id: entityId(source.source_id),
    source_ref: { dataset_id: 'enterprise-bench/maple-payments', path: source.path, record_id: source.source_id, content_sha256: hash(source.original) },
    original_event_at: eventAt(source), retrieved_at: source.retrieved_at, source_owner: owner(source),
    visibility: 'internal', coverage: source.coverage,
    excerpt: { text: points.slice(start, end).join(''), field_path: field, start, end, units: 'unicode_code_points' },
  };
}

// This guard checks source integrity beyond the shared schema's reference checks.
// A matching native ID in an archive manifest alone is never a native read proof.
export function validateEvidence(response: InvestigationResponse, input: Retrieval, options: { fresh?: boolean } = {}): void {
  const r = InvestigationResponseSchema.parse(response), retrieved = RetrievalSchema.parse(input);
  const sources = new Map(retrieved.records.map(s => [s.source_id, s]));
  const related = new Map(retrieved.entities.map(s => [s.source_id, s]));
  if (sources.size !== retrieved.records.length || related.size !== retrieved.entities.length ||
      [...related.keys()].some(key => sources.has(key))) throw new Error('Duplicate source records');
  const entities = new Map(r.context_bundle.entities.map(e => [e.entity_id, e]));
  // Validate every entity, including ones that do not happen to have a citation.
  // A fabricated uncited native object must never become approved context.
  for (const entity of entities.values()) {
    const key = entity.source_ref?.record_id;
    const proof = key ? sources.get(key) ?? related.get(key) : undefined;
    if (!proof || entityId(proof.source_id) !== entity.entity_id || entity.kind !== proof.kind ||
        entity.label !== proof.label || canonicalJson(entity.native) !== canonicalJson(proof.native) ||
        canonicalJson(entity.source_ref) !== canonicalJson({ record_id: proof.source_id, path: proof.path }))
      throw new Error('Unverified source/native entity');
    if (sources.has(proof.source_id) && !r.context_bundle.evidence.some(e => e.entity_id === entity.entity_id))
      throw new Error('Source entity has no reviewed source hash');
  }
  for (const source of sources.values()) {
    if (source.coverage === 'native_imported' && !source.native || source.coverage === 'archive_only' && source.native)
      throw new Error('Native mapping/coverage mismatch');
    if (source.kind === 'article') {
      if (typeof source.original !== 'string') throw new Error('Article source bytes unavailable');
      continue;
    }
    if (!source.native || typeof source.original === 'string' || source.original[source.kind + '_id'] !== source.source_id)
      throw new Error('Original source identity mismatch');
    if (!source.part_source_id || !Array.isArray(source.original.components) || !source.original.components.includes(source.part_source_id))
      throw new Error('Source product-part join mismatch');
    if ((source.original.account_id ?? null) !== source.account_source_id) throw new Error('Source account join mismatch');
    for (const field of ['created_at', 'updated_at']) {
      const date = source.original[field];
      if (typeof date === 'string') {
        z.iso.datetime({ offset: true }).parse(date);
        if (Date.parse(date) > Date.parse(r.outcome.reference_time)) throw new Error('Source row newer than reference time');
      }
    }
  }
  for (const evidence of r.context_bundle.evidence) {
    const source = sources.get(evidence.source_ref.record_id), entity = entities.get(evidence.entity_id);
    if (!source || !entity || entity.entity_id !== entityId(source.source_id)) throw new Error('Citation source unavailable');
    if (evidence.source_ref.path !== source.path || evidence.source_ref.content_sha256 !== hash(source.original)) throw new Error('Source hash/path mismatch');
    if (canonicalJson(entity.native) !== canonicalJson(source.native) || evidence.coverage !== source.coverage) throw new Error('Native mapping/coverage mismatch');
    const timestampMatches = options.fresh
      ? Date.parse(source.retrieved_at) >= Date.parse(evidence.retrieved_at) && Date.parse(source.retrieved_at) >= Date.parse(retrieved.started_at)
      : evidence.retrieved_at === source.retrieved_at;
    if (evidence.original_event_at !== eventAt(source) || !timestampMatches || canonicalJson(evidence.source_owner) !== canonicalJson(owner(source)))
      throw new Error('Source metadata mismatch');
    const excerpt = evidence.excerpt;
    if (Array.from(sourceField(source.original, excerpt.field_path)).slice(excerpt.start, excerpt.end).join('') !== excerpt.text)
      throw new Error('Excerpt differs from original source');
  }
  for (const relationship of r.context_bundle.relationships) {
    const from = entities.get(relationship.from_entity_id)!, to = entities.get(relationship.to_entity_id)!;
    const source = from.source_ref ? sources.get(from.source_ref.record_id) : undefined;
    const joined = relationship.kind === 'applies_to_part' ? source?.part_source_id
      : relationship.kind === 'reported_by_account' ? source?.account_source_id : undefined;
    if (!source || !joined || entityId(joined) !== to.entity_id ||
        to.kind !== (relationship.kind === 'applies_to_part' ? 'part' : 'account') || relationship.basis !== 'source_record' || !relationship.evidence_ids.some(id => {
          const evidence = r.context_bundle.evidence.find(e => e.evidence_id === id);
          return evidence?.entity_id === from.entity_id && evidence.excerpt.field_path ===
            (relationship.kind === 'applies_to_part' ? 'original_record.components' : 'original_record.account_id');
        }))
      throw new Error('Unverified source relationship join');
  }
  if (r.context_bundle.coverage.archive_sha256 !== retrieved.archive_sha256) throw new Error('Archive checksum mismatch');
  if (r.action_graph && r.action_graph.plan_digest !== computePlanDigest(r)) throw new Error('Plan digest mismatch');
}

export function prepareInvestigation(rawRequest: InvestigationRequest, rawRetrieval: Retrieval, now = new Date()): InvestigationResponse {
  const request = InvestigationRequestSchema.parse(rawRequest), retrieved = RetrievalSchema.parse(rawRetrieval);
  const sources = retrieved.records;
  const work = sources.filter(s => s.kind !== 'article');
  const docs = sources.filter(s => s.kind === 'article');
  const starting = request.scope_hints.starting_object;
  const primary = starting ? work.find(s => s.kind === 'issue' && s.native?.id === starting.id) : work.find(s => s.kind === 'issue');
  if (starting && (!primary || primary.native?.display_id !== starting.display_id))
    throw new Error('Starting issue is unavailable or its native identity changed; start a fresh scoped investigation.');
  if (primary && request.scope_hints.part_ids.length && !retrieved.entities.some(e =>
      e.kind === 'part' && e.source_id === primary.part_source_id && request.scope_hints.part_ids.includes(e.native.id)))
    throw new Error('Starting issue does not match the requested product-part scope.');
  if (primary && request.scope_hints.account_ids.length && !retrieved.entities.some(e =>
      e.kind === 'account' && e.source_id === primary.account_source_id && request.scope_hints.account_ids.includes(e.native.id)))
    throw new Error('Starting issue does not match the requested account scope.');
  const tickets = work.filter(s => s.kind === 'ticket');
  const entities: ContextBundle['entities'] = [
    ...sources.map(s => ({ entity_id: entityId(s.source_id), kind: s.kind, label: s.label, native: s.native, source_ref: { record_id: s.source_id, path: s.path } })),
    ...retrieved.entities.map(s => ({ entity_id: entityId(s.source_id), kind: s.kind, label: s.label, native: s.native, source_ref: { record_id: s.source_id, path: s.path } })),
  ];
  const evidence: Evidence[] = [];
  const claims: ContextBundle['claims'] = [];
  const relationships: ContextBundle['relationships'] = [];
  for (const source of work) {
    if (typeof source.original === 'string') throw new Error('Work must contain a complete original row');
    if (source.original[source.kind + '_id'] !== source.source_id) throw new Error('Original source ID mismatch');
    const description = cite(source, 'original_record.description');
    evidence.push(description);
    const firstSentence = description.excerpt.text.split(/(?<=[.!?])\s/)[0]!.slice(0, 1800);
    claims.push({ claim_id: localId('claim', source.source_id), kind: 'fact', statement: `${source.native?.display_id ?? source.source_id} records: ${firstSentence}`, evidence_ids: [description.evidence_id] });
    if (source.original.updated_at) {
      const updated = cite(source, 'original_record.updated_at');
      evidence.push(updated);
      claims.push({ claim_id: localId('claim', source.source_id + '/updated'), kind: 'fact', statement: `The original ${source.source_id} row records updated_at as ${updated.excerpt.text}. This is source time, not native import time.`, evidence_ids: [updated.evidence_id] });
    }
    for (const [field, target, kind] of [
      ['components', source.part_source_id, 'applies_to_part'], ['account_id', source.account_source_id, 'reported_by_account'],
    ] as const) {
      if (!target || !entities.some(e => e.entity_id === entityId(target))) continue;
      const join = cite(source, 'original_record.' + field);
      evidence.push(join);
      relationships.push({ relationship_id: localId('relation', source.source_id + '/' + field), from_entity_id: entityId(source.source_id), to_entity_id: entityId(target),
        kind, basis: 'source_record', statement: `The original ${field} field references ${target}; its native identity was read through MCP.`, evidence_ids: [join.evidence_id] });
    }
  }
  for (const doc of docs) {
    const text = sourceField(doc.original, 'original_record');
    const match = /[^\n]*When a payment fails[^\n]*(?:\n(?!#)[^\n]+)*/i.exec(text)
      ?? /^(?!#)[^\n]*(?:retry|dunning|renewal|idempoten|duplicat)[^\n]*(?:\n(?!#)[^\n]+)*/im.exec(text);
    const start = match ? Array.from(text.slice(0, match.index)).length : 0;
    const item = cite(doc, 'original_record', start, Math.min(match?.[0].length ?? 1200, 1800));
    evidence.push(item);
    claims.push({ claim_id: localId('claim', doc.source_id), kind: 'fact', statement: `Archive document “${doc.label}” states: ${item.excerpt.text.slice(0, 1800)}`, evidence_ids: [item.evidence_id] });
  }
  const descriptions = work.map(s => evidenceId(s.source_id, 'original_record.description'));
  const ticketRefs = tickets.map(s => evidenceId(s.source_id, 'original_record.description'));
  const docRefs = docs.map(s => evidenceId(s.source_id, 'original_record'));
  const descriptionText = (s: Source) => sourceField(s.original, 'original_record.description');
  if (tickets.length && tickets.every(s => /manual/i.test(descriptionText(s)) && /succeed/i.test(descriptionText(s)))) {
    claims.push({ claim_id: 'claim-manual-charges', kind: 'fact', statement: 'The cited customer reports say manual charges succeed. These reports are not independently observed payment tests.', evidence_ids: ticketRefs });
  }
  if (primary && /scheduler/i.test(descriptionText(primary))) {
    claims.push({ claim_id: 'claim-issue-diagnosis', kind: 'fact', statement: 'The existing issue describes scheduler instability; this is the issue’s recorded diagnosis, not an independently verified runtime cause.', evidence_ids: [evidenceId(primary.source_id, 'original_record.description')] });
  }
  if (primary && /double.billing/i.test(descriptionText(primary))) {
    claims.push({ claim_id: 'claim-issue-safety', kind: 'fact', statement: 'The existing issue includes a no-double-billing acceptance requirement.', evidence_ids: [evidenceId(primary.source_id, 'original_record.description')] });
  }
  const retryDoc = docs.find(s => /When a payment fails/i.test(sourceField(s.original, 'original_record')));
  if (retryDoc && tickets.some(s => /no (?:charge|payment attempt)/i.test(descriptionText(s)))) {
    claims.push({ claim_id: 'claim-retry-vs-scheduling', kind: 'inference', statement: 'The archive retry guide describes retrying a failed payment, while customer reports describe missing initial attempts. Investigate scheduling separately rather than assume configured dunning resolves these symptoms.',
      evidence_ids: [evidenceId(retryDoc.source_id, 'original_record'), ...ticketRefs] });
  }
  if (descriptions.length) claims.push({ claim_id: 'claim-investigation-context', kind: 'inference',
    statement: 'Matching reported symptoms support investigating these records together. Source part membership does not prove a shared worker, runtime causality, or a past operational decision.', evidence_ids: descriptions });
  const gaps: ContextBundle['gaps'] = [
    { gap_id: 'gap-runtime', question: 'Does the current scheduler run renewals, and can recovery avoid duplicate charges?', why_it_matters: 'No live queue, payment ledger, deployment logs or test results were available to this investigation.', blocks: 'production_change', next_step: 'Obtain authorized runtime and payment-ledger evidence and test recovery before any production change.' },
    { gap_id: 'gap-source-owner', question: 'Who do the historical source assignee IDs identify, and who is currently authorized to own new work?', why_it_matters: 'The importer is not evidence of historical ownership. Historical employee IDs cannot authorize current assignment.', blocks: 'none', next_step: 'Resolve source people from the original directories when needed; the UI/executor must select authorized current owners.' },
  ];
  if (!primary) gaps.push({ gap_id: 'gap-existing-incident', question: 'Is there a relevant accessible existing incident?', why_it_matters: 'Customer symptoms do not establish the missing incident’s diagnosis or routing proposal.', blocks: 'none', next_step: 'Search existing incidents with an authorized reader; do not create a duplicate incident or assert a missing diagnosis.' });
  if (!docs.length || docs.some(s => s.coverage === 'archive_only')) gaps.push({ gap_id: 'gap-native-documentation', question: 'Can this user read current native subscription documentation?', why_it_matters: 'Archive guides do not establish current policy or current native article visibility.', blocks: 'production_change', next_step: 'Have an authorized workspace reader verify article access and policy currency before changing retry or billing behavior.' });
  const reference = request.reference_time ?? now.toISOString();
  const bundle: ContextBundle = {
    entities, evidence, claims, relationships, gaps,
    coverage: { dataset_id: 'enterprise-bench/maple-payments', archive_sha256: retrieved.archive_sha256,
      retrieval_scope: sources.some(s => s.coverage === 'archive_only') ? 'imported_and_archive' : 'imported_only', limitations: retrieved.limitations },
  };
  const partKey = primary?.part_source_id ?? tickets[0]?.part_source_id;
  const part = entities.find(e => e.kind === 'part' && e.entity_id === entityId(partKey ?? ''));
  const supported = /subscript|renew/i.test(request.outcome);
  const previewable = Boolean(work.length && part?.native && supported);
  const response: InvestigationResponse = {
    schema_version: '2.0', request_id: request.request_id, investigation_id: randomUUID(), generated_at: now.toISOString(),
    status: previewable ? 'review_required' : 'needs_input',
    outcome: { statement: request.outcome, success_criteria: [request.outcome, 'Demonstrate recovery with source-linked verification before declaring success'], constraints: request.constraints, reference_time: reference },
    summary: work.length ? `${tickets.length} customer reports and ${work.filter(s => s.kind === 'issue').length} existing issue(s) were retrieved and cited. ${primary ? `Reuse ${primary.native?.display_id} as context.` : 'No existing incident diagnosis is asserted.'} Recovery and duplicate-charge safety remain unverified. ${docs.some(s => s.coverage === 'archive_only') ? 'Documentation is archive-only.' : ''}` : 'No sufficiently relevant, accessible source records were retrieved. No runtime or historical findings are asserted.',
    questions: previewable ? [] : [supported ? 'Which accessible product part or starting record should scope this outcome?' : 'This first planner supports subscription recovery. Can you provide a subscription outcome, or specify the additional planning domain?'],
    context_bundle: bundle, action_graph: null,
  };
  if (previewable) {
    const incidentKey = primary?.source_id ?? hash(tickets.map(s => s.source_id).sort()).slice(0, 24);
    const contextIds = work.map(s => entityId(s.source_id));
    const proposals = [
      { id: 'task-scheduler', purpose: 'scheduler-check', title: 'Verify renewal scheduler and retry behavior',
        body: 'Investigate the reported scheduled-renewal symptoms and distinguish them from manual payment behavior. Compare the cited documentation with the reported behavior; archive guides do not establish current policy. Record observed results only when authorized runtime evidence is available.', refs: [...descriptions, ...docRefs],
        checks: ['Record the current renewal-attempt, retry-queue and webhook evidence, or explicitly report access gaps', 'Compare scheduled renewals with manual charges; do not infer runtime causality from customer reports'] },
      { id: 'task-replay', purpose: 'replay-safety', title: 'Validate recovery and missed-renewal replay safety',
        body: primary ? `Review the recovery proposal recorded in ${primary.native?.display_id}. Treat it as a proposal requiring current verification. Compare the cited guides with current authorized policy, and define replay and idempotency checks before a production change.` : 'Define recovery hypotheses from the customer symptoms; do not assert an unavailable incident’s routing proposal or diagnosis.', refs: [...descriptions, ...docRefs],
        checks: ['Reconcile missed renewal invoices and previous manual charges before replay', 'Define duplicate-charge, idempotency, data-loss and webhook tests; do not claim they passed', 'Require current routing and retry-policy evidence before any production change'] },
      ...(tickets.length ? [{ id: 'task-customer-drafts', purpose: 'customer-update-drafts', title: 'Prepare cited renewal updates for affected accounts',
        body: 'Prepare customer update drafts tied to each retrieved report. Include known source facts, open evidence gaps and proposed investigation steps. Do not send messages.', refs: ticketRefs,
        checks: ['Link every draft to its source ticket and verified account context where available', 'Exclude unverified recovery claims, ETAs and historical decisions'] }] : []),
    ];
    const refs = [...new Set(proposals.flatMap(p => p.refs))];
    const checks = [...new Set(proposals.flatMap(p => p.checks))];
    // Citation IDs are retained in the structured action even when a long path
    // would make a prose evidence list exceed the native ticket body limit.
    const body = proposals.map(p => `## ${p.title}\n${p.body}`).join('\n\n') +
      '\n\nAcceptance checks:\n' + checks.map(c => '- ' + c).join('\n') +
      '\n\nEvidence IDs:\n' + refs.join(', ');
    const actions: Task[] = [{ action_id: 'task-subscription-recovery',
      action_key: `ripple/maple/${incidentKey}/subscription-recovery`, operation: 'create_ticket', visibility: 'internal',
      title: 'Investigate subscription renewal recovery and duplicate-charge safety', body_markdown: body,
      part_entity_id: part!.entity_id, owner_id: null, context_entity_ids: contextIds,
      evidence_ids: refs, acceptance_checks: checks }];
    response.action_graph = { plan_id: randomUUID(), revision: 1, plan_digest: '0'.repeat(64), expires_at: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
      existing_work_entity_ids: work.filter(s => s.kind === 'issue' && s.native).map(s => entityId(s.source_id)), actions,
      dependencies: [] };
  }
  const sealed = sealPlan(response);
  validateEvidence(sealed, retrieved);
  return sealed;
}
