import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './testing.ts';
import { graphData } from './graph.ts';
import { renderBrief, initialState } from './ui.ts';
import { fitCamera, zoomAt, neighborhood } from '../web/graph-model.ts';

test('zoom preserves the world point under the cursor and does not shift at the scale limit', () => {
  const before = { x: 30, y: -40, scale: .7 }, cursor = { x: 270, y: 180 };
  const after = zoomAt(before, 1.4, cursor);
  assert.ok(Math.abs((cursor.x - before.x) / before.scale - (cursor.x - after.x) / after.scale) < 1e-9);
  assert.ok(Math.abs((cursor.y - before.y) / before.scale - (cursor.y - after.y) / after.scale) < 1e-9);
  const limit = { x: 20, y: 40, scale: 3 };
  assert.deepEqual(zoomAt(limit, 2, cursor), limit);
});

test('fit contains every record and direct neighbors include selectable relationships', () => {
  const graph = graphData(fixture(), { mode: 'context', selected: null, evidenceId: null });
  const camera = fitCamera(graph.nodes, 780, 460);
  for (const n of graph.nodes) {
    assert.ok(n.x * camera.scale + camera.x >= 0);
    assert.ok((n.x + 230) * camera.scale + camera.x <= 780);
    assert.ok(n.y * camera.scale + camera.y >= 0);
    assert.ok((n.y + 80) * camera.scale + camera.y <= 460);
  }
  const edge = graph.edges[0]!;
  const neighbors = neighborhood(graph, edge.from);
  assert.ok(neighbors.has(edge.id)); assert.ok(neighbors.has(edge.to));
  assert.deepEqual(neighborhood(graph, edge.id), new Set([edge.id, edge.from, edge.to]));
});

test('proposed work links every cited context record and new connections retain source citations', () => {
  const response = fixture();
  const graph = graphData(response, { mode: 'work', selected: null, evidenceId: null });
  for (const a of response.action_graph!.actions) {
    for (const id of new Set([a.part_entity_id, ...a.context_entity_ids])) {
      const edge = graph.edges.find(e => e.from === id && e.to === a.action_id)!;
      assert.ok(edge, `Missing cited context ${id}`);
      assert.deepEqual(edge.evidenceIds, a.evidence_ids);
    }
  }
  const edge = graph.edges.find(e => e.id.startsWith('context-'))!;
  const state = initialState('test-workspace', 'test-actor', 'ISS-42');
  state.view = { mode: 'work', selected: edge.id, evidenceId: null };
  const rendered = JSON.stringify(renderBrief({ state, signedState: 'test', response }));
  assert.ok(rendered.includes(edge.statement));
  for (const id of edge.evidenceIds) assert.ok(rendered.includes(id));
});
