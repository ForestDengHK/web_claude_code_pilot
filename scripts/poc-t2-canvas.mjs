#!/usr/bin/env node
// Verify the T2 wiring: the Claude Agent SDK loads our stdio canvas MCP server
// and a real model turn calls canvas_create, writing the file. Throwaway POC.
import { query } from '@anthropic-ai/claude-agent-sdk';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't2canvas-'));
const serverPath = path.resolve('scripts/canvas-mcp-server.mjs');
console.error('diagrams dir:', dir);

const q = query({
  prompt: "Call the canvas_create tool right now with: engine='excalidraw', title='T2 live', scene={elements:[{id:'r1',type:'rectangle',x:0,y:0,width:120,height:80}]}. After the tool returns, reply with just: done.",
  options: {
    mcpServers: {
      'codepilot-canvas': { type: 'stdio', command: process.execPath, args: [serverPath], env: { ...process.env, CODEPILOT_DIAGRAMS_DIR: dir } },
    },
    allowedTools: ['mcp__codepilot-canvas__canvas_create'],
    permissionMode: 'bypassPermissions',
    maxTurns: 6,
  },
});

let calledTool = false;
for await (const m of q) {
  if (m.type === 'assistant') {
    for (const block of m.message?.content ?? []) {
      if (block.type === 'tool_use') { calledTool = true; console.error('TOOL_USE:', block.name); }
    }
  }
  if (m.type === 'result') console.error('RESULT:', m.subtype);
}

const files = fs.readdirSync(dir);
console.log('calledTool:', calledTool);
console.log('files written:', files);
const ok = files.some((f) => f.endsWith('.excalidraw'));
console.log(ok ? '✔ T2 wiring works: Claude created a diagram file' : '✗ no diagram file written');
process.exit(ok ? 0 : 1);
