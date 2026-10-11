import { randomUUID } from 'node:crypto';
import type { InvestigationResponse } from '../../../contracts/investigation.ts';
import type { Owner, Plan, View } from './types.ts';
import { graphData } from './graph.ts';
export type Snap = { type: string; [key: string]: unknown };
export type UIState = { workspace: string; actorId: string; issue: string; planId: string | null;
  revision: number | null; digest: string | null; decisionKey: string; expires: number; view: View };
export const plain = (text: string): Snap => ({ type: 'plain_text', text });
const content = (...elements: Snap[]): Snap => ({ type: 'content', elements });
const card = (title: string, elements: Snap[], collapsed = false): Snap => ({ type: 'card', title: plain(title), elements,
  is_collapsible: collapsed, default_collapsed: collapsed });
const actions = (...elements: Snap[]): Snap => ({ type: 'actions', direction: 'row', elements });
const citationLabel = (r: InvestigationResponse, id: string) => {
  const e = r.context_bundle.evidence.find(e => e.evidence_id === id);
  return r.context_bundle.entities.find(n => n.entity_id === e?.entity_id)?.native?.display_id ?? e?.source_ref.record_id ?? id;
};
const button = (id: string, text: string, block: string, value = id, disabled = false): Snap => ({ type: 'button',
  action_id: `${id}:${randomUUID()}`, action_type: 'remote', block_id: block, text: plain(text), value, disabled,
  style: id === 'approve' || id === 'investigate' ? 'primary' : 'default' });
