// src/__tests__/unit/provider-lane-resume.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
/* eslint-disable @typescript-eslint/no-require-imports */
process.env.CLAUDE_GUI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lane-resume-'));
const db = require('../../lib/db') as typeof import('../../lib/db');
const { resolveLaneResumeId } = require('../../lib/context-bridge') as typeof import('../../lib/context-bridge');
const { claudeTranscriptExists } = require('../../lib/claude-session-parser') as typeof import('../../lib/claude-session-parser');
const { buildSpawnArgs } = require('../../lib/channels/session-manager') as typeof import('../../lib/channels/session-manager');

// --- claudeTranscriptExists: the on-disk scan that guards --resume ---

test('claudeTranscriptExists finds a transcript across project dirs', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-projects-'));
  const proj = path.join(projectsDir, '-Users-party-working-dsu');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'live-uuid.jsonl'), '{}\n');
  assert.strictEqual(claudeTranscriptExists('live-uuid', projectsDir), true);
});

test('claudeTranscriptExists returns false when no transcript exists', () => {
  const projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-projects-'));
  fs.mkdirSync(path.join(projectsDir, '-some-proj'));
  assert.strictEqual(claudeTranscriptExists('dead-uuid', projectsDir), false);
});

// --- resolveLaneResumeId: drop dangling ids so the lane self-heals ---

test('drops a lane resume id whose transcript is missing and clears the lane', () => {
  db.setProviderLaneSessionId('sessX', 'provDeepSeek', 'd6e11cc8');
  const resumeId = resolveLaneResumeId('sessX', 'provDeepSeek', '', () => false);
  assert.strictEqual(resumeId, undefined);
  // self-heal: the dangling id is cleared so the next turn starts fresh + text-bridges
  assert.strictEqual(db.getProviderLane('sessX', 'provDeepSeek')?.claude_session_id, '');
});

test('keeps a lane resume id whose transcript exists', () => {
  db.setProviderLaneSessionId('sessX', 'provLive', 'live-uuid');
  const resumeId = resolveLaneResumeId('sessX', 'provLive', '', () => true);
  assert.strictEqual(resumeId, 'live-uuid');
});

test('default lane falls back to the legacy sdk_session_id', () => {
  const resumeId = resolveLaneResumeId('sessNoLane', 'default', 'legacy-uuid', () => true);
  assert.strictEqual(resumeId, 'legacy-uuid');
});

// T1 channels leans on the legacy fallback for the default lane; a dangling legacy id
// (transcript gone) must resolve to no-resume so the PTY starts fresh instead of
// `claude --resume <missing>` wedging with "channel never started the turn (no dequeue)".
test('default lane drops a dangling legacy id', () => {
  const resumeId = resolveLaneResumeId('sessNoLane2', 'default', 'dead-legacy-uuid', () => false);
  assert.strictEqual(resumeId, undefined);
});

test('a provider with no stored lane resumes nothing', () => {
  const resumeId = resolveLaneResumeId('sessFresh', 'provBrandNew', '', () => true);
  assert.strictEqual(resumeId, undefined);
});

// --- T1 channels spawn: a dropped resume id must produce --session-id, not --resume ---
// This is the symptom boundary: `claude --resume <missing>` is what wedges a channel
// with "channel never started the turn (no dequeue)".

test('channels spawns a fresh --session-id when the lane id is dangling', () => {
  db.setProviderLaneSessionId('t1sess', 'provDeepSeek', 'dangling-channel-id');
  const laneId = resolveLaneResumeId('t1sess', 'provDeepSeek', '', () => false) ?? null;
  const args = buildSpawnArgs({ claudeSessionId: laneId ?? 'fresh-uuid', resume: !!laneId, mcpConfigJson: '{}' });
  assert.ok(args.includes('--session-id'), 'should start a fresh session');
  assert.ok(!args.includes('--resume'), 'must NOT --resume a missing transcript');
});

test('channels resumes with --resume when the lane transcript exists', () => {
  db.setProviderLaneSessionId('t1sess', 'provLive', 'live-channel-id');
  const laneId = resolveLaneResumeId('t1sess', 'provLive', '', () => true) ?? null;
  const args = buildSpawnArgs({ claudeSessionId: laneId ?? 'x', resume: !!laneId, mcpConfigJson: '{}' });
  assert.ok(args.includes('--resume'));
  assert.ok(args.includes('live-channel-id'));
});
