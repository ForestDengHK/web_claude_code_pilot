#!/usr/bin/env node
// CodePilot Channels backend -- MCP channel server spawned by `claude --channels`.
// stdout is the MCP stdio transport; ALL logging goes to stderr.
import http from 'node:http';
import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const SESSION_ID = process.env.CODEPILOT_SESSION_ID || '';
const INTERNAL_URL = process.env.CODEPILOT_INTERNAL_URL || 'http://127.0.0.1:4000';
const WANT_PORT = Number(process.env.CODEPILOT_CHANNEL_PORT || 0);
const PORT_FILE = process.env.CHANNEL_PORT_FILE || '';
const log = (...a) => console.error('[channels-mcp]', SESSION_ID, ...a);

async function toCodePilot(kind, payload) {
  try {
    const res = await fetch(`${INTERNAL_URL}/api/channels/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: SESSION_ID, kind, ...payload }),
    });
    if (!res.ok) log('toCodePilot non-ok', kind, res.status);
  } catch (e) { log('toCodePilot failed', kind, String(e)); }
}

const mcp = new Server(
  { name: 'codepilot', version: '1.0.0' },
  {
    capabilities: {
      experimental: { 'claude/channel': {}, 'claude/channel/permission': {} },
      tools: {},
    },
    instructions:
      'User messages arrive as <channel source="codepilot" chat_id="...">. ' +
      'ALWAYS reply to the user by calling the reply tool exactly once when your turn ' +
      'is complete, passing the chat_id from the tag and your full final answer as text.',
  },
);

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send the final answer back to the user over the CodePilot channel. Call once per turn.',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'chat_id from the inbound <channel> tag' },
        text: { type: 'string', description: 'the full final answer' },
      },
      required: ['chat_id', 'text'],
    },
  }],
}));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'reply') {
    const { chat_id, text } = req.params.arguments ?? {};
    await toCodePilot('reply', { chatId: chat_id, text });
    return { content: [{ type: 'text', text: 'sent' }] };
  }
  throw new Error(`unknown tool: ${req.params.name}`);
});

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(), tool_name: z.string(),
    description: z.string(), input_preview: z.string(),
  }),
});
mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  await toCodePilot('permission_request', { request: params });
});

await mcp.connect(new StdioServerTransport());
log('MCP connected');

let chatSeq = 1;
const VERDICT_RE = /^\s*(allow|deny):([a-km-z]{5})\s*$/i;
const server = http.createServer((req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  req.setEncoding('utf8');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    if (req.url === '/push') {
      const chatId = String(chatSeq++);
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: { content: body, meta: { chat_id: chatId } },
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chatId }));
      return;
    }
    if (req.url === '/verdict') {
      const m = VERDICT_RE.exec(body);
      if (m) {
        await mcp.notification({
          method: 'notifications/claude/channel/permission',
          params: { request_id: m[2].toLowerCase(), behavior: m[1].toLowerCase() },
        });
        res.end('ok');
      } else { res.writeHead(400); res.end('bad verdict'); }
      return;
    }
    res.writeHead(404); res.end();
  });
});
server.listen(WANT_PORT, '127.0.0.1', () => {
  const port = server.address().port;
  log('HTTP listening on', port);
  if (PORT_FILE) fs.writeFileSync(PORT_FILE, String(port));
});
