#!/usr/bin/env node
// Verify the "ghost canvas" fix: given canvas-context (existing canvas + id) and a
// session-scoped MCP, a real Claude turn EDITS the existing canvas by id instead of
// creating a new empty one. Writes into the app diagrams dir so you can open it after.
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createDiagram, readMeta } from '../src/lib/canvas-core.mjs';

const dir = path.join(process.env.CLAUDE_GUI_DATA_DIR || path.join(os.homedir(), '.codepilot'), 'diagrams');
const SESSION = 'ghostfix-sess';
const serverPath = path.resolve('scripts/canvas-mcp-server.mjs');

// 1) The user already has a draw.io canvas in this conversation.
const id = 'ghostflow1';
createDiagram(dir, { id, engine: 'drawio', title: 'Login Flow', sessionId: SESSION,
  scene: '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="2" value="Login" vertex="1" parent="1"><mxGeometry x="200" y="80" width="120" height="60" as="geometry"/></mxCell></root></mxGraphModel>' });
const beforeVersion = readMeta(dir, id).version;
const beforeIds = new Set(fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json')));

// 2) Same canvas-context note claude-client now injects.
const canvasContext = `\n\n<canvas-context>\nThis conversation has these diagram canvases. When the user says "the canvas"/"this diagram" or asks to edit/redraw, operate on one BY ID (canvas_read first; then canvas_update for excalidraw, or canvas_create with the SAME id for drawio/mermaid). Only create a new canvas if none fits.\n- id="${id}" title="Login Flow" engine=drawio v${beforeVersion} (0 elements)\n</canvas-context>`;

const q = query({
  prompt: '在画布里把现有的流程图加一个 "Payment" 步骤(在 Login 下面加一个框,连起来)。',
  options: {
    systemPrompt: { type: 'preset', preset: 'claude_code', append: canvasContext },
    mcpServers: { 'codepilot-canvas': { type: 'stdio', command: process.execPath, args: [serverPath], env: { ...process.env, CODEPILOT_DIAGRAMS_DIR: dir, CODEPILOT_SESSION_ID: SESSION } } },
    allowedTools: ['mcp__codepilot-canvas__canvas_list', 'mcp__codepilot-canvas__canvas_read', 'mcp__codepilot-canvas__canvas_create', 'mcp__codepilot-canvas__canvas_update'],
    permissionMode: 'bypassPermissions',
    maxTurns: 10,
  },
});
const toolCalls = [];
for await (const m of q) {
  if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'tool_use') toolCalls.push(b.name.replace('mcp__codepilot-canvas__', ''));
  if (m.type === 'result') console.error('RESULT:', m.subtype);
}
const afterVersion = readMeta(dir, id).version;
const afterIds = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json'));
const newOnes = afterIds.filter((f) => !beforeIds.has(f));

console.log('tool calls:', toolCalls.join(', '));
console.log('edited existing id?', afterVersion > beforeVersion, `(v${beforeVersion} -> v${afterVersion})`);
console.log('new ghost canvases created:', newOnes.length, newOnes.join(',') || '(none)');
console.log('canvas id for browser:', id);
const ok = afterVersion > beforeVersion && newOnes.length === 0;
console.log(ok ? '✔ edited the existing canvas by id, no ghost' : '✗ did not edit existing canvas cleanly');
process.exit(ok ? 0 : 1);
