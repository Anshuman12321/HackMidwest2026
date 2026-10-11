import sharp from 'sharp';
import type { InvestigationResponse } from '../../../contracts/investigation.ts';
import type { View } from './types.ts';
export const escapeXml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]!));
type Node = { id: string; label: string; kind: string; subtitle: string; column: number; x: number; y: number };
type Edge = { id: string; from: string; to: string; inference: boolean; planned: boolean };
export function graphData(response: InvestigationResponse, view: View) {
  const entities = response.context_bundle.entities;
  const contextNodes = entities;
  const nodes: Node[] = contextNodes.map(e => ({ id: e.entity_id, label: e.label, kind: e.kind,
    subtitle: e.native?.display_id ?? e.source_ref?.record_id ?? e.kind,
    column: ['account', 'opportunity', 'person'].includes(e.kind) ? 2 : e.kind === 'ticket' ? 1 : 0, x: 0, y: 0 }));
  const edges: Edge[] = response.context_bundle.relationships.map(r => ({ id: r.relationship_id, from: r.from_entity_id,
    to: r.to_entity_id, inference: r.basis === 'inference', planned: false }));
  if (view.mode === 'work') {
    // Work mode focuses on proposed tickets and the context they explicitly cite.
    const used = new Set(response.action_graph?.actions.flatMap(a => [a.part_entity_id, ...a.context_entity_ids]) ?? []);
    nodes.splice(0, nodes.length, ...nodes.filter(n => used.has(n.id)).map(n => ({ ...n, column: 0 })));
    edges.splice(0, edges.length);
    for (const a of response.action_graph?.actions ?? []) {
      nodes.push({ id: a.action_id, label: a.title, kind: 'proposed', subtitle: 'Proposed internal ticket', column: 1, x: 0, y: 0 });
      edges.push({ id: `plan-${a.action_id}`, from: a.part_entity_id, to: a.action_id, inference: false, planned: true });
    }
    (response.action_graph?.dependencies ?? []).forEach((d, i) => edges.push({ id: `dependency-${i}`,
      from: d.prerequisite_action_id, to: d.dependent_action_id, inference: true, planned: true }));
  }
  const counts = [0, 0, 0];
  nodes.forEach(n => { n.x = 35 + n.column * 295; n.y = 64 + counts[n.column]! * 108; counts[n.column] = counts[n.column]! + 1; });
  return { nodes, edges: edges.filter(e => nodes.some(n => n.id === e.from) && nodes.some(n => n.id === e.to)),
    width: 900, height: Math.max(330, Math.max(...counts) * 108 + 90) };
}
function wrap(text: string): string[] {
  const words = text.replace(/^\[Maple[^\]]*\]\s*/, '').split(/\s+/), lines: string[] = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).length > 27 && line) { lines.push(line); line = ''; }
    line += (line ? ' ' : '') + word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 2).map((l, i) => i === 1 && lines.length > 2 ? l.slice(0, 24) + '…' : l);
}
export function graphSvg(response: InvestigationResponse, view: View): string {
  const { nodes, edges, width, height } = graphData(response, view);
  const byId = new Map(nodes.map(n => [n.id, n]));
  const selectedRelation = edges.find(e => e.id === view.selected);
  const line = edges.map(e => {
    const a = byId.get(e.from)!, b = byId.get(e.to)!;
    const active = e.id === view.selected || [e.from, e.to].includes(view.selected ?? '');
    const forward = a.x < b.x, same = a.x === b.x;
    const ax = forward ? a.x + 230 : a.x, ay = a.y + 38, bx = same || forward ? b.x : b.x + 230, by = b.y + 38;
    const bend = same ? -24 : forward ? 30 : -30;
    return `<path d="M${ax},${ay} C${ax + bend},${ay} ${same ? bx + bend : bx - bend},${by} ${bx},${by}" fill="none" stroke="${active ? '#161616' : '#c3c6c9'}" stroke-width="${active ? 3 : 1.7}"${e.inference || e.planned ? ' stroke-dasharray="6 5"' : ''}/>`;
  }).join('');
  const cards = nodes.map(n => {
    const selected = n.id === view.selected || selectedRelation?.from === n.id || selectedRelation?.to === n.id;
    const fill = n.kind === 'proposed' ? '#fff9cf' : selected ? '#fffde7' : '#fff';
    const badge = n.kind === 'account' ? '#2456c8' : n.kind === 'proposed' ? '#665600' : '#737373';
    return `<g><rect x="${n.x}" y="${n.y}" width="230" height="80" rx="10" fill="${fill}" stroke="${selected ? '#161616' : '#e0e2e4'}" stroke-width="${selected ? 2 : 1}"/>
      <text x="${n.x + 13}" y="${n.y + 19}" font-size="10" fill="${badge}" letter-spacing=".5">${escapeXml(n.subtitle)}</text>
      ${wrap(n.label).map((label, i) => `<text x="${n.x + 13}" y="${n.y + 40 + i * 16}" font-size="12" fill="#161616">${escapeXml(label)}</text>`).join('')}</g>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#fafafa"/><g font-family="Arial, sans-serif">
    <text x="35" y="29" font-size="11" fill="#737373">${view.mode === 'context' ? 'ISSUE &amp; PRODUCT CONTEXT' : 'EXISTING CONTEXT'}</text>
    <text x="330" y="29" font-size="11" fill="#737373">${view.mode === 'context' ? 'CUSTOMER REPORTS' : 'PROPOSED EXECUTION'}</text>
    ${view.mode === 'context' ? '<text x="625" y="29" font-size="11" fill="#737373">ACCOUNTS</text>' : ''}
    ${line}${cards}<text x="35" y="${height - 18}" font-size="10" fill="#737373">${view.mode === 'context' ? 'Solid: documented relationship · Dashed: inference' : 'Dashed: proposed context / investigation order · Native dependency links are not created'}</text></g></svg>`;
}
export async function graphPng(response: InvestigationResponse, view: View): Promise<Buffer> {
  return sharp(Buffer.from(graphSvg(response, view))).png().toBuffer();
}
