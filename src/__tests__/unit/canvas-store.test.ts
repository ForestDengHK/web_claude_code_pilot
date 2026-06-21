import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Point DB + diagrams dir at a throwaway location BEFORE importing the store.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-store-'));
process.env.CLAUDE_GUI_DATA_DIR = TMP;

let store: typeof import('../../lib/canvas-store');

before(async () => {
  store = await import('../../lib/canvas-store');
});

test('createCanvas writes file + DB rows', () => {
  const { id, version } = store.createCanvas({ sessionId: 's1', engine: 'excalidraw', title: 'Arch', scene: { elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 10, height: 10 }] } });
  assert.equal(version, 1);
  assert.ok(fs.existsSync(path.join(TMP, 'diagrams', `${id}.excalidraw`)));

  const scene = store.getScene(id);
  assert.equal(scene.engine, 'excalidraw');
  assert.deepEqual(scene.elements.map((e) => e.id), ['a']);

  const list = store.listCanvases('s1');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].version, 1);
});

test('saveScene (user) bumps version + reflects in getScene', () => {
  const { id } = store.createCanvas({ sessionId: 's2', engine: 'excalidraw', scene: { elements: [] } });
  const res = store.saveScene(id, [{ id: 'x', type: 'ellipse', x: 1, y: 2, width: 3, height: 4 }], 'user');
  assert.equal(res.version, 2);
  assert.deepEqual(store.getScene(id).elements.map((e) => e.id), ['x']);
});

test('applyCanvasOps (claude) patches incrementally', () => {
  const { id } = store.createCanvas({ sessionId: 's3', engine: 'excalidraw', scene: { elements: [{ id: 'k1', type: 'rectangle' }] } });
  const res = store.applyCanvasOps(id, { add: [{ id: 'k2', type: 'arrow' }], update: [{ id: 'k1', x: 99 }] }, 'claude');
  assert.equal(res.version, 2);
  assert.deepEqual(res.applied, { added: 1, updated: 1, deleted: 0 });
  const ids = store.getScene(id).elements.map((e) => e.id).sort();
  assert.deepEqual(ids, ['k1', 'k2']);
});

test('mermaid/drawio: createCanvas + saveSource round-trip via source', () => {
  const m = store.createCanvas({ sessionId: 's4', engine: 'mermaid', title: 'M', scene: 'graph TD\n A-->B' });
  let scene = store.getScene(m.id);
  assert.equal(scene.engine, 'mermaid');
  assert.match(scene.source ?? '', /A-->B/);
  const r = store.saveSource(m.id, 'graph LR\n X-->Y', 'user');
  assert.equal(r.version, 2);
  assert.match(store.getScene(m.id).source ?? '', /X-->Y/);

  const d = store.createCanvas({ sessionId: 's4', engine: 'drawio', title: 'D', scene: '<mxGraphModel></mxGraphModel>' });
  assert.match(store.getScene(d.id).source ?? '', /mxGraphModel/);
});

test('reconcileFromMeta indexes an externally-written file', () => {
  // simulate the MCP server (out-of-process) creating a diagram by writing files directly
  const dir = path.join(TMP, 'diagrams');
  const id = 'extdiagram1';
  fs.writeFileSync(path.join(dir, `${id}.excalidraw`), JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'e1' }] }));
  fs.writeFileSync(path.join(dir, `${id}.meta.json`), JSON.stringify({ id, engine: 'excalidraw', title: 'ext', version: 1, lastAuthor: 'claude', updatedAt: new Date().toISOString() }));
  const res = store.reconcileFromMeta(id);
  assert.equal(res?.id, id);
  assert.equal(res?.version, 1);
});

test('listCanvases filters by session', () => {
  const all = store.listCanvases();
  assert.ok(all.length >= 3);
  const s1 = store.listCanvases('s1');
  assert.ok(s1.every((d) => typeof d.id === 'string'));
});
