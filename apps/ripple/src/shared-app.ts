import type { Controller } from './controller.ts';
import type { Auth } from './types.ts';
import { graphData } from './graph.ts';
import { reviewView } from './review-view.ts';
import type { Snap, UIState } from './ui.ts';

const flatten = (snaps: Snap[]): Snap[] => snaps.flatMap(s => [s, ...flatten(Array.isArray(s.elements) ? s.elements as Snap[] : [])]);

/** Actions that never write: allowed while the server is read-only. */
export const readOnlyActions = new Set(['investigate', 'intake', 'new-review', 'evidence', 'selection', 'mode']);
export const actionName = (input: { action_id?: unknown }) => typeof input.action_id === 'string' ? input.action_id.split(':', 1)[0]! : '';
export const isApproval = (input: { action_id?: unknown }) => String(input.action_id).startsWith('approve:') || String(input.action_id).startsWith('reconcile:');
export const needsReview = (result: { snaps: Snap[] }) => result.snaps.some(s => (s.title as { text?: string } | undefined)?.text === 'Review needed');

/** Add the browser-only preview fields (owners, graph, evidence controls, review view) to a controller payload. */
export function makeEnrich(controller: Controller, auth: Auth) {
  return async (payload: { snaps: Snap[] }) => {
    const block = flatten(payload.snaps).find(s => typeof s.block_id === 'string')?.block_id as string | undefined;
    let state: UIState | undefined;
    if (block) {
      try { state = controller.service.secrets.verify<UIState>(block, 'ui'); }
      catch { /* Display-only cards do not need a signed action state. */ }
    }
    const plan = state?.planId ? await controller.service.read(auth, state.planId) : undefined;
    const owners = await controller.service.native.owners(auth, '');
    const preview_evidence_controls = plan && block ? plan.response.context_bundle.evidence.map(e => {
      const entity = plan.response.context_bundle.entities.find(n => n.entity_id === e.entity_id);
      return { type: 'button', action_id: 'evidence:graph', block_id: block, value: e.evidence_id,
        text: { type: 'plain_text', text: `${entity?.native?.display_id ?? entity?.label ?? e.source_ref.record_id} · ${e.excerpt.field_path.split('.').at(-1)}` } };
    }) : [];
    return { ...payload, preview_owners: owners, preview_graph: plan && state ? graphData(plan.response, state.view) : null,
      preview_evidence_controls,
      preview_review: plan && state ? reviewView(plan, state.view, owners, process.env.DEVREV_APP_URL) : null };
  };
}

export const modeLabel = (mode: string) => mode === 'fixture' ? 'LOCAL FIXTURE PREVIEW'
  : mode === 'live-preview' ? 'LIVE READS · SIMULATED WRITES'
  : mode === 'read-only' ? 'LIVE DEVREV · READ-ONLY' : 'DEVREV CONNECTED · CONFIGURED RIPPLE AGENT';
