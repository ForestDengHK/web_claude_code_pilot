import * as assert from 'node:assert';
import {
  CLAUDE_UI_PERMISSION_MODES,
  DEFAULT_CLAUDE_UI_MODE,
  claudeModeDescription,
  claudeModeLabel,
  normalizeClaudeMode,
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

console.log('All permission-modes tests passed.');
