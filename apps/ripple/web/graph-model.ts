import type { graphData } from '../src/graph.ts';
export type EvidenceGraphData = ReturnType<typeof graphData>;
export type Camera = { x: number; y: number; scale: number };
export const cleanLabel = (text: string) => text.replace(/^\[Maple[^\]]*\]\s*/, '');

export function labelLines(text: string, limit = 29): string[] {
  const words = cleanLabel(text).split(/\s+/), lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line && `${line} ${word}`.length > limit) { lines.push(line); line = ''; }
    line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.slice(0, 2).map((l, i) => i === 1 && lines.length > 2 ? l.slice(0, limit - 1) + '…' : l);
}

export function zoomAt(camera: Camera, factor: number, point: { x: number; y: number }): Camera {
  const scale = Math.max(.2, Math.min(3, camera.scale * factor));
  const ratio = scale / camera.scale;
  return { scale, x: point.x - (point.x - camera.x) * ratio, y: point.y - (point.y - camera.y) * ratio };
}

export function fitCamera(nodes: EvidenceGraphData['nodes'], width: number, height: number): Camera {
  if (!nodes.length || !width || !height) return { x: 24, y: 24, scale: 1 };
  // Leave room for the curved connections between records in the same column.
  const left = Math.min(...nodes.map(n => n.x)) - 75, top = Math.min(...nodes.map(n => n.y)) - 40;
  const right = Math.max(...nodes.map(n => n.x)) + 242, bottom = Math.max(...nodes.map(n => n.y)) + 100;
  const scale = Math.min(1.35, (width - 48) / (right - left), (height - 48) / (bottom - top));
  return { scale, x: (width - (right - left) * scale) / 2 - left * scale,
    y: (height - (bottom - top) * scale) / 2 - top * scale };
}

export function neighborhood(graph: EvidenceGraphData, id: string | null): Set<string> {
  const ids = new Set<string>();
  if (!id) return ids;
  ids.add(id);
  const edge = graph.edges.find(e => e.id === id);
  if (edge) { ids.add(edge.from); ids.add(edge.to); }
  else for (const e of graph.edges) if (e.from === id || e.to === id) {
    ids.add(e.id); ids.add(e.from); ids.add(e.to);
  }
  return ids;
}

export function edgePath(from: EvidenceGraphData['nodes'][number], to: EvidenceGraphData['nodes'][number]) {
  const forward = from.x < to.x, same = from.x === to.x;
  const x1 = forward ? from.x + 230 : from.x, y1 = from.y + 40;
  const x2 = same || forward ? to.x : to.x + 230, y2 = to.y + 40;
  const bend = same ? -70 : forward ? 36 : -36;
  return `M${x1} ${y1} C${x1 + bend} ${y1} ${same ? x2 + bend : x2 - bend} ${y2} ${x2} ${y2}`;
}
