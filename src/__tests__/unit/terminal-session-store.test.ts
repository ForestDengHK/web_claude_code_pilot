import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codepilot-test-'));
  // Override DB location so tests never touch ~/.codepilot/codepilot.db
  process.env.CLAUDE_GUI_DATA_DIR = tmpDir;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CLAUDE_GUI_DATA_DIR;
});

describe('TerminalSessionStore', async () => {
  const store = await import('../../lib/terminal/session-store.js');

  it('creates and retrieves a session', () => {
    const s = store.createSession('local', 'codepilot-abc123', 'Test shell');
    assert.ok(s.id);
    assert.equal(s.hostId, 'local');
    assert.equal(s.tmuxName, 'codepilot-abc123');
    assert.equal(s.title, 'Test shell');

    const fetched = store.getSession(s.id);
    assert.ok(fetched);
    assert.equal(fetched!.id, s.id);
  });

  it('lists all sessions', () => {
    store.createSession('local', 'codepilot-aaa', 'Shell A');
    store.createSession('local', 'codepilot-bbb', 'Shell B');
    const list = store.listSessions();
    assert.ok(list.length >= 2);
  });

  it('updates last_seen via touchSession', async () => {
    const s = store.createSession('local', 'codepilot-touch', 'Touch test');
    const before = s.lastSeen;
    await new Promise(r => setTimeout(r, 15));
    store.touchSession(s.id);
    const updated = store.getSession(s.id);
    assert.ok(updated!.lastSeen > before);
  });

  it('deletes a session', () => {
    const s = store.createSession('local', 'codepilot-del', 'Delete me');
    store.deleteSession(s.id);
    assert.strictEqual(store.getSession(s.id), undefined);
  });
});
