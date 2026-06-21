#!/usr/bin/env node
/**
 * POC: reverse-MCP bridge — expose the local dev environment to ChatGPT (5.5 Pro)
 * as a Developer Mode MCP connector, so 5.5 Pro can READ the codebase and plan,
 * with execution handed back to Codex/Claude inside CodePilot.
 *
 * Why read-only: ChatGPT Developer Mode gives Pro-plan users read/fetch MCP only
 * (full read+write needs Business/Enterprise). Read-only is exactly what the
 * "5.5 Pro plans, Codex executes" split needs — and it works on every tier.
 *
 * Transport: Streamable HTTP (ChatGPT supports SSE + Streamable HTTP; remote
 * HTTPS only — pair this with `cloudflared tunnel --url http://localhost:8787`).
 * Stateless mode (sessionIdGenerator: undefined) — one user, no session map.
 *
 * Standalone POC: nothing here is wired into the Next app (open/closed).
 *
 *   ROOT=/path/to/repo PORT=8787 SECRET=hunter2 node scripts/poc-chatgpt-mcp-server.mjs
 *   then:  cloudflared tunnel --url http://localhost:8787
 *   ChatGPT → Settings → Connectors → Advanced → Developer mode → add
 *            https://<tunnel>/mcp/hunter2  (Authentication: None)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const ROOT = path.resolve(process.env.ROOT || process.cwd());
const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.SECRET || '';
const MCP_PATH = SECRET ? `/mcp/${SECRET}` : '/mcp';
const MAX_READ_BYTES = 100_000;
const MAX_ENTRIES = 400;

const log = (...a) => console.error('[poc-mcp]', ...a);

// --- sandbox: keep every access inside ROOT and away from secrets ----------
const BLOCKED_DIR = new Set(['.git', 'node_modules', '.next', '.codepilot-uploads']);
const BLOCKED_FILE = /(^\.env)|(\.(pem|key)$)|(^id_rsa)|(auth\.json$)/i;

function safeResolve(rel) {
  const target = path.resolve(ROOT, rel || '.');
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    throw new Error(`path escapes ROOT: ${rel}`);
  }
  return target;
}
const isBlocked = (name) => BLOCKED_DIR.has(name) || BLOCKED_FILE.test(name);

// --- read-only tools --------------------------------------------------------
function listFiles(rel, maxDepth) {
  const base = safeResolve(rel);
  const out = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= MAX_ENTRIES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (isBlocked(e.name) || out.length >= MAX_ENTRIES) continue;
      const abs = path.join(dir, e.name);
      const relPath = path.relative(ROOT, abs);
      if (e.isDirectory()) { out.push(`${relPath}/`); walk(abs, depth + 1); }
      else out.push(relPath);
    }
  };
  walk(base, 0);
  return out;
}

function readFile(rel) {
  const target = safeResolve(rel);
  if (isBlocked(path.basename(target))) throw new Error(`blocked: ${rel}`);
  const buf = fs.readFileSync(target);
  const text = buf.subarray(0, MAX_READ_BYTES).toString('utf8');
  return buf.length > MAX_READ_BYTES ? `${text}\n…[truncated ${buf.length - MAX_READ_BYTES} bytes]` : text;
}

function searchFiles(query, maxResults) {
  const hits = [];
  let filesSeen = 0;
  const walk = (dir, depth) => {
    if (depth > 6 || hits.length >= maxResults || filesSeen > 2000) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (isBlocked(e.name) || hits.length >= maxResults) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs, depth + 1); continue; }
      filesSeen++;
      let content;
      try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
      content.split('\n').forEach((line, i) => {
        if (hits.length < maxResults && line.includes(query)) {
          hits.push(`${path.relative(ROOT, abs)}:${i + 1}: ${line.trim().slice(0, 200)}`);
        }
      });
    }
  };
  walk(ROOT, 0);
  return hits;
}

const asText = (v) => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) }] });

function buildServer() {
  const server = new McpServer({ name: 'codepilot-poc-readonly', version: '0.0.1' });

  server.registerTool('list_files',
    { title: 'List files', description: `List files/dirs under ROOT (${ROOT}). Read-only.`,
      inputSchema: { path: z.string().optional().describe('relative path, default "."'), maxDepth: z.number().int().min(0).max(6).optional() } },
    async ({ path: rel, maxDepth }) => asText(listFiles(rel ?? '.', maxDepth ?? 2)));

  server.registerTool('read_file',
    { title: 'Read file', description: 'Read a UTF-8 text file under ROOT (capped at 100KB). Read-only.',
      inputSchema: { path: z.string().describe('relative path to the file') } },
    async ({ path: rel }) => asText(readFile(rel)));

  server.registerTool('search_files',
    { title: 'Search files', description: 'Substring search across text files under ROOT. Read-only.',
      inputSchema: { query: z.string(), maxResults: z.number().int().min(1).max(200).optional() } },
    async ({ query, maxResults }) => asText(searchFiles(query, maxResults ?? 50)));

  return server;
}

// --- read full request body (handleRequest wants the pre-parsed JSON body) --
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : undefined); } catch { resolve(undefined); } });
    req.on('error', () => resolve(undefined));
  });
}

const httpServer = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  if (url === '/' || url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`codepilot-poc-mcp ok\nROOT=${ROOT}\nMCP endpoint: ${MCP_PATH}\n`);
    return;
  }
  if (url !== MCP_PATH) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end(`not found (MCP endpoint is ${MCP_PATH})`);
    return;
  }

  // Stateless: fresh server + transport per request.
  try {
    const body = req.method === 'POST' ? await readBody(req) : undefined;
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    log('request error', err);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(err) })); }
  }
});

httpServer.listen(PORT, () => {
  log(`listening on http://127.0.0.1:${PORT}`);
  log(`ROOT = ${ROOT}`);
  log(`MCP endpoint = http://127.0.0.1:${PORT}${MCP_PATH}`);
  log('next: cloudflared tunnel --url http://localhost:' + PORT);
});
