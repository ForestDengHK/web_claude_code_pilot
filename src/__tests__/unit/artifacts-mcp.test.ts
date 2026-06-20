import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    expect(out.isError).toBeUndefined();
    expect(payload.artifact_id).toBe('run-digest');
    expect(payload.version).toBe(1);
    expect(payload.internal_url).toBe('/api/artifacts/run-digest?version=1');
  });

  it('returns an error result when the file is missing', async () => {
    const { runPublishArtifact } = await import('../../lib/artifacts-mcp');
    const out = await runPublishArtifact({ cwd, projectId: cwd }, { file_path: 'nope.html', title: 'X', favicon: '📄' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('cannot read');
  });
});
