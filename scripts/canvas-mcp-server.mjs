#!/usr/bin/env node
// CodePilot Diagram Canvas — file-based MCP server.
// stdout is the MCP stdio transport; ALL logging goes to stderr.
// Source of truth = files under CODEPILOT_DIAGRAMS_DIR (one file per diagram + <id>.meta.json).
// Pure ops + file IO live in src/lib/canvas-core.mjs (shared with the Next-side store).
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  applyOps, engineToExt, createDiagram, readDiagram, updateDiagram, listDiagrams, coerceElements,
} from '../src/lib/canvas-core.mjs';

// Re-export the core helpers so the existing test (scripts/canvas-mcp-server.test.mjs) keeps importing from here.
export { applyOps, engineToExt, createDiagram, readDiagram, updateDiagram, listDiagrams, coerceElements };

const log = (...a) => console.error('[canvas-mcp]', ...a);
const asText = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

export function buildServer(diagramsDir) {
  const sessionId = process.env.CODEPILOT_SESSION_ID || '';
  const mcp = new Server({ name: 'codepilot-canvas', version: '0.0.1' }, { capabilities: { tools: {} } });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'canvas_list', description: 'List the diagram canvases that exist in THIS conversation (id, title, engine, version, elementCount). ALWAYS call this FIRST when the user refers to "the canvas"/"this diagram" or asks to edit/change a drawing — to find the real id. Do NOT invent ids or create a new canvas if one already exists.', inputSchema: { type: 'object', properties: {} } },
      { name: 'canvas_read', description: 'Read a canvas before editing it: returns the excalidraw element summary, or the full source for drawio (mxGraph XML) / mermaid. Use the id from canvas_list.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'canvas_create', description: 'Create a NEW canvas, OR fully replace an existing one by passing its id (version is preserved/continued so the user\'s open canvas updates live). engine: excalidraw|drawio|mermaid. scene: excalidraw → {elements:[...]}; drawio → mxGraph XML string; mermaid → mermaid source string. To edit an existing drawio/mermaid canvas: canvas_read it, modify the source, then canvas_create with the SAME id.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, engine: { type: 'string' }, title: { type: 'string' }, scene: {} }, required: ['engine', 'scene'] } },
      { name: 'canvas_update', description: 'Incrementally patch an EXISTING excalidraw canvas (use its id from canvas_list). ops: {add:[Element], update:[{id,...partial}], delete:[id]}. Preferred over canvas_create for excalidraw edits. Bad ids return as warnings. (For drawio/mermaid use canvas_create with the same id instead.)', inputSchema: { type: 'object', properties: { id: { type: 'string' }, ops: { type: 'object' } }, required: ['id', 'ops'] } },
    ],
  }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const a = req.params.arguments ?? {};
    try {
      switch (req.params.name) {
        case 'canvas_list': return asText(listDiagrams(diagramsDir, sessionId));
        case 'canvas_read': return asText(readDiagram(diagramsDir, a.id));
        case 'canvas_create': return asText(createDiagram(diagramsDir, { ...a, sessionId: a.sessionId ?? process.env.CODEPILOT_SESSION_ID ?? '' }));
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
