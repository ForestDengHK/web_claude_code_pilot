import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmp: string;

beforeEach(async () => {
  const { closeDb } = await import('../../lib/db');
  closeDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-dashboard-'));
  process.env.CLAUDE_GUI_DATA_DIR = tmp;
});
afterEach(async () => {
  const { closeDb } = await import('../../lib/db');
  closeDb();
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CLAUDE_GUI_DATA_DIR;
});

describe('project dashboard', () => {
  it('derives a deterministic dashboard id per project', async () => {
    const { dashboardArtifactId, isDashboardId } = await import('../../lib/artifact-dashboard');
    const a = dashboardArtifactId('/proj/one');
    const b = dashboardArtifactId('/proj/one');
    const c = dashboardArtifactId('/proj/two');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.ok(isDashboardId(a));
    assert.ok(!isDashboardId('incident-report'));
  });

  it('creates the dashboard on first entry and renders the content', async () => {
    const { updateProjectDashboard, dashboardArtifactId } = await import('../../lib/artifact-dashboard');
    const { getArtifact, getArtifactHtml } = await import('../../lib/artifacts');

    const out = updateProjectDashboard({
      projectId: '/proj/CodePilot',
      entry: { title: 'Add login', summary: 'Implemented OAuth', status: 'done', decisions: ['use PKCE'] },
    });

    assert.equal(out.artifactId, dashboardArtifactId('/proj/CodePilot'));
    assert.equal(out.version, 1);
    assert.equal(getArtifact(out.artifactId)?.title, 'CodePilot · Dashboard');

    const html = getArtifactHtml(out.artifactId, 1) ?? '';
    assert.match(html, /Add login/);
    assert.match(html, /Implemented OAuth/);
    assert.match(html, /use PKCE/);
    assert.match(html, /badge done/);
  });

  it('appends a new version and accumulates entries newest-first', async () => {
    const { updateProjectDashboard } = await import('../../lib/artifact-dashboard');
    const { getArtifactHtml, listVersions } = await import('../../lib/artifacts');

    const first = updateProjectDashboard({
      projectId: '/proj/acc',
      entry: { title: 'First session', summary: 'one' },
    });
    const second = updateProjectDashboard({
      projectId: '/proj/acc',
      entry: { title: 'Second session', summary: 'two' },
    });

    assert.equal(first.artifactId, second.artifactId);
    assert.equal(second.version, 2);
    assert.equal(listVersions(second.artifactId).length, 2);

    const html = getArtifactHtml(second.artifactId, 2) ?? '';
    assert.match(html, /First session/);
    assert.match(html, /Second session/);
    // Newest entry renders before the older one.
    assert.ok(html.indexOf('Second session') < html.indexOf('First session'));
  });

  it('escapes html in entry fields', async () => {
    const { updateProjectDashboard } = await import('../../lib/artifact-dashboard');
    const { getArtifactHtml } = await import('../../lib/artifacts');
    const out = updateProjectDashboard({
      projectId: '/proj/xss',
      entry: { title: '<script>alert(1)</script>', summary: 'a & b < c' },
    });
    const html = getArtifactHtml(out.artifactId, 1) ?? '';
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /a &amp; b &lt; c/);
  });
});