const select = (id: string, options: { value: string; label: string }[], current: string | null, block: string): Snap => ({
  type: 'static_select', action_id: id, action_type: 'remote', block_id: block,
  options: options.map(o => ({ value: o.value, text: plain(o.label) })),
  ...(options.find(o => o.value === current) ? { initial_selected_option: { value: current, text: plain(options.find(o => o.value === current)!.label) } } : {}),
});
export function initialState(workspace: string, actorId: string, issue: string): UIState {
  return { workspace, actorId, issue, planId: null, revision: null, digest: null, decisionKey: randomUUID(),
    expires: Date.now() + 12 * 60 * 60_000, view: { mode: 'context', selected: null, evidenceId: null } };
}
export function bindState(state: UIState, response: InvestigationResponse): UIState {
  return { ...state, planId: response.action_graph?.plan_id ?? null, revision: response.action_graph?.revision ?? null,
    digest: response.action_graph?.plan_digest ?? null, decisionKey: randomUUID() };
}
export function renderBrief(options: { state: UIState; signedState: string; response?: InvestigationResponse;
  plan?: Plan; owners?: Owner[]; imageUrl?: string; error?: string; preview?: boolean | 'live' }): { snaps: Snap[] } {
  const { state, signedState: block, response, plan, owners = [], imageUrl, error, preview } = options;
  const graph = response?.action_graph;
  const snaps: Snap[] = [];
  if (preview) snaps.push(card(preview === 'live' ? 'Live DevRev reads; simulated ticket creation' : 'Local fixture preview',
    [content(plain(preview === 'live' ? 'Source access is checked using the local connector. Approval creates PREVIEW tickets only. No DevRev work is created.' : 'This preview simulates the workflow. It cannot create DevRev work.'))]));
  if (error) snaps.push(card('Review needed', [content(plain(error)), actions(button('refresh', 'Refresh review', block))]));
  snaps.push(card('Ripple · issue brief', [content(plain(response?.outcome.statement ?? 'Restore Brazil subscription renewals without double billing'),
    plain('Issue → Findings → Impact → Review → Execution')),
    ...(!response || plan?.state === 'review' ? [{ type: 'form', action_id: 'intake', action_type: 'remote', block_id: block,
      elements: [{ type: 'input_layout', label: plain('Business outcome'), element: { type: 'plain_text_input',
        action_id: 'outcome', action_type: 'client', initial_value: response?.outcome.statement ?? 'Restore Brazil subscription renewals without double billing', max_length: 2000 } },
        { type: 'input_layout', label: plain('Constraints (one per line)'), element: { type: 'plain_text_input', action_id: 'constraints',
          action_type: 'client', multiline: true, initial_value: response?.outcome.constraints.join('\n') ?? 'Do not change production settings\nKeep customer updates as drafts' } }],
      submit_action: button('investigate', response ? 'Investigate again' : 'Investigate issue', block),
    } as Snap] : [])]));
  if (!response) return { snaps };
  snaps.push(card('Findings', [content(plain(response.summary),
    plain(`Reference: ${response.outcome.reference_time}. Original source dates and retrieval dates are shown separately.`),
    plain(response.context_bundle.evidence.some(e => e.source_ref.dataset_id.includes('maple')) ? 'Replay of March 2026 evidence. This is not a live October incident.' : 'Source events and retrieval times are shown in each citation.')),
    ...response.context_bundle.claims.flatMap(c => [content(plain(`${c.kind === 'fact' ? 'Source fact' : 'Inference'} · ${c.statement}`)),
      actions(...c.evidence_ids.map(id => button('evidence', citationLabel(response, id), block, id)))]),
  ]));
  if (response.questions.length) snaps.push(card('Clarification needed', [content(...response.questions.map(plain))]));
  const data = graphData(response, state.view);
  const selections = [...data.nodes.map(n => ({ value: n.id, label: `${n.subtitle} · ${n.label}` })),
    ...data.edges.map(e => ({ value: e.id, label: `${data.nodes.find(n => n.id === e.from)?.subtitle} → ${data.nodes.find(n => n.id === e.to)?.subtitle}` }))];
  const selectedEntity = response.context_bundle.entities.find(e => e.entity_id === state.view.selected);
  const selectedRel = response.context_bundle.relationships.find(e => e.relationship_id === state.view.selected);
  const selectedAction = graph?.actions.find(a => a.action_id === state.view.selected || `plan-${a.action_id}` === state.view.selected);
  const selectedDependency = graph?.dependencies[Number(state.view.selected?.replace('dependency-', ''))];
  const selectedEvidence = selectedRel?.evidence_ids ?? selectedAction?.evidence_ids ?? (selectedDependency ? [...new Set(graph?.actions.filter(a =>
    [selectedDependency.prerequisite_action_id, selectedDependency.dependent_action_id].includes(a.action_id)).flatMap(a => a.evidence_ids))] :
    response.context_bundle.evidence.filter(e => e.entity_id === selectedEntity?.entity_id).map(e => e.evidence_id));
  snaps.push(card('Impact graph', [
    ...(imageUrl ? [content({ type: 'image', image_url: imageUrl, alt_text: 'Issue, product parts, reports and accounts connected by cited relationships.', fill_container: true })] : []),
    actions(select('mode', [{ value: 'context', label: 'Context' }, { value: 'work', label: 'Proposed work' }], state.view.mode, block)),
    ...(selections.length ? [actions(select('selection', selections, state.view.selected, block))] : []),
    content(plain(selectedRel ? `${selectedRel.basis.replaceAll('_', ' ')} · ${selectedRel.statement}` : selectedAction ? `Proposed work · ${selectedAction.title}` : selectedEntity ? selectedEntity.label
      : selectedDependency ? `Investigation order: ${selectedDependency.reason}` : 'Select a record or relationship to inspect its evidence.')),
    ...(selectedEvidence.length ? [actions(...selectedEvidence.map(id => button('evidence', citationLabel(response, id), block, id)))] : []),
    content(plain('Investigation order is a plan instruction. Native dependency links are not created.')),
  ]));
  snaps.push(card('Relationship list', [content(...response.context_bundle.relationships.map(r => plain(
    `${response.context_bundle.entities.find(e => e.entity_id === r.from_entity_id)?.native?.display_id ?? r.from_entity_id} → ${response.context_bundle.entities.find(e => e.entity_id === r.to_entity_id)?.native?.display_id ?? r.to_entity_id}: ${r.statement} (${r.basis})`
  )))], true));
  const evidence = response.context_bundle.evidence.find(e => e.evidence_id === state.view.evidenceId);
  if (evidence) {
    const entity = response.context_bundle.entities.find(e => e.entity_id === evidence.entity_id)!;
    snaps.push(card(`Evidence · ${evidence.source_ref.record_id} / ${entity.native?.display_id ?? 'archive only'}`, [content(
      plain(evidence.excerpt.text), plain(`Source event: ${evidence.original_event_at ?? 'unknown'} · Retrieved: ${evidence.retrieved_at}`),
      plain(`${evidence.source_ref.dataset_id} · ${evidence.source_ref.path} · ${evidence.coverage}`),
      plain(`Original owner: ${evidence.source_owner.name ?? 'unresolved'} (${evidence.source_owner.resolution}). This does not assign new work.`),
      plain(`Excerpt: ${evidence.excerpt.field_path} [${evidence.excerpt.start}, ${evidence.excerpt.end}) · unicode code points · SHA-256 ${evidence.source_ref.content_sha256}`)),
      ...(entity.native?.url ? [actions({ ...button('open', 'Open in DevRev', block), href: entity.native.url })] : [])]));
  }
  if (response.context_bundle.gaps.length) snaps.push(card('Remaining questions', [content(...response.context_bundle.gaps.flatMap(g => [
    plain(`${g.question} · Blocks: ${g.blocks.replaceAll('_', ' ')}`), plain(`${g.why_it_matters} ${g.next_step}`),
  ]))]));
  if (!graph) return { snaps };
  for (const action of graph.actions) {
    const owner = owners.find(o => o.id === action.owner_id);
    const part = response.context_bundle.entities.find(e => e.entity_id === action.part_entity_id)!;
    snaps.push(card(`Proposed ticket · ${action.title}`, [content(plain(`Internal · ${part.label} (${part.native!.display_id})`),
      { type: 'rich_text', text: action.body_markdown }, plain(`Saved owner: ${owner?.name ?? action.owner_id ?? 'Select an owner'}`)),
      ...(plan?.state === 'review' || !plan ? [actions({ type: 'user_picker', action_id: `owner:${action.action_id}`, action_type: 'remote', block_id: block,
        user_types: ['dev_user'], max_selected_items: 1, initial_dev_users_selected_options: action.owner_id ? [action.owner_id] : [],
        placeholder: plain('Select current ticket owner') })] : []),
      content(plain('Acceptance checks'), ...action.acceptance_checks.map(c => plain(`• ${c}`))),
      actions(...action.evidence_ids.map(id => button('evidence', citationLabel(response, id), block, id))),
    ]));
  }
  if (plan?.state === 'approved' || plan?.state === 'rejected') {
    const result = plan.result;
    snaps.push(card(plan.state === 'rejected' ? 'Plan rejected' : result ? 'Execution result' : 'Creating approved tickets', [content(
      plain(plan.state === 'rejected' ? 'No tickets were created.' : result ? `Status: ${result.status}` : 'Approval is recorded. The durable worker is processing this revision.'),
      ...(result?.approval ? [plain(`Approved by ${owners.find(o => o.id === result.approval!.actor_id)?.name ?? result.approval.actor_id} · ${result.approval.recorded_at}`)] : []),
      ...(result?.results.flatMap(r => [plain(`${r.native?.display_id ?? graph.actions.find(a => a.action_id === r.action_id)?.title} · ${r.status.replaceAll('_', ' ')}`),
        ...(r.error ? [plain(r.error.message)] : [])]) ?? [])),
      ...(result?.results.flatMap(r => r.native?.url ? [actions({ ...button('open', `Open ${r.native.display_id}`, block), href: r.native.url })] : [] ) ?? []),
      ...(plan.state === 'approved' ? [actions(button('reconcile', 'Check write status', block))] : []),
      actions(button('new-review', 'Start a fresh review', block)),
    ]));
  } else {
    const disabled = graph.actions.some(a => !a.owner_id) || Date.parse(graph.expires_at) <= Date.now() || response.context_bundle.gaps.some(g => ['investigation', 'execution'].includes(g.blocks));
    snaps.push(card('Approve this revision', [content(plain(`Revision ${graph.revision} · Expires ${graph.expires_at}`),
      plain(`Digest ${graph.plan_digest.slice(0, 12)} · ${graph.actions.length} internal execution ticket${graph.actions.length === 1 ? '' : 's'}`),
      plain(disabled ? 'Select current owners and resolve any investigation blockers before approval.' : 'Owner changes are saved as a new revision before this approval becomes available.')),
      actions(button('approve', `Approve & ${preview ? 'simulate' : 'create'} ${graph.actions.length} ticket${graph.actions.length === 1 ? '' : 's'}`, block, 'approve', disabled),
        button('reject', 'Reject plan', block))]));
  }
  return { snaps };
}
