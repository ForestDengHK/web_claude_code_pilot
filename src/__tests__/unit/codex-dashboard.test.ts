import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dataDir: string;
let cwd: string;

beforeEach(async () => {
  const { closeDb } = await import('../../lib/db');
  closeDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-codex-dash-data-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-codex-dash-cwd-'));
  process.env.CLAUDE_GUI_DATA_DIR = dataDir;
});
afterEach(async () => {
  const { closeDb } = await import('../../lib/db');
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  delete process.env.CLAUDE_GUI_DATA_DIR;
});

describe('Codex dashboard command support', () => {
  it('parses /dashboard with and without context, ignores other commands', async () => {
    const { parseCodexDashboardCommand } = await import('../../lib/codex-artifacts');
    assert.deepEqual(parseCodexDashboardCommand('/dashboard'), { userContext: '' });
    assert.deepEqual(parseCodexDashboardCommand('  /dashboard  fix   login '), { userContext: 'fix login' });
    assert.equal(parseCodexDashboardCommand('/artifact'), null);
    assert.equal(parseCodexDashboardCommand('hello there'), null);
  });

  it('appends the written JSON entry to the project dashboard', async () => {
    const { publishCodexDashboardFromFile } = await import('../../lib/codex-artifacts');
    const { dashboardArtifactId } = await import('../../lib/artifact-dashboard');
    const { getArtifactHtml } = await import('../../lib/artifacts');

    const rel = 'artifacts-summary/2026-06-21/dashboard-entry-x.json';
    const abs = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(
      abs,
      JSON.stringify({ title: 'Codex session', summary: 'Did the thing', status: 'done', changes: ['x'] }),
    );

    const res = publishCodexDashboardFromFile({
      request: { filePath: rel },
      workingDirectory: cwd,
      projectId: cwd,
      beforeMtimeMs: null,
    });

    assert.ok(res.payload, res.error);
    assert.equal(res.payload!.artifact_id, dashboardArtifactId(cwd));
    assert.equal(res.payload!.version, 1);
    const html = getArtifactHtml(res.payload!.artifact_id, 1) ?? '';
    assert.match(html, /Codex session/);
    assert.match(html, /badge done/);
  });

  it('tolerates a ```json code fence around the entry', async () => {
    const { publishCodexDashboardFromFile } = await import('../../lib/codex-artifacts');
    const { getArtifactHtml } = await import('../../lib/artifacts');
    const rel = 'entry.json';
    fs.writeFileSync(
      path.join(cwd, rel),
      '```json\n{"title":"Fenced","summary":"wrapped in a fence"}\n```',
    );
    const res = publishCodexDashboardFromFile({
      request: { filePath: rel },
      workingDirectory: cwd,
      projectId: cwd,
      beforeMtimeMs: null,
    });
    assert.ok(res.payload, res.error);
    assert.match(getArtifactHtml(res.payload!.artifact_id, 1) ?? '', /Fenced/);
  });

  it('errors when the file is missing, invalid JSON, or lacks title/summary', async () => {
    const { publishCodexDashboardFromFile } = await import('../../lib/codex-artifacts');

    const missing = publishCodexDashboardFromFile({
      request: { filePath: 'nope.json' },
      workingDirectory: cwd,
      projectId: cwd,
      beforeMtimeMs: null,
    });
    assert.ok(missing.error && !missing.payload);

    fs.writeFileSync(path.join(cwd, 'bad.json'), 'not json');
    const bad = publishCodexDashboardFromFile({
      request: { filePath: 'bad.json' },
      workingDirectory: cwd,
      projectId: cwd,
      beforeMtimeMs: null,
    });
    assert.ok(bad.error && !bad.payload);

    fs.writeFileSync(path.join(cwd, 'partial.json'), JSON.stringify({ title: 'no summary' }));
    const partial = publishCodexDashboardFromFile({
      request: { filePath: 'partial.json' },
      workingDirectory: cwd,
      projectId: cwd,
      beforeMtimeMs: null,
    });
    assert.ok(partial.error && !partial.payload);
  });
});
