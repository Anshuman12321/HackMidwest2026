import { randomUUID } from 'node:crypto';
import type { InvestigationResponse } from '../../../contracts/investigation.ts';
import type { Owner, Plan, View, IssueBrief } from './types.ts';
import { defaultConstraints, issueOutcome } from './types.ts';
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
  const record = r.context_bundle.entities.find(n => n.entity_id === e?.entity_id)?.native?.display_id ?? e?.source_ref.record_id ?? id;
  const field = e?.excerpt.field_path.split('.').at(-1);
  const label = field === 'components' ? 'part' : field === 'account_id' ? 'account' : field === 'updated_at' ? 'source date' : null;
  return label ? `${record} · ${label}` : record;
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
  plan?: Plan; owners?: Owner[]; imageUrl?: string; error?: string; issue?: IssueBrief; preview?: boolean | 'live' }): { snaps: Snap[] } {
  const { state, signedState: block, response, plan, owners = [], imageUrl, error, issue, preview } = options;
  const graph = response?.action_graph;
  const snaps: Snap[] = [];
  if (error) snaps.push(card('Review needed', [content(plain(error)), actions(button('refresh', 'Refresh review', block))]));
  const goal = issue ? issueOutcome(issue) : `Resolve ${state.issue}`;
  const editable = !response || plan?.state === 'review' || !graph;
  snaps.push(card('Issue context', [
    content(plain(issue?.title ?? response?.outcome.statement ?? 'Investigate this issue'),
      plain(response ? response.outcome.statement === goal ? 'Review the evidence and proposed next work for this issue.' : response.outcome.statement : 'Resolving this issue is the goal. Ripple will trace the evidence and propose the next work.'),
      ...(preview ? [plain(preview === 'live' ? 'Live DevRev reads; simulated ticket creation' : 'Fixture evidence · simulated ticket creation')] : [])),
    ...(editable ? [actions(button('investigate', response ? 'Investigate again' : 'Investigate issue', block)),
      card('Refine goal or add constraints', [
        content(plain('Optional. Leave the goal blank to use the issue’s title, description, and acceptance criteria.')),
        { type: 'form', action_id: 'intake', action_type: 'remote', block_id: block,
          elements: [{ type: 'input_layout', label: plain('Refined goal (optional)'), element: { type: 'plain_text_input',
            action_id: 'outcome', action_type: 'client', initial_value: response && response.outcome.statement !== goal ? response.outcome.statement : '', max_length: 2000 } },
          { type: 'input_layout', label: plain('Constraints (one per line)'), element: { type: 'plain_text_input', action_id: 'constraints',
            action_type: 'client', multiline: true, initial_value: (response?.outcome.constraints ?? defaultConstraints).join('\n') } }],
          submit_action: button('investigate', 'Investigate with refinements', block),
        } as Snap,
      ], true)] : []),
  ], Boolean(response)));
  if (!response) return { snaps };
  const replay = response.context_bundle.evidence.some(e => e.source_ref.dataset_id.includes('maple'));
  const sourceDate = new Date(response.outcome.reference_time).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  const keyClaims = response.context_bundle.claims.filter(c => c.kind === 'inference' || /manual charges|recorded diagnosis|acceptance requirement/i.test(c.statement)).slice(0, 3);
  snaps.push(card('Findings', [
    content(plain(response.summary), plain(replay ? `Historical replay · ${sourceDate}` : `Evidence as of ${sourceDate}`)),
    ...keyClaims.flatMap(c => [content(plain(`${c.kind === 'fact' ? 'Source fact' : 'Inference'} · ${c.statement}`)),
      actions(...c.evidence_ids.map(id => button('evidence', citationLabel(response, id), block, id)))]),
    card('Supporting evidence', response.context_bundle.claims.flatMap(c => [
      content(plain(`${c.kind === 'fact' ? 'Source fact' : 'Inference'} · ${c.statement}`)),
      actions(...c.evidence_ids.map(id => button('evidence', citationLabel(response, id), block, id))),
    ]), true),
  ]));
  if (response.questions.length) snaps.push(card('Clarification needed', [content(...response.questions.map(plain))]));
  const data = graphData(response, state.view);
  const selections = [...data.nodes.map(n => ({ value: n.id, label: `${n.subtitle} · ${n.label}` })),
    ...data.edges.map(e => ({ value: e.id, label: `${data.nodes.find(n => n.id === e.from)?.subtitle} → ${data.nodes.find(n => n.id === e.to)?.subtitle}` }))];
  const selectedEntity = response.context_bundle.entities.find(e => e.entity_id === state.view.selected);
  const selectedRel = response.context_bundle.relationships.find(e => e.relationship_id === state.view.selected);
  const selectedEdge = data.edges.find(e => e.id === state.view.selected);
  const selectedAction = graph?.actions.find(a => a.action_id === state.view.selected || `plan-${a.action_id}` === state.view.selected);
  const selectedDependency = graph?.dependencies[Number(state.view.selected?.replace('dependency-', ''))];
  const selectedEvidence = selectedEdge?.evidenceIds ?? selectedRel?.evidence_ids ?? selectedAction?.evidence_ids ?? (selectedDependency ? [...new Set(graph?.actions.filter(a =>
    [selectedDependency.prerequisite_action_id, selectedDependency.dependent_action_id].includes(a.action_id)).flatMap(a => a.evidence_ids))] :
    response.context_bundle.evidence.filter(e => e.entity_id === selectedEntity?.entity_id).map(e => e.evidence_id));
  snaps.push(card('Impact graph', [
    ...(imageUrl ? [content({ type: 'image', image_url: imageUrl, alt_text: 'Issue, product parts, reports and accounts connected by cited relationships.', fill_container: true })] : []),
    actions(select('mode', [{ value: 'context', label: 'Context' }, { value: 'work', label: 'Proposed work' }], state.view.mode, block)),
    ...(selections.length ? [actions(select('selection', selections, state.view.selected, block))] : []),
    content(plain(selectedEdge ? `${selectedEdge.basis.replaceAll('_', ' ')} · ${selectedEdge.statement}` : selectedAction ? `Proposed work · ${selectedAction.title}` : selectedEntity ? selectedEntity.label
      : selectedDependency ? `Investigation order: ${selectedDependency.reason}` : 'Select a record or relationship to inspect its evidence.')),
    ...(selectedEvidence.length ? [actions(...selectedEvidence.map(id => button('evidence', citationLabel(response, id), block, id)))] : []),
  ]));
  snaps.push(card('Relationship list', [content(...response.context_bundle.relationships.map(r => plain(
    `${response.context_bundle.entities.find(e => e.entity_id === r.from_entity_id)?.native?.display_id ?? r.from_entity_id} → ${response.context_bundle.entities.find(e => e.entity_id === r.to_entity_id)?.native?.display_id ?? r.to_entity_id}: ${r.statement} (${r.basis})`
  )))], true));
  const evidence = response.context_bundle.evidence.find(e => e.evidence_id === state.view.evidenceId);
  if (evidence) {
    const entity = response.context_bundle.entities.find(e => e.entity_id === evidence.entity_id)!;
    snaps.push(card(`Evidence · ${entity.native?.display_id ?? evidence.source_ref.record_id}`, [content(
      plain(evidence.excerpt.text), plain(`Source: ${evidence.original_event_at ?? 'Date unknown'} · ${evidence.coverage.replaceAll('_', ' ')}`)),
      ...(entity.native?.url ? [actions({ ...button('open', 'Open in DevRev', block), href: entity.native.url })] : []),
      card('Source details', [content(
        plain(`${evidence.source_ref.dataset_id} · ${evidence.source_ref.path}`),
        plain(`Retrieved: ${evidence.retrieved_at}`),
        plain(`Original owner: ${evidence.source_owner.name ?? 'Unresolved'} (${evidence.source_owner.resolution}). This does not assign new work.`),
        plain(`Excerpt: ${evidence.excerpt.field_path} [${evidence.excerpt.start}, ${evidence.excerpt.end}) · unicode code points · SHA-256 ${evidence.source_ref.content_sha256}`),
      )], true),
    ]));
  }
  if (response.context_bundle.gaps.length) snaps.push(card('Remaining questions', [content(...response.context_bundle.gaps.flatMap(g => [
    plain(g.question), plain(`${g.why_it_matters} ${g.next_step}`),
  ]))], true));
  if (!graph) return { snaps };
  for (const action of graph.actions) {
    const owner = owners.find(o => o.id === action.owner_id);
    const part = response.context_bundle.entities.find(e => e.entity_id === action.part_entity_id)!;
    snaps.push(card('Proposed ticket', [content(plain(action.title), plain(`Internal · ${part.label} (${part.native!.display_id})`),
      plain(`Owner: ${owner?.name ?? action.owner_id ?? 'Choose an owner'}`)),
      ...(plan?.state === 'review' || !plan ? [actions({ type: 'user_picker', action_id: `owner:${action.action_id}`, action_type: 'remote', block_id: block,
        user_types: ['dev_user'], max_selected_items: 1, initial_dev_users_selected_options: action.owner_id ? [action.owner_id] : [],
        placeholder: plain('Select current ticket owner') })] : []),
      ...(plan?.state === 'review' ? [card('Edit ticket content', [
        content(plain('Saving seals a new revision with a new digest. Approval then covers exactly the edited text.')),
        { type: 'form', action_id: `content:${action.action_id}`, action_type: 'remote', block_id: block,
          elements: [{ type: 'input_layout', label: plain('Title'), element: { type: 'plain_text_input', action_id: 'title',
            action_type: 'client', initial_value: action.title, max_length: 200 } },
          { type: 'input_layout', label: plain('Body (markdown)'), element: { type: 'plain_text_input', action_id: 'body_markdown',
            action_type: 'client', multiline: true, initial_value: action.body_markdown, max_length: 4000 } }],
          submit_action: { type: 'button', action_id: `content-save:${action.action_id}`, action_type: 'remote', block_id: block,
            text: plain('Save as new revision'), style: 'default' },
        } as Snap], true)] : []),
      card('Ticket details & acceptance checks', [content({ type: 'rich_text', text: action.body_markdown }),
        content(plain('Acceptance checks'), ...action.acceptance_checks.map(c => plain(`• ${c}`)))], true),
      card('Ticket evidence', [actions(...action.evidence_ids.map(id => button('evidence', citationLabel(response, id), block, id)))], true),
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
    snaps.push(card('Approve this revision', [content(plain(`${graph.actions.length} internal ticket${graph.actions.length === 1 ? '' : 's'} · Revision ${graph.revision}`),
      plain(disabled ? 'Select current owners and resolve any investigation blockers before approval.' : 'The selected owners and ticket details are ready for approval.')),
      actions(button('approve', `Approve & ${preview ? 'simulate' : 'create'} ${graph.actions.length} ticket${graph.actions.length === 1 ? '' : 's'}`, block, 'approve', disabled),
        button('reject', 'Reject plan', block)),
      card('Review details', [content(plain(`Expires: ${graph.expires_at}`), plain(`Plan digest: ${graph.plan_digest}`))], true)]));
  }
  return { snaps };
}
