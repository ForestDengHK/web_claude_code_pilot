#!/usr/bin/env node
/**
 * POC: prove (1) the canvas MCP server answers an MCP client over stdio, and
 *      (2) document/drive Codex app-server loading the same server.
 * Standalone (open/closed) — nothing here is wired into the Next app.
 *
 *   node scripts/poc-codex-mcp-canvas.mjs            # self-test (no Codex)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ok = (m) => console.log(`✔ ${m}`);
const fail = (m, e) => { console.error(`x ${m}:`, e?.message || e); process.exitCode = 1; };

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-codex-poc-'));
  const serverPath = path.resolve('scripts/canvas-mcp-server.mjs');

  const client = new Client({ name: 'poc-codex-canvas', version: '0.0.1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...process.env, CODEPILOT_DIAGRAMS_DIR: dir },
  });
  await client.connect(transport);
  ok('stdio MCP handshake');

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  ok(`tools/list -> [${names.join(', ')}]`);
  for (const need of ['canvas_create', 'canvas_list', 'canvas_read', 'canvas_update']) {
    if (!names.includes(need)) fail('missing tool', need);
  }

  const created = await client.callTool({
    name: 'canvas_create',
    arguments: { engine: 'excalidraw', title: 'poc', scene: { elements: [{ id: 'r1', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 }] } },
  });
  const { id } = JSON.parse(created.content[0].text);
  if (fs.existsSync(path.join(dir, `${id}.excalidraw`))) ok(`canvas_create wrote ${id}.excalidraw`);
  else fail('canvas_create', 'file not written');

  // round-trip: incremental update then read back
  await client.callTool({ name: 'canvas_update', arguments: { id, ops: { add: [{ id: 'r2', type: 'ellipse', x: 200, y: 0 }] } } });
  const read = await client.callTool({ name: 'canvas_read', arguments: { id } });
  const elements = JSON.parse(read.content[0].text).elements;
  if (elements.length === 2) ok('canvas_update + canvas_read round-trip (2 elements)');
  else fail('round-trip', `expected 2 elements, got ${elements.length}`);

  await client.close();
  console.log(`\nself-test ok. diagrams dir: ${dir}`);
  console.log('\n--- NEXT: Codex app-server leg (manual) ---');
  console.log('See the commented CODEX_INSTRUCTIONS block at the bottom of this file.');
}

main().catch((e) => { fail('poc crashed', e); process.exit(1); });

/* CODEX_INSTRUCTIONS
 To prove Codex loads this MCP server, try the two mechanisms in order and record which works:

 (A) codex config.toml  (~/.codex/config.toml):
     [mcp_servers.codepilot_canvas]
     command = "node"
     args = ["<repoAbsPath>/scripts/canvas-mcp-server.mjs"]
     env = { CODEPILOT_DIAGRAMS_DIR = "<repoAbsPath>/.codepilot-diagrams" }
     Then in a codex session: ask it to call the canvas_create tool, and check the file appears.

 (B) If CodePilot launches codex via app-server JSON-RPC, inspect src/lib/codex-client.ts /
     src/lib/codex-process-manager.ts for where the session/config is built, and whether an
     mcp_servers field can be injected per-session. Mirror the channels approach
     (src/lib/channels/session-manager.ts:95 buildSpawnArgs / MCP_SERVER_PATH).

 RECORD in the spec Phase 0 verdict: which mechanism worked, exact config shape, and whether
 tool calls are observable. If NEITHER works, Phase 1 falls back to the FILE PATH for Codex
 (Claude Write()s the .codepilot-diagrams file; chokidar refresh still works) — already the
 universal fallback in the spec, so "all backends" does not depend on this POC succeeding.
*/
