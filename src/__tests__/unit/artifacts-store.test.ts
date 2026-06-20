import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmp: string;

beforeEach(async () => {
  // Reset the cached DB singleton so each test opens a fresh DB at its own tmp dir.
  const { closeDb } = await import('../../lib/db');
  closeDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-artifacts-'));
  process.env.CLAUDE_GUI_DATA_DIR = tmp;
});
afterEach(async () => {
  const { closeDb } = await import('../../lib/db');
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CLAUDE_GUI_DATA_DIR;
});

describe('artifacts store', () => {
  it('creates v1 on first publish and writes the html file', async () => {
    const { publishArtifact, getArtifactHtml } = await import('../../lib/artifacts');
    const { artifactId, version } = publishArtifact({
      html: '<html><body>hello</body></html>',
      title: 'Incident Report',
      favicon: '🚨',
      projectId: '/proj',
    });
    expect(version).toBe(1);
    expect(artifactId).toBe('incident-report');
    expect(getArtifactHtml(artifactId, 1)).toContain('hello');
  });

  it('appends a new version when given an existing artifact_id', async () => {
    const { publishArtifact, listVersions } = await import('../../lib/artifacts');
    const first = publishArtifact({ html: '<p>a</p>', title: 'Run Digest', favicon: '📊', projectId: '/proj' });
    const second = publishArtifact({ html: '<p>b</p>', title: 'Run Digest', favicon: '📊', projectId: '/proj', artifactId: first.artifactId });
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.version).toBe(2);
    expect(listVersions(first.artifactId).map(v => v.version)).toEqual([1, 2]);
  });

  it('disambiguates slugs for distinct artifacts with the same title', async () => {
    const { publishArtifact } = await import('../../lib/artifacts');
    const a = publishArtifact({ html: '<p>a</p>', title: 'Report', favicon: '📄', projectId: '/proj' });
    const b = publishArtifact({ html: '<p>b</p>', title: 'Report', favicon: '📄', projectId: '/proj' });
    expect(a.artifactId).toBe('report');
    expect(b.artifactId).toBe('report-2');
  });

  it('lists artifacts for a project, newest first', async () => {
    const { publishArtifact, listArtifacts } = await import('../../lib/artifacts');
    publishArtifact({ html: '<p>x</p>', title: 'One', favicon: '📄', projectId: '/proj' });
    publishArtifact({ html: '<p>y</p>', title: 'Two', favicon: '📄', projectId: '/other' });
    const list = listArtifacts('/proj');
    expect(list.map(a => a.title)).toEqual(['One']);
  });
});
