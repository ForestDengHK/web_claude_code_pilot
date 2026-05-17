// scripts/channels-mcp-server.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';

async function waitForPortFile(portFile, deadlineMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (fs.existsSync(portFile)) {
      const port = fs.readFileSync(portFile, 'utf8').trim();
      if (Number(port) > 0) return port;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('server did not write a port file in time');
}

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
  try {
    const port = await waitForPortFile(portFile);
    assert.ok(Number(port) > 0, 'server wrote a port');

    const res = await fetch(`http://127.0.0.1:${port}/push`, { method: 'POST', body: 'hello' });
    assert.equal(res.status, 200);
  } finally {
    proc.kill('SIGTERM');
    sink.close();
    fs.rmSync(portFile, { force: true });
  }
});

test('channel server /verdict accepts valid and rejects malformed verdicts', async () => {
  const sink = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => res.end('ok'));
  });
  await new Promise(r => sink.listen(0, '127.0.0.1', r));
  const sinkPort = sink.address().port;
  const portFile = `/tmp/cp_test_port_${Date.now()}_v`;

  const proc = spawn('node', ['scripts/channels-mcp-server.mjs'], {
    env: { ...process.env, CODEPILOT_CHANNEL_PORT: '0', CODEPILOT_SESSION_ID: 's2',
           CODEPILOT_INTERNAL_URL: `http://127.0.0.1:${sinkPort}`, CHANNEL_PORT_FILE: portFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const port = await waitForPortFile(portFile);

    const ok = await fetch(`http://127.0.0.1:${port}/verdict`, { method: 'POST', body: 'allow:abcde' });
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'ok');

    const bad = await fetch(`http://127.0.0.1:${port}/verdict`, { method: 'POST', body: 'garbage' });
    assert.equal(bad.status, 400);
  } finally {
    proc.kill('SIGTERM');
    sink.close();
    fs.rmSync(portFile, { force: true });
  }
});
