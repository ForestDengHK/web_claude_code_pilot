import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { closeDb } from '../../lib/db';

let tmp: string;
let cwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-artmcp-'));
  process.env.CLAUDE_GUI_DATA_DIR = tmp;
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-cwd-'));
});
afterEach(() => {
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  delete process.env.CLAUDE_GUI_DATA_DIR;
});

describe('publish_artifact tool', () => {
  it('reads the html file and persists an artifact, returning JSON', async () => {
    const { runPublishArtifact } = await import('../../lib/artifacts-mcp');
    fs.writeFileSync(path.join(cwd, 'digest.html'), '<html><body>run digest</body></html>');
    const out = await runPublishArtifact(
      { cwd, projectId: cwd },
      { file_path: 'digest.html', title: 'Run Digest', favicon: '📊' },
    );
    const payload = JSON.parse(out.text);
    assert.equal(out.isError, undefined);
    assert.equal(payload.artifact_id, 'run-digest');
    assert.equal(payload.version, 1);
    assert.equal(payload.internal_url, '/api/artifacts/run-digest?version=1');
  });

  it('returns an error result when the file is missing', async () => {
    const { runPublishArtifact } = await import('../../lib/artifacts-mcp');
    const out = await runPublishArtifact({ cwd, projectId: cwd }, { file_path: 'nope.html', title: 'X', favicon: '📄' });
    assert.equal(out.isError, true);
    assert.match(out.text, /cannot read/);
  });
});
