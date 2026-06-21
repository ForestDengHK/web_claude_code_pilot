#!/usr/bin/env node
/**
 * POC self-test: acts as an MCP client (like ChatGPT would) against the local
 * poc-chatgpt-mcp-server over Streamable HTTP. Proves the server initializes,
 * lists tools, and returns real local data — everything EXCEPT the ChatGPT-cloud
 * → tunnel leg, which only you can exercise with your ChatGPT account.
 *
 *   # terminal 1
 *   ROOT=$(pwd) PORT=8787 SECRET=hunter2 node scripts/poc-chatgpt-mcp-server.mjs
 *   # terminal 2
 *   PORT=8787 SECRET=hunter2 node scripts/poc-chatgpt-mcp-selftest.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.SECRET || '';
const url = new URL(`http://127.0.0.1:${PORT}${SECRET ? `/mcp/${SECRET}` : '/mcp'}`);

const ok = (m) => console.log(`✔ ${m}`);
const fail = (m, e) => { console.error(`x ${m}:`, e?.message || e); process.exitCode = 1; };

async function main() {
  const client = new Client({ name: 'poc-selftest', version: '0.0.1' });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  ok(`initialize handshake (${url})`);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  ok(`tools/list -> [${names.join(', ')}]`);
  for (const need of ['list_files', 'read_file', 'search_files']) {
    if (!names.includes(need)) fail('missing tool', need);
  }

  const ls = await client.callTool({ name: 'list_files', arguments: { path: '.', maxDepth: 1 } });
  const lsText = ls.content?.[0]?.text || '';
  ok(`list_files returned ${lsText.split('\n').length} entries`);
  console.log('  e.g.', lsText.split('\n').slice(0, 5).join(' | '));

  const rd = await client.callTool({ name: 'read_file', arguments: { path: 'package.json' } });
  const rdText = rd.content?.[0]?.text || '';
  if (rdText.includes('"name"')) ok('read_file package.json (got real contents)');
  else fail('read_file', 'package.json did not contain "name"');

  const sr = await client.callTool({ name: 'search_files', arguments: { query: 'streamOpenAI', maxResults: 5 } });
  ok(`search_files "streamOpenAI" -> ${(sr.content?.[0]?.text || '').split('\n').filter(Boolean).length} hit(s)`);

  // sandbox check: escaping ROOT must be refused
  const esc = await client.callTool({ name: 'read_file', arguments: { path: '../../../../etc/passwd' } }).catch((e) => ({ _err: e }));
  const escErr = esc?._err || esc?.isError;
  if (escErr) ok('sandbox refused ../ escape');
  else fail('sandbox', 'escape was NOT refused');

  await client.close();
  console.log('\n— self-test complete —');
}

main().catch((e) => { fail('self-test crashed', e); process.exit(1); });
