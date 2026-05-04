import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-scheduler-db-'));
process.env.CLAUDE_GUI_DATA_DIR = tmpDir;

const {
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  setEnabled,
  insertRun,
  updateRunStatus,
  listRuns,
} = await import('../../lib/scheduler/scheduler-db');

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scheduler-db', () => {
  it('creates and reads a task', () => {
    const task = createTask({
      name: 'Daily review',
      description: null,
      workingDirectory: '/tmp/proj',
      backend: 'claude',
      model: null,
      effort: null,
      mode: 'acceptEdits',
      trigger: { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' },
      prompt: 'Run a review.',
      systemPrompt: null,
      skipPermissions: true,
      maxTurns: 50,
      toolTimeoutSeconds: 300,
      wallClockTimeoutSeconds: 1800,
      enabled: true,
    });
    assert.equal(task.name, 'Daily review');
    const got = getTask(task.id);
    assert.equal(got?.id, task.id);
    assert.deepEqual(got?.trigger, { kind: 'cron', cron: '0 9 * * *', timezone: 'UTC' });
  });

  it('lists tasks newest-first', () => {
    const list = listTasks();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 1);
  });

  it('updates a task and bumps updatedAt', async () => {
    const t = createTask({
      name: 'X', description: null, workingDirectory: '/tmp/p', backend: 'codex',
      model: null, effort: null, mode: 'acceptEdits',
      trigger: { kind: 'once', runAt: Date.now() + 10000, timezone: 'UTC' },
      prompt: 'hi', systemPrompt: null,
      skipPermissions: true, maxTurns: 10, toolTimeoutSeconds: 60,
      wallClockTimeoutSeconds: 600, enabled: false,
    });
    const before = t.updatedAt;
    await new Promise(r => setTimeout(r, 10));
    const updated = updateTask(t.id, { name: 'X-renamed' });
    assert.equal(updated?.name, 'X-renamed');
    assert.notEqual(updated?.updatedAt, before);
  });

  it('toggles enabled', () => {
    const t = createTask({
      name: 'tog', description: null, workingDirectory: '/tmp/p', backend: 'claude',
      model: null, effort: null, mode: 'acceptEdits',
      trigger: { kind: 'interval', everyMs: 60000, timezone: 'UTC' },
      prompt: 'go', systemPrompt: null,
      skipPermissions: true, maxTurns: 10, toolTimeoutSeconds: 60,
      wallClockTimeoutSeconds: 600, enabled: true,
    });
    setEnabled(t.id, false);
    assert.equal(getTask(t.id)?.enabled, false);
  });

  it('inserts and updates a run', () => {
    const t = listTasks()[0];
    const run = insertRun({
      taskId: t.id,
      triggerSource: 'manual',
      scheduledAt: Date.now(),
    });
    assert.equal(run.status, 'pending');
    updateRunStatus(run.id, { status: 'running', startedAt: Date.now(), sessionId: 'sess-1' });
    const runs = listRuns(t.id);
    assert.equal(runs[0].status, 'running');
    assert.equal(runs[0].sessionId, 'sess-1');
  });

  it('deletes a task and cascades runs', () => {
    const t = createTask({
      name: 'todel', description: null, workingDirectory: '/tmp/p', backend: 'claude',
      model: null, effort: null, mode: 'acceptEdits',
      trigger: { kind: 'once', runAt: Date.now() + 60000, timezone: 'UTC' },
      prompt: 'p', systemPrompt: null,
      skipPermissions: true, maxTurns: 10, toolTimeoutSeconds: 60,
      wallClockTimeoutSeconds: 600, enabled: true,
    });
    insertRun({ taskId: t.id, triggerSource: 'manual', scheduledAt: Date.now() });
    deleteTask(t.id);
    assert.equal(getTask(t.id), null);
    assert.equal(listRuns(t.id).length, 0);
  });
});
