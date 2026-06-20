import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

let dataDir: string;
let cwd: string;

beforeEach(async () => {
  const { closeDb } = await import('../../lib/db');
  closeDb();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-codex-artifacts-data-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-codex-artifacts-cwd-'));
  process.env.CLAUDE_GUI_DATA_DIR = dataDir;
});

afterEach(async () => {
  const { closeDb } = await import('../../lib/db');
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  delete process.env.CLAUDE_GUI_DATA_DIR;
});

describe('Codex artifact command support', () => {
  it('parses new and update slash commands', async () => {
    const { parseCodexArtifactCommand, buildCodexArtifactPrompt } = await import('../../lib/codex-artifacts');

    assert.deepEqual(parseCodexArtifactCommand('/artifact small digest'), {
      userContext: 'small digest',
    });
    assert.deepEqual(parseCodexArtifactCommand('/artifact --update run-digest latest state'), {
      userContext: 'latest state',
      artifactId: 'run-digest',
    });
    assert.ok(parseCodexArtifactCommand('Write it to artifact-digest.html, then call publish_artifact.'));
    assert.equal(parseCodexArtifactCommand('/goal status'), null);
    assert.match(buildCodexArtifactPrompt('tiny', 'run-digest'), /artifact-digest\.html/);
    assert.match(buildCodexArtifactPrompt('tiny', 'run-digest'), /run-digest/);
  });

  it('publishes the written artifact file and appends updates', async () => {
    const { publishCodexArtifactFromFile, readArtifactMtimeMs, resolveArtifactPath } = await import('../../lib/codex-artifacts');
    const filePath = 'artifact-digest.html';
    const abs = resolveArtifactPath(cwd, filePath);

    const missing = publishCodexArtifactFromFile({
      request: { filePath, title: 'Digest', favicon: '📊' },
      workingDirectory: cwd,
      projectId: cwd,
      beforeMtimeMs: null,
    });
    assert.match(missing.error ?? '', /was not written/);

    fs.writeFileSync(abs, '<!doctype html><title>Codex Digest</title><p>v1</p>');
    const first = publishCodexArtifactFromFile({
      request: { filePath, title: 'Digest', favicon: '📊' },
      workingDirectory: cwd,
      projectId: cwd,
      beforeMtimeMs: null,
    });
    assert.equal(first.payload?.artifact_id, 'codex-digest');
    assert.equal(first.payload?.version, 1);

    const staleMtime = readArtifactMtimeMs(abs);
    const stale = publishCodexArtifactFromFile({
      request: { filePath, title: 'Digest', favicon: '📊', artifactId: 'codex-digest' },
      workingDirectory: cwd,
      projectId: cwd,
      beforeMtimeMs: staleMtime,
    });
    assert.match(stale.error ?? '', /was not updated/);

    await new Promise((resolve) => setTimeout(resolve, 5));
    fs.writeFileSync(abs, '<!doctype html><title>Codex Digest</title><p>v2</p>');
    const second = publishCodexArtifactFromFile({
      request: { filePath, title: 'Digest', favicon: '📊', artifactId: 'codex-digest' },
      workingDirectory: cwd,
      projectId: cwd,
      beforeMtimeMs: staleMtime,
    });
    assert.equal(second.payload?.artifact_id, 'codex-digest');
    assert.equal(second.payload?.version, 2);
  });
});
