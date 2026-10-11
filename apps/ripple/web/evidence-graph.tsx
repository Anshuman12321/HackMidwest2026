import React, { useEffect, useMemo, useRef, useState } from 'react';
import { cleanLabel, labelLines, zoomAt, fitCamera, neighborhood, edgePath, type Camera, type EvidenceGraphData } from './graph-model.ts';

type Props = { graph: EvidenceGraphData; mode: string; busy: boolean; selected: string | null;
  onSelect: (id: string | null) => void; onMode: (mode: string) => void; onExpand?: () => void;
  renderEvidence: (ids: string[]) => React.ReactNode; evidence: React.ReactNode };
const kindNames: Record<string, string> = { issue: 'Issue', ticket: 'Customer report', account: 'Account', article: 'Reference guide',
  product: 'Product', capability: 'Capability', feature: 'Feature', proposed: 'Proposed ticket' };

export function EvidenceGraph({ graph, mode, busy, selected, onSelect, onMode, onExpand, renderEvidence, evidence }: Props) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [camera, setCamera] = useState<Camera>({ x: 0, y: 0, scale: 1 });
  const [size, setSize] = useState({ width: 800, height: 460 });
  const canvas = useRef<HTMLDivElement>(null);
  const cameraRef = useRef(camera); cameraRef.current = camera;
  const drag = useRef<{ x: number; y: number; camera: Camera } | null>(null);
  const nearby = useMemo(() => neighborhood(graph, selected), [graph, selected]);
  const shownNodes = graph.nodes.filter(n => !focused || !selected || nearby.has(n.id));
  const shownIds = new Set(shownNodes.map(n => n.id));
  const shownEdges = graph.edges.filter(e => shownIds.has(e.from) && shownIds.has(e.to));
  const node = graph.nodes.find(n => n.id === selected);
  const edge = graph.edges.find(e => e.id === selected);
  const matches = graph.nodes.filter(n => `${n.label} ${n.subtitle} ${n.sourceId ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  const matchIds = new Set(matches.map(n => n.id));
  const layoutKey = graph.nodes.map(n => `${n.id}:${n.x}:${n.y}`).join('|');
  const fit = () => setCamera(fitCamera(shownNodes, size.width, size.height));

  useEffect(() => {
    if (!canvas.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(canvas.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { fit(); }, [size.width, size.height, layoutKey, focused]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      setCamera(value => zoomAt(value, Math.exp(-event.deltaY * .002), { x: event.clientX - rect.left, y: event.clientY - rect.top }));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  function zoom(factor: number) { setCamera(value => zoomAt(value, factor, { x: size.width / 2, y: size.height / 2 })); }
  function select(id: string) { onSelect(id); }
  function reveal(id: string) {
    setFocused(false); onSelect(id); setQuery('');
    const target = graph.nodes.find(n => n.id === id);
    if (target) setCamera(value => ({ scale: Math.max(value.scale, 1),
      x: size.width / 2 - (target.x + 115) * Math.max(value.scale, 1),
      y: size.height / 2 - (target.y + 40) * Math.max(value.scale, 1) }));
  }
  function activate(event: React.KeyboardEvent, id: string) {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); select(id); }
  }

  return <div className="evidence-explorer">
    <div className="explorer-toolbar">
      <label className="explorer-search"><span>⌕</span><input aria-label="Search graph records" placeholder="Search ID, customer, or topic…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button aria-label="Clear graph search" onClick={() => setQuery('')}>×</button>}</label>
      <select aria-label="Graph view" disabled={busy} value={mode} onChange={e => onMode(e.target.value)}><option value="context">Evidence context</option><option value="work">Proposed work</option></select>
      {onExpand && <button onClick={onExpand}>Expand ↗</button>}
    </div>
    {query && <div className="explorer-results" role="region" aria-label="Graph search results">{matches.length ? matches.map(n => <button key={n.id} onClick={() => reveal(n.id)}><b>{n.subtitle}</b> {cleanLabel(n.label)}</button>) : <p>No records match “{query}”.</p>}</div>}
    <div className={`explorer-body ${selected ? 'has-selection' : ''}`}>
      <div className="explorer-canvas" ref={canvas} tabIndex={0} aria-label="Graph canvas. Drag to pan, scroll to zoom. Arrow keys pan; plus and minus zoom."
        onKeyDown={e => {
          if (e.target !== e.currentTarget) return;
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', '0'].includes(e.key)) e.preventDefault();
          if (e.key === '+' || e.key === '=') zoom(1.2);
          else if (e.key === '-') zoom(1 / 1.2);
          else if (e.key === '0') fit();
          else if (e.key.startsWith('Arrow')) setCamera(c => ({ ...c, x: c.x + (e.key === 'ArrowLeft' ? 40 : e.key === 'ArrowRight' ? -40 : 0), y: c.y + (e.key === 'ArrowUp' ? 40 : e.key === 'ArrowDown' ? -40 : 0) }));
        }}
        onPointerDown={e => {
          if (e.button !== 0 || (e.target as Element).closest('[data-graph-item], button')) return;
          drag.current = { x: e.clientX, y: e.clientY, camera: cameraRef.current }; e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={e => { if (drag.current) setCamera({ ...drag.current.camera, x: drag.current.camera.x + e.clientX - drag.current.x, y: drag.current.camera.y + e.clientY - drag.current.y }); }}
        onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}>
        <svg className="explorer-svg" viewBox={`0 0 ${size.width} ${size.height}`} aria-label="Interactive evidence map">
          <g transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
            {graph.columns.map(c => <text className="explorer-column" key={c.index} x={35 + c.index * 295} y={34}>{c.label}</text>)}
            {shownEdges.map(e => {
              const from = graph.nodes.find(n => n.id === e.from)!, to = graph.nodes.find(n => n.id === e.to)!;
              const active = nearby.has(e.id), dim = Boolean(selected && !active) || Boolean(query && !matchIds.has(e.from) && !matchIds.has(e.to));
              return <g key={e.id} data-graph-item className={`explorer-edge ${active ? 'active' : ''} ${dim ? 'dim' : ''}`} role="button" tabIndex={0}
                aria-label={`Inspect connection ${from.subtitle} to ${to.subtitle}`} aria-pressed={selected === e.id} onClick={() => select(e.id)} onKeyDown={event => activate(event, e.id)}>
                <title>{e.statement}</title><path className="connection-line" d={edgePath(from, to)} strokeDasharray={e.inference || e.planned ? '6 5' : undefined} />
                <path className="connection-hit" d={edgePath(from, to)} />
              </g>;
            })}
            {shownNodes.map(n => <g data-graph-item key={n.id} transform={`translate(${n.x} ${n.y})`} role="button" tabIndex={0} aria-label={`${n.subtitle}: ${cleanLabel(n.label)}`}
              aria-pressed={selected === n.id} className={`explorer-node kind-${n.kind} ${selected === n.id ? 'selected' : ''} ${nearby.has(n.id) ? 'connected' : ''} ${selected && !nearby.has(n.id) || query && !matchIds.has(n.id) ? 'dim' : ''}`}
              onClick={() => select(n.id)} onKeyDown={e => activate(e, n.id)}>
              <title>{`${n.subtitle} · ${n.label}`}</title><rect width="230" height="80" rx="10" />
              <rect className="kind-stripe" width="4" height="48" y="16" rx="2" />
              <text className="explorer-node-id" x="14" y="21">{n.subtitle}</text>
              {labelLines(n.label).map((line, i) => <text className="explorer-node-label" key={i} x="14" y={42 + i * 16}>{line}</text>)}
            </g>)}
          </g>
        </svg>
        {!shownNodes.length && <div className="explorer-empty">No records in this view.</div>}
        <div className="explorer-controls"><button aria-label="Zoom out" onClick={() => zoom(1 / 1.2)}>−</button><output aria-label="Graph zoom">{Math.round(camera.scale * 100)}%</output><button aria-label="Zoom in" onClick={() => zoom(1.2)}>＋</button><button onClick={fit}>Fit</button></div>
        <div className="explorer-legend"><span className="solid-line" />Documented <span className="dashed-line" />{mode === 'work' ? 'Proposed' : 'Inference'}<span>Drag to pan · Scroll to zoom</span></div>
      </div>
      {selected && <aside className="explorer-inspector" aria-label="Selected graph item">
        <div className="inspector-heading"><span className="eyebrow">{edge ? 'RELATIONSHIP' : kindNames[node?.kind ?? ''] ?? 'RECORD'}</span><button onClick={() => { onSelect(null); setFocused(false); }} aria-label="Clear graph selection">×</button></div>
        {node && <><span className="inspector-id">{node.subtitle}</span><h3>{cleanLabel(node.label)}</h3>{node.sourceId && <p className="inspector-source">Imported source: {node.sourceId}</p>}{node.url && <a href={node.url} target="_blank" rel="noreferrer">Open in DevRev ↗</a>}</>}
        {edge && <><h3>{graph.nodes.find(n => n.id === edge.from)?.subtitle} → {graph.nodes.find(n => n.id === edge.to)?.subtitle}</h3><span className={`basis-pill ${edge.inference ? 'inferred' : ''}`}>{edge.basis.replaceAll('_', ' ')}</span><p>{edge.statement}</p></>}
        <button className="focus-connections" aria-pressed={focused} onClick={() => setFocused(v => !v)}>{focused ? 'Show all records' : 'Focus connections'}</button>
        {node && <div className="inspector-connections"><span className="eyebrow">{graph.edges.filter(e => e.from === node.id || e.to === node.id).length} CONNECTIONS</span>{graph.edges.filter(e => e.from === node.id || e.to === node.id).map(e => <button key={e.id} onClick={() => select(e.id)}><b>{graph.nodes.find(n => n.id === (e.from === node.id ? e.to : e.from))?.subtitle}</b><span>{e.statement}</span><i>↗</i></button>)}</div>}
        <div className="inspector-evidence"><span className="eyebrow">SOURCE EVIDENCE</span>{renderEvidence(node?.evidenceIds ?? edge?.evidenceIds ?? [])}{!(node?.evidenceIds.length || edge?.evidenceIds.length) && <p>No excerpt attached to this item.</p>}{evidence}</div>
      </aside>}
    </div>
    <div className="explorer-caption"><span>{shownNodes.length} records · {shownEdges.length} connections</span><span>Click a record or connection to inspect its evidence</span></div>
  </div>;
}
