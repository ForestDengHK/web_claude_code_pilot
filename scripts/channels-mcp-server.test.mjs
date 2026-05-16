// scripts/channels-mcp-server.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

test('channel server binds a port and accepts /push', async () => {
  const sink = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => res.end('ok'));
  });
  await new Promise(r => sink.listen(0, '127.0.0.1', r));
  const sinkPort = sink.address().port;
  const portFile = `/tmp/cp_test_port_${Date.now()}`;

  const proc = spawn('node', ['scripts/channels-mcp-server.mjs'], {
    env: { ...process.env, CODEPILOT_CHANNEL_PORT: '0', CODEPILOT_SESSION_ID: 's1',
           CODEPILOT_INTERNAL_URL: `http://127.0.0.1:${sinkPort}`, CHANNEL_PORT_FILE: portFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await new Promise(r => setTimeout(r, 800));
  const port = fs.readFileSync(portFile, 'utf8').trim();
  assert.ok(Number(port) > 0, 'server wrote a port');

  const res = await fetch(`http://127.0.0.1:${port}/push`, { method: 'POST', body: 'hello' });
  assert.equal(res.status, 200);

  proc.kill('SIGTERM');
  sink.close();
  fs.rmSync(portFile, { force: true });
});
