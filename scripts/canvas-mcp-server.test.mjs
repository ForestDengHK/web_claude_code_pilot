import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyOps, engineToExt, createDiagram, readDiagram, updateDiagram, listDiagrams } from './canvas-mcp-server.mjs';

test('applyOps: add appends new elements', () => {
  const { elements, applied, warnings } = applyOps([], { add: [{ id: 'a', type: 'rectangle' }] });
  assert.equal(elements.length, 1);
  assert.deepEqual(applied, { added: 1, updated: 0, deleted: 0 });
  assert.deepEqual(warnings, []);
});

test('applyOps: update shallow-merges by id', () => {
  const start = [{ id: 'a', type: 'rectangle', x: 0, text: 'hi' }];
  const { elements } = applyOps(start, { update: [{ id: 'a', x: 50 }] });
  assert.deepEqual(elements[0], { id: 'a', type: 'rectangle', x: 50, text: 'hi' });
});

test('applyOps: delete removes by id', () => {
  const start = [{ id: 'a' }, { id: 'b' }];
  const { elements, applied } = applyOps(start, { delete: ['a'] });
  assert.deepEqual(elements.map((e) => e.id), ['b']);
  assert.equal(applied.deleted, 1);
});

test('applyOps: bad ids go to warnings, not throw', () => {
  const { applied, warnings } = applyOps([{ id: 'a' }], {
    add: [{ id: 'a', type: 'x' }],
    update: [{ id: 'zzz', x: 1 }],
    delete: ['nope'],
  });
  assert.equal(applied.added, 0);
  assert.equal(warnings.length, 3);
});

test('engineToExt maps the three engines', () => {
  assert.equal(engineToExt('excalidraw'), 'excalidraw');
  assert.equal(engineToExt('drawio'), 'drawio');
  assert.equal(engineToExt('mermaid'), 'mmd');
});

test('file round-trip: create -> read -> update -> list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-poc-'));
  const { id, version } = createDiagram(dir, {
    engine: 'excalidraw', title: 'T',
    scene: { elements: [{ id: 'r1', type: 'rectangle', x: 0, y: 0 }] },
  });
  assert.equal(version, 1);
  assert.ok(fs.existsSync(path.join(dir, `${id}.excalidraw`)));

  const read = readDiagram(dir, id);
  assert.equal(read.engine, 'excalidraw');
  assert.deepEqual(read.elements.map((e) => e.id), ['r1']);

  const upd = updateDiagram(dir, id, { add: [{ id: 'r2', type: 'ellipse' }], update: [{ id: 'r1', x: 9 }] });
  assert.equal(upd.version, 2);
  assert.deepEqual(upd.applied, { added: 1, updated: 1, deleted: 0 });

  const after = readDiagram(dir, id);
  assert.deepEqual(after.elements.map((e) => e.id).sort(), ['r1', 'r2']);
  assert.equal(after.elements.find((e) => e.id === 'r1').x, 9);

  const list = listDiagrams(dir);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].version, 2);
  assert.equal(list[0].elementCount, 2);

  fs.rmSync(dir, { recursive: true, force: true });
});
