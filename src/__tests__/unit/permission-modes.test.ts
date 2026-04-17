import * as assert from 'node:assert';
import {
  CLAUDE_UI_PERMISSION_MODES,
  CODEX_UI_PERMISSION_MODES,
  DEFAULT_CLAUDE_UI_MODE,
  DEFAULT_CODEX_UI_MODE,
  claudeModeDescription,
  claudeModeLabel,
  codexModeLabel,
  normalizeClaudeMode,
  normalizeCodexMode,
  normalizeModeForBackend,
} from '../../lib/permission-modes';

// ---------- CLAUDE_UI_PERMISSION_MODES ----------

assert.deepStrictEqual(
  [...CLAUDE_UI_PERMISSION_MODES],
  ['plan', 'acceptEdits', 'auto'],
  'UI modes list must match design: plan, acceptEdits, auto',
);
assert.ok(
  !(CLAUDE_UI_PERMISSION_MODES as readonly string[]).includes('bypassPermissions'),
  'bypassPermissions must NOT be in the mode dropdown (shield owns it)',
);
assert.ok(
  !(CLAUDE_UI_PERMISSION_MODES as readonly string[]).includes('default'),
  'default has no viable web UX (would stall on prompts)',
);

// ---------- normalizeClaudeMode: legacy values ----------

assert.strictEqual(
  normalizeClaudeMode('code'),
  'acceptEdits',
  "legacy 'code' → 'acceptEdits'",
);
assert.strictEqual(
  normalizeClaudeMode('ask'),
  DEFAULT_CLAUDE_UI_MODE,
  "legacy 'ask' has no real mapping → default",
);

// ---------- normalizeClaudeMode: current values (pass-through) ----------

assert.strictEqual(normalizeClaudeMode('plan'), 'plan');
assert.strictEqual(normalizeClaudeMode('acceptEdits'), 'acceptEdits');
assert.strictEqual(normalizeClaudeMode('auto'), 'auto');

// ---------- normalizeClaudeMode: defaults ----------

assert.strictEqual(
  normalizeClaudeMode(null),
  DEFAULT_CLAUDE_UI_MODE,
  'null → default',
);
assert.strictEqual(
  normalizeClaudeMode(undefined),
  DEFAULT_CLAUDE_UI_MODE,
  'undefined → default',
);
assert.strictEqual(
  normalizeClaudeMode(''),
  DEFAULT_CLAUDE_UI_MODE,
  'empty string → default',
);
assert.strictEqual(
  normalizeClaudeMode('bypassPermissions'),
  DEFAULT_CLAUDE_UI_MODE,
  'bypassPermissions does not belong in mode field — default',
);
assert.strictEqual(
  normalizeClaudeMode('garbage'),
  DEFAULT_CLAUDE_UI_MODE,
  'unknown strings → default (never throws)',
);

// ---------- labels / descriptions ----------

assert.strictEqual(claudeModeLabel('plan'), 'Plan');
assert.strictEqual(claudeModeLabel('acceptEdits'), 'Accept Edits');
assert.strictEqual(claudeModeLabel('auto'), 'Auto');

// Descriptions should be non-empty and differ per mode
for (const mode of CLAUDE_UI_PERMISSION_MODES) {
  const desc = claudeModeDescription(mode);
  assert.ok(desc.length > 0, `description for ${mode} must be non-empty`);
}
assert.notStrictEqual(
  claudeModeDescription('plan'),
  claudeModeDescription('acceptEdits'),
);
assert.notStrictEqual(
  claudeModeDescription('acceptEdits'),
  claudeModeDescription('auto'),
);

// ---------- CODEX_UI_PERMISSION_MODES ----------

assert.deepStrictEqual(
  [...CODEX_UI_PERMISSION_MODES],
  ['untrusted', 'on-failure', 'on-request'],
  'Codex UI modes must match design: untrusted, on-failure, on-request',
);
assert.ok(
  !(CODEX_UI_PERMISSION_MODES as readonly string[]).includes('never'),
  "'never' must NOT be in Codex mode dropdown — shield owns it",
);
assert.strictEqual(
  DEFAULT_CODEX_UI_MODE,
  'on-failure',
  "Codex default should mirror Claude's 'acceptEdits' spirit",
);

// ---------- normalizeCodexMode ----------

// Pass-through of valid Codex values
assert.strictEqual(normalizeCodexMode('untrusted'), 'untrusted');
assert.strictEqual(normalizeCodexMode('on-failure'), 'on-failure');
assert.strictEqual(normalizeCodexMode('on-request'), 'on-request');

// Claude-side modes are NOT cross-mapped — they fall back to default.
// This is a deliberate design choice (avoids brittle hard-coded mapping
// tables). Document with a dedicated assertion so a future "helpful"
// refactor that adds cross-mapping breaks this test.
assert.strictEqual(
  normalizeCodexMode('acceptEdits'),
  DEFAULT_CODEX_UI_MODE,
  'Claude acceptEdits MUST fall back to Codex default (no cross-mapping)',
);
assert.strictEqual(normalizeCodexMode('plan'), DEFAULT_CODEX_UI_MODE);
assert.strictEqual(normalizeCodexMode('auto'), DEFAULT_CODEX_UI_MODE);

// Null / empty / unknown → default
assert.strictEqual(normalizeCodexMode(null), DEFAULT_CODEX_UI_MODE);
assert.strictEqual(normalizeCodexMode(undefined), DEFAULT_CODEX_UI_MODE);
assert.strictEqual(normalizeCodexMode(''), DEFAULT_CODEX_UI_MODE);
assert.strictEqual(normalizeCodexMode('never'), DEFAULT_CODEX_UI_MODE);
assert.strictEqual(normalizeCodexMode('garbage'), DEFAULT_CODEX_UI_MODE);

// ---------- Codex labels ----------

assert.strictEqual(codexModeLabel('untrusted'), 'Ask');
assert.strictEqual(codexModeLabel('on-failure'), 'On Failure');
assert.strictEqual(codexModeLabel('on-request'), 'On Request');

// ---------- normalizeModeForBackend ----------

assert.strictEqual(
  normalizeModeForBackend('acceptEdits', 'claude'),
  'acceptEdits',
);
assert.strictEqual(
  normalizeModeForBackend('acceptEdits', 'codex'),
  DEFAULT_CODEX_UI_MODE,
  'Claude mode in Codex context → Codex default',
);
assert.strictEqual(
  normalizeModeForBackend('on-failure', 'codex'),
  'on-failure',
);
assert.strictEqual(
  normalizeModeForBackend('on-failure', 'claude'),
  DEFAULT_CLAUDE_UI_MODE,
  'Codex mode in Claude context → Claude default',
);

console.log('All permission-modes tests passed.');
