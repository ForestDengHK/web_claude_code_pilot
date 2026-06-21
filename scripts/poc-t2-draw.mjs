#!/usr/bin/env node
// Throwaway: drive a REAL Claude turn that draws a diagram into the app's diagrams dir,
// so it shows up in the running CodePilot at /canvas/<id>. Prints the new id.
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const dir = path.join(process.env.CLAUDE_GUI_DATA_DIR || path.join(os.homedir(), '.codepilot'), 'diagrams');
fs.mkdirSync(dir, { recursive: true });
const before = new Set(fs.readdirSync(dir));
const serverPath = path.resolve('scripts/canvas-mcp-server.mjs');

const prompt = `Use the canvas_create tool to create an excalidraw diagram titled "Login Flow" that draws a simple top-to-bottom flowchart with three labelled boxes. Provide the scene as {elements:[...]} where elements include, for EACH box, a rectangle element AND a text element, with explicit id, x, y, width, height (boxes ~200 wide, ~70 tall, stacked vertically ~120px apart, starting around x=300 y=120), and the text elements positioned inside each box with a "text" field: "Start", "Login Form", "Dashboard". Also add two arrow elements connecting the boxes (with id, x, y, width, height spanning the gap). Give every element a unique id. After the tool returns, reply only: done.`;

const q = query({
  prompt,
  options: {
    mcpServers: { 'codepilot-canvas': { type: 'stdio', command: process.execPath, args: [serverPath], env: { ...process.env, CODEPILOT_DIAGRAMS_DIR: dir } } },
    allowedTools: ['mcp__codepilot-canvas__canvas_create', 'mcp__codepilot-canvas__canvas_update'],
    permissionMode: 'bypassPermissions',
    maxTurns: 8,
  },
});
for await (const m of q) {
  if (m.type === 'assistant') for (const b of m.message?.content ?? []) if (b.type === 'tool_use') console.error('TOOL_USE:', b.name);
  if (m.type === 'result') console.error('RESULT:', m.subtype);
}
const after = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json') && !before.has(f));
const id = after[0]?.replace('.meta.json', '');
console.log('NEW_CANVAS_ID:', id || '(none)');
