import type { Owner, Plan, View } from './types.ts';

/** Structured, display-only projection of a saved review for the browser decision rail.
 * It carries no authority: every action still uses the signed snap controls. */
export type ReviewView = {
  state: Plan['state'];
  summary: string;
  as_of: string;
  replay: boolean;
  findings: { id: string; kind: 'fact' | 'inference'; statement: string; evidence_ids: string[] }[];
  questions: string[];
  gaps: { question: string; next_step: string }[];
  plan: null | {
    plan_id: string; revision: number; digest: string; expires_at: string; approvable: boolean; blocked_reason: string | null;
    tickets: { action_id: string; title: string; body: string; acceptance_checks: string[]; visibility: 'internal';
      part: { label: string; display_id: string | null }; owner: Owner | { id: string; name: string; displayId?: undefined } | null;
      evidence_ids: string[]; context_count: number }[];
  };
  result: null | {
    pending: boolean; status: string | null; error: string | null; approval: { actor: string; recorded_at: string } | null;
    results: { action_id: string; title: string; status: string; display_id: string | null; url: string | null; error: string | null }[];
  };
  evidence: null | { id: string; record: string; field: string; text: string; event_at: string | null; coverage: string; path: string };
};

const keyClaim = /manual charges|recorded diagnosis|acceptance requirement/i;
export function reviewView(plan: Plan, view: View, owners: Owner[], appUrl?: string): ReviewView {
  const r = plan.response, bundle = r.context_bundle, graph = r.action_graph;
  const entity = (id: string) => bundle.entities.find(e => e.entity_id === id);
  const primary = bundle.claims.filter(c => c.kind === 'inference' || keyClaim.test(c.statement));
  const findings = [...primary, ...bundle.claims.filter(c => !primary.includes(c) && c.kind === 'fact')].slice(0, 5);
  const ownerOf = (id: string | null) => !id ? null : owners.find(o => o.id === id) ?? { id, name: id };
  const link = (native: { display_id: string; url: string | null } | null) =>
    native?.url ?? (native && appUrl ? new URL('works/' + encodeURIComponent(native.display_id), appUrl.endsWith('/') ? appUrl : appUrl + '/').href : null);
  const missingOwner = graph?.actions.some(a => !a.owner_id) ?? false;
  const expired = graph ? Date.parse(graph.expires_at) <= Date.now() : false;
  const blocking = bundle.gaps.some(g => ['investigation', 'execution'].includes(g.blocks));
  const evidence = bundle.evidence.find(e => e.evidence_id === view.evidenceId);
  return {
    state: plan.state,
    summary: r.summary,
    as_of: r.outcome.reference_time,
    replay: bundle.evidence.some(e => e.source_ref.dataset_id.includes('maple')),
    findings: findings.map(c => ({ id: c.claim_id, kind: c.kind, statement: c.statement, evidence_ids: c.evidence_ids })),
    questions: r.questions,
    gaps: bundle.gaps.map(g => ({ question: g.question, next_step: g.next_step })),
    plan: graph ? {
      plan_id: graph.plan_id, revision: graph.revision, digest: graph.plan_digest, expires_at: graph.expires_at,
      approvable: plan.state === 'review' && !missingOwner && !expired && !blocking,
      blocked_reason: missingOwner ? 'Choose a current owner for every ticket before approving.'
        : expired ? 'This revision expired. Start a fresh review.' : blocking ? 'Resolve the blocking investigation questions first.' : null,
      tickets: graph.actions.map(a => {
        const part = entity(a.part_entity_id);
        return { action_id: a.action_id, title: a.title, body: a.body_markdown, acceptance_checks: a.acceptance_checks, visibility: 'internal' as const,
          part: { label: part?.label ?? a.part_entity_id, display_id: part?.native?.display_id ?? null },
          owner: ownerOf(a.owner_id), evidence_ids: a.evidence_ids, context_count: a.context_entity_ids.length };
      }),
    } : null,
    result: plan.state === 'approved' ? {
      pending: !plan.result, status: plan.result?.status ?? null, error: plan.result?.error?.message ?? null,
      approval: plan.result?.approval ? { actor: ownerOf(plan.result.approval.actor_id)!.name, recorded_at: plan.result.approval.recorded_at } : null,
      results: (plan.result?.results ?? []).map(x => ({ action_id: x.action_id, title: graph?.actions.find(a => a.action_id === x.action_id)?.title ?? x.action_id,
        status: x.status, display_id: x.native?.display_id ?? null, url: link(x.native), error: x.error?.message ?? null })),
    } : plan.state === 'rejected' ? { pending: false, status: 'rejected', error: null, approval: null, results: [] } : null,
    evidence: evidence ? { id: evidence.evidence_id, record: entity(evidence.entity_id)?.native?.display_id ?? evidence.source_ref.record_id,
      field: evidence.excerpt.field_path.split('.').at(-1) ?? evidence.excerpt.field_path, text: evidence.excerpt.text,
      event_at: evidence.original_event_at, coverage: evidence.coverage.replaceAll('_', ' '), path: evidence.source_ref.path } : null,
  };
}
