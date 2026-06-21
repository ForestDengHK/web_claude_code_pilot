#!/usr/bin/env node
// CodePilot Diagram Canvas — file-based MCP server.
// stdout is the MCP stdio transport; ALL logging goes to stderr.
// Source of truth = files under CODEPILOT_DIAGRAMS_DIR (one file per diagram + <id>.meta.json).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const log = (...a) => console.error('[canvas-mcp]', ...a);

// --- engine map -------------------------------------------------------------
const ENGINE_EXT = { excalidraw: 'excalidraw', drawio: 'drawio', mermaid: 'mmd' };
export function engineToExt(engine) {
  const ext = ENGINE_EXT[engine];
  if (!ext) throw new Error(`unknown engine: ${engine}`);
  return ext;
}

// --- pure ops engine (the heart; Phase 1 extracts this to canvas-store.ts) --
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

// --- file helpers -----------------------------------------------------------
function nano() { return Math.random().toString(36).slice(2, 10); } // POC id; Phase 1 uses nanoid
function metaPath(dir, id) { return path.join(dir, `${id}.meta.json`); }
function dataPath(dir, id, engine) { return path.join(dir, `${id}.${engineToExt(engine)}`); }

function safeId(id) {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`bad diagram id: ${id}`);
  return id;
}
function readMeta(dir, id) {
  return JSON.parse(fs.readFileSync(metaPath(dir, safeId(id)), 'utf8'));
}
function writeExcalidrawFile(p, elements) {
  fs.writeFileSync(p, JSON.stringify({ type: 'excalidraw', version: 2, source: 'codepilot', elements, appState: {} }, null, 2));
}
function readElements(dir, id, engine) {
  const raw = fs.readFileSync(dataPath(dir, id, engine), 'utf8');
  if (engine === 'excalidraw') return JSON.parse(raw).elements ?? [];
  return []; // drawio/mermaid: ops not supported (Phase 2); summary handled separately
}

export function createDiagram(dir, { id, engine, title, scene }) {
  fs.mkdirSync(dir, { recursive: true });
  const realId = id ? safeId(id) : nano();
  if (engine === 'excalidraw') {
    const elements = Array.isArray(scene) ? scene : (scene?.elements ?? []);
    writeExcalidrawFile(dataPath(dir, realId, engine), elements);
  } else {
    fs.writeFileSync(dataPath(dir, realId, engine), typeof scene === 'string' ? scene : String(scene ?? ''));
  }
  const meta = { id: realId, engine, title: title ?? realId, version: 1, updatedAt: new Date().toISOString() };
  fs.writeFileSync(metaPath(dir, realId), JSON.stringify(meta, null, 2));
  return { id: realId, version: 1 };
}

export function readDiagram(dir, id) {
  const meta = readMeta(dir, id);
  if (meta.engine === 'excalidraw') {
    const elements = readElements(dir, id, meta.engine);
    const summary = elements.map((e) => ({ id: e.id, type: e.type, text: e.text, x: e.x, y: e.y, w: e.width, h: e.height }));
    return { id: meta.id, engine: meta.engine, version: meta.version, elements: summary };
  }
  const text = fs.readFileSync(dataPath(dir, id, meta.engine), 'utf8');
  return { id: meta.id, engine: meta.engine, version: meta.version, source: text };
}

export function updateDiagram(dir, id, ops) {
  const meta = readMeta(dir, id);
  if (meta.engine !== 'excalidraw') throw new Error(`canvas_update ops only support excalidraw (Phase 2 for ${meta.engine}); use canvas_create to replace`);
  const current = readElements(dir, id, meta.engine);
  const { elements, applied, warnings } = applyOps(current, ops);
  writeExcalidrawFile(dataPath(dir, id, meta.engine), elements);
  meta.version += 1;
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
      try { elementCount = meta.engine === 'excalidraw' ? readElements(dir, meta.id, meta.engine).length : 0; } catch { /* ignore */ }
      return { id: meta.id, title: meta.title, engine: meta.engine, version: meta.version, elementCount, updatedAt: meta.updatedAt };
    });
}

// --- MCP wiring -------------------------------------------------------------
const asText = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

export function buildServer(diagramsDir) {
  const mcp = new Server({ name: 'codepilot-canvas', version: '0.0.1' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'canvas_list', description: 'List diagrams in the current session.', inputSchema: { type: 'object', properties: {} } },
      { name: 'canvas_read', description: 'Read a diagram\'s element summary (excalidraw) or source (drawio/mermaid).', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'canvas_create', description: 'Create or fully replace a diagram. engine: excalidraw|drawio|mermaid. For mermaid/drawio, pass scene as the source string; use this (not canvas_update) to change them.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, engine: { type: 'string' }, title: { type: 'string' }, scene: {} }, required: ['engine', 'scene'] } },
      { name: 'canvas_update', description: 'Incrementally patch an excalidraw diagram. ops: {add:[Element], update:[{id,...partial}], delete:[id]}. Bad ids return as warnings.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, ops: { type: 'object' } }, required: ['id', 'ops'] } },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = req.params.arguments ?? {};
    try {
      switch (req.params.name) {
        case 'canvas_list': return asText(listDiagrams(diagramsDir));
        case 'canvas_read': return asText(readDiagram(diagramsDir, a.id));
        case 'canvas_create': return asText(createDiagram(diagramsDir, a));
        case 'canvas_update': return asText(updateDiagram(diagramsDir, a.id, a.ops ?? {}));
        default: throw new Error(`unknown tool: ${req.params.name}`);
      }
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: String(e?.message ?? e) }] };
    }
  });
  return mcp;
}

// --- connect to stdio ONLY when run directly (so the test can import safely) -
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.env.CODEPILOT_DIAGRAMS_DIR;
  if (!dir) { log('FATAL: CODEPILOT_DIAGRAMS_DIR not set'); process.exit(1); }
  const mcp = buildServer(dir);
  await mcp.connect(new StdioServerTransport());
  log('MCP connected; diagrams dir =', dir);
}
