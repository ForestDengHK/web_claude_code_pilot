// CodePilot Diagram Canvas — shared pure core (ops engine + file IO).
// NO database, NO MCP, NO Next imports here — this module is imported by BOTH
// the standalone MCP server (scripts/canvas-mcp-server.mjs) and the Next-side
// store (src/lib/canvas-store.ts), so it must stay dependency-free.
import fs from 'node:fs';
import path from 'node:path';

// --- engine map -------------------------------------------------------------
export const ENGINE_EXT = { excalidraw: 'excalidraw', drawio: 'drawio', mermaid: 'mmd' };
export function engineToExt(engine) {
  const ext = ENGINE_EXT[engine];
  if (!ext) throw new Error(`unknown engine: ${engine}`);
  return ext;
}

// --- pure ops engine --------------------------------------------------------
// Applies add/update/delete to a flat element array (Excalidraw elements).
// Bad ids become warnings, never throw.
export function applyOps(elements, ops) {
  const warnings = [];
  const byId = new Map(elements.map((e) => [e.id, e]));
  let added = 0, updated = 0, deleted = 0;
  for (const el of ops.add ?? []) {
    if (byId.has(el.id)) { warnings.push(`add: id ${el.id} already exists, skipped`); continue; }
    byId.set(el.id, el); added++;
  }
  for (const patch of ops.update ?? []) {
    const cur = byId.get(patch.id);
    if (!cur) { warnings.push(`update: id ${patch.id} not found`); continue; }
    byId.set(patch.id, { ...cur, ...patch }); updated++;
  }
  for (const id of ops.delete ?? []) {
    if (!byId.has(id)) { warnings.push(`delete: id ${id} not found`); continue; }
    byId.delete(id); deleted++;
  }
  return { elements: [...byId.values()], applied: { added, updated, deleted }, warnings };
}

// --- ids / paths ------------------------------------------------------------
export function safeId(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`bad diagram id: ${id}`);
  return id;
}
export function genId() {
  return 'd' + Math.random().toString(36).slice(2, 10);
}
function metaPath(dir, id) { return path.join(dir, `${safeId(id)}.meta.json`); }
function dataPath(dir, id, engine) { return path.join(dir, `${safeId(id)}.${engineToExt(engine)}`); }

// --- file IO ----------------------------------------------------------------
function writeExcalidrawFile(p, elements) {
  fs.writeFileSync(p, JSON.stringify({ type: 'excalidraw', version: 2, source: 'codepilot', elements, appState: {} }, null, 2));
}
export function readMeta(dir, id) {
  return JSON.parse(fs.readFileSync(metaPath(dir, id), 'utf8'));
}
export function readElements(dir, id, engine) {
  const raw = fs.readFileSync(dataPath(dir, id, engine), 'utf8');
  if (engine === 'excalidraw') return JSON.parse(raw).elements ?? [];
  return []; // drawio/mermaid carry source text, not element arrays
}
export function readRawData(dir, id, engine) {
  return fs.readFileSync(dataPath(dir, id, engine), 'utf8');
}

// Coerce a model-supplied scene into an element array. Tolerates: an array, an
// object {elements:[...]}, or a JSON string of either (LLMs often stringify args).
export function coerceElements(scene) {
  let s = scene;
  if (typeof s === 'string') { try { s = JSON.parse(s); } catch { return []; } }
  if (Array.isArray(s)) return s;
  if (Array.isArray(s?.elements)) return s.elements;
  return [];
}

export function createDiagram(dir, { id, engine, title, scene, author = 'user' }) {
  fs.mkdirSync(dir, { recursive: true });
  const realId = id ? safeId(id) : genId();
  if (engine === 'excalidraw') {
    const elements = coerceElements(scene);
    writeExcalidrawFile(dataPath(dir, realId, engine), elements);
  } else {
    fs.writeFileSync(dataPath(dir, realId, engine), typeof scene === 'string' ? scene : String(scene ?? ''));
  }
  const meta = { id: realId, engine, title: title ?? realId, version: 1, lastAuthor: author, updatedAt: new Date().toISOString() };
  fs.writeFileSync(metaPath(dir, realId), JSON.stringify(meta, null, 2));
  return { id: realId, version: 1 };
}

// Replace the full Excalidraw scene (used by the user-draw save path).
export function writeScene(dir, id, elements, author = 'user') {
  const meta = readMeta(dir, id);
  if (meta.engine !== 'excalidraw') throw new Error(`writeScene only supports excalidraw (got ${meta.engine})`);
  writeExcalidrawFile(dataPath(dir, id, meta.engine), elements);
  meta.version += 1;
  meta.lastAuthor = author;
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(metaPath(dir, id), JSON.stringify(meta, null, 2));
  return { id: meta.id, version: meta.version, count: elements.length };
}

export function readDiagram(dir, id) {
  const meta = readMeta(dir, id);
  if (meta.engine === 'excalidraw') {
    const elements = readElements(dir, id, meta.engine);
    // NOTE: summary abbreviates Excalidraw-native width/height to w/h. The adapter
    // maps w/h back to width/height when turning model ops.update into element patches.
    const summary = elements.map((e) => ({ id: e.id, type: e.type, text: e.text, x: e.x, y: e.y, w: e.width, h: e.height }));
    return { id: meta.id, engine: meta.engine, version: meta.version, elements: summary };
  }
  return { id: meta.id, engine: meta.engine, version: meta.version, source: readRawData(dir, id, meta.engine) };
}

export function updateDiagram(dir, id, ops, author = 'claude') {
  const meta = readMeta(dir, id);
  if (meta.engine !== 'excalidraw') throw new Error(`canvas_update ops only support excalidraw (Phase 2 for ${meta.engine}); use canvas_create to replace`);
  const current = readElements(dir, id, meta.engine);
  const { elements, applied, warnings } = applyOps(current, ops);
  writeExcalidrawFile(dataPath(dir, id, meta.engine), elements);
  meta.version += 1;
  meta.lastAuthor = author;
  meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(metaPath(dir, id), JSON.stringify(meta, null, 2));
  return { id: meta.id, version: meta.version, applied, warnings };
}

export function listDiagrams(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.meta.json'))
    .map((f) => {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      let elementCount = 0;
      try { elementCount = meta.engine === 'excalidraw' ? readElements(dir, safeId(meta.id), meta.engine).length : 0; } catch { /* ignore */ }
      return { id: meta.id, title: meta.title, engine: meta.engine, version: meta.version, elementCount, updatedAt: meta.updatedAt };
    });
}
