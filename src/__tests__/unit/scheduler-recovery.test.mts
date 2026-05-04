import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-rec-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

const { createTask, insertRun, updateRunStatus, listRuns } = await import(
  '../../lib/scheduler/scheduler-db'
);
const { recoverInterruptedRuns } = await import('../../lib/scheduler/recovery');

after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('recoverInterruptedRuns', () => {
  it('marks running and pending runs as interrupted', () => {
    const t = createTask({
      name: 'rec', description: null, workingDirectory: '/tmp/p', backend: 'claude',
      model: null, effort: null, mode: 'acceptEdits',
      trigger: { kind: 'cron', cron: '* * * * *', timezone: 'UTC' },
      prompt: 'p', systemPrompt: null,
      skipPermissions: true, maxTurns: 10, toolTimeoutSeconds: 60,
      wallClockTimeoutSeconds: 600, enabled: true,
    });
    const r1 = insertRun({ taskId: t.id, triggerSource: 'cron', scheduledAt: Date.now() });
    updateRunStatus(r1.id, { status: 'running', startedAt: Date.now() });
    const r2 = insertRun({ taskId: t.id, triggerSource: 'cron', scheduledAt: Date.now() });
    // r2 stays at 'pending'

    const fixed = recoverInterruptedRuns();
    assert.equal(fixed, 2);
    const runs = listRuns(t.id);
    for (const r of runs) {
      assert.equal(r.status, 'interrupted');
      assert.ok(r.finishedAt);
      assert.match(r.error ?? '', /process restart/i);
    }
  });
});
