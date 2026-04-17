# Lessons Learned

Debugging notes and post-mortems. Chronological, newest first.

---

## 2026-04-17 — Three bugs masquerading as one feature gap

**Severity**: Medium. Wasted a full design round.
**Detection**: Live browser test to validate whether Task C ("Codex realtime background progress") was worth building. Result surprised us: sidebar showed no running indicator for Codex sessions even though `/api/chat/sessions/:id/status` correctly reported `isProcessing:true`.

**Initial (wrong) diagnosis**: "`streamingSessions` isn't derived from server state — we need a new `/api/chat/sessions/active` endpoint + AppShell global poll." Spent a round proposing that architecture.

**Actual root cause — three unrelated bugs that stacked into the same symptom**:

1. **B1** (`src/lib/db.ts`): `registerShutdownHandlers()` was module-level and non-idempotent. Next.js HMR re-imports the module on every dev reload; after ~11 reloads the Node global `process` hit `MaxListenersExceededWarning`. Once tripped, EventEmitter behaviour elsewhere in the same process degrades unpredictably (some listeners start getting dropped or double-fired, depending on timing).

2. **B2** (`src/app/api/codex/{models,skills,skills/[name]}/route.ts`): All three routes used hardcoded `TEMP_SESSION_ID = '__codex_xxx__'` strings shared across concurrent requests. Request A's `finally { await kill(TEMP) }` would tear down a process that Request B was still waiting on → 15s timeout, sometimes EPIPE on a mid-flight write.

3. **B3** (`src/lib/codex-process-manager.ts:119`): `proc.stdin.write(message)` only guarded on `!proc.stdin.destroyed`, not on `proc.exitCode`. When B2's kill killed the proc, there was a window where `exitCode` was set but `stdin.destroyed` was still `false` → unhandled EPIPE.

**The trap**: each bug's failure surface was generic ("something wrong with Codex"), and they compounded. B1 + B2 + B3 together caused the Codex SSE to drop partway through a turn; the drop triggered ChatView's `finally` block which calls `removeStreamingSession(sessionId)`; the sidebar lost its entry. **The sidebar code itself was correct.** It just had no entry to render.

**Proof that the three were interlocked**: after fixing all three, sidebar running indicators for Codex sessions Just Worked with zero UI-layer changes. No new endpoint, no AppShell refactor, no derived-from-server sync — none of it was needed.

**Lessons**:
1. **When the "architectural gap" fix feels too big for the symptom, look harder for smaller bugs underneath.** We were about to add ~150 LOC of infrastructure (active-sessions endpoint, global polling, state reconciliation) when the real fix was ~40 LOC across three pinpoint bugs.
2. **`MaxListenersExceededWarning` is not cosmetic in dev-mode long-running processes.** Treat it as blocking — the cascading effects on EventEmitter-heavy code (child_process, readline, fetch streams) are real and weird.
3. **Any `TEMP_SESSION_ID = 'constant'` in a Next.js route is suspect.** Request handlers run concurrently; any shared mutable resource keyed by a constant string needs per-request keying or a proper mutex. The grep `TEMP_SESSION_ID.*=.*'__` is a useful audit.
4. **`proc.stdin.write` guards need both `!destroyed` AND `exitCode === null` AND `signalCode === null`.** The three are not redundant — they cover different race windows. Also wrap the write in try/catch because even with guards, the kernel can report EPIPE synchronously.
5. **Live-test before spec-writing.** The test agent found the real behaviour in 10 minutes; the design spec would have built the wrong thing.

**Verification**: end-to-end Codex tests (basic message, sleep 15, sleep 20 with session switch) all passed after the three fixes, with zero new occurrences of `MaxListenersExceededWarning`, `write EPIPE`, or `model/list timed out` in `~/.codepilot/service.error.log`.

---

## 2026-04-17 — Near-miss: pdf skill overwritten during Phase 3a testing

**Severity**: High. User-visible data loss.
**Detection**: Caught because a session-start skill catalog snapshot showed `pdf: should be rejected` as the description — the payload from my "should this be rejected?" curl test. User recovered the file manually (no git backup, no Time Machine snapshot for that path).
**Root cause**: The first iteration of `detectSymlink` in `src/lib/codex-skill-fs.ts` used a single `fs.realpathSync(dir)` call to get the symlink target and then checked `target.startsWith(~/.claude/skills/)`. For the chain

```
~/.codex/skills/pdf  →  ~/.claude/skills/pdf  →  ~/.agents/skills/pdf (real)
```

`realpathSync` fully resolves and returns `~/.agents/skills/pdf` — **skipping the Claude hop entirely**. `claudeOwned` came back `false`, so `writeSkill`'s `if (sym?.claudeOwned)` guard did not fire, and the PUT wrote `should be rejected` to Claude's pdf skill file.

By the time the test completed, the subagent had already noticed the mismatch, added a hop-by-hop chain walker (`for (let i = 0; i < 8; i++) { fs.readlinkSync … }`), re-ran the PUT test, and observed a clean `409`. Result: **the regression test passed with the fixed code, but the damage from the broken iteration persisted on disk.**

**Why the safety net missed it**:
- No unit test for `detectSymlink` — chain-walking was added as a reactive fix with no test pinning the behaviour, so a future refactor could silently regress.
- Integration test relied on HTTP status codes, not on verifying the target file was byte-unchanged.
- No git or TM snapshot of `~/.agents/skills/*`.

**Remediation shipped in this same session**:
1. Added `src/lib/__tests__/codex-skill-fs.test.ts` with six tests, including a direct reproduction of the pdf chain (`codex → claude → agents`). **This test would have failed against the first-iteration code** and will fail again if the chain walker is ever removed.
2. The test also pins related behaviours: direct claude symlinks, relative-path symlinks, non-claude chains, real dirs, and circular-symlink termination.

**Lessons**:
1. **For any PUT/DELETE/write endpoint that touches shared files**, the curl smoke test MUST capture file size (or content hash) *before and after* a supposed-rejection and assert it's unchanged. HTTP 409 alone is not proof.
2. **`fs.realpathSync` loses information.** If intermediate hops matter (for ownership, provenance, or refusal-to-write reasons), walk the chain explicitly and inspect each hop. This applies to any future feature involving symlinked skills, MCP servers, or plugin directories.
3. **Symlink awareness must be tested, not reasoned-about.** Filesystem-level behaviour has too many edge cases (absolute vs relative targets, circular links, deep chains) to verify by inspection.
4. **When subagents report "the test passed after I fixed X," verify the pre-fix state was harmless.** In this case it wasn't.

---

## 2026-04-17 — Codex skills Phase 2/3 feasibility POC (GREEN with symlink caveat)

**Context**: Phase 1 of the Codex skills parity effort shipped (`79281ec`). This POC evaluates whether Phase 2 (enable toggle) and Phase 3 (edit/delete/create) are viable given Codex app-server constraints.

**Codex CLI version tested**: `codex-cli 0.120.0` on macOS arm64. (The CodePilot CLAUDE.md quotes a 0.121 changelog — that's a newer version than what's actually installed, but the v2 protocol schema on 0.120 already exposes all the primitives we need.)

### Findings

#### 1. Codex skills filesystem layout

- Skills live at `~/.codex/skills/<name>/SKILL.md` (with optional `references/`, `scripts/`, `assets/` siblings).
- SKILL.md uses YAML front matter with `name` and `description`, identical to Claude's format.
- Scopes observed: `user` (29), `system` (5). `repo` and `admin` not present in this session.
- `system`-scope skills are under `~/.codex/skills/.system/` (the dot-prefix marks them as Codex-shipped).
- **⚠️ Most `user`-scope skills are SYMLINKS**, not real files. Out of 29 user-scope skills, only `gh-fix-ci` is a real directory. The rest link to:
  - `~/.claude/skills/*` — shared with Claude
  - `~/.claude/plugins/marketplaces/fd-skills-marketplace/skills/*`
  - `~/.agents/skills/*`
- Editing a symlinked Codex skill silently mutates the underlying Claude / marketplace file. Non-obvious and potentially destructive.

#### 2. Enable/disable mechanism

- **No filesystem-based disable** (`config.toml` has no skills section; `enabled` is always `true` in the `skills/list` API response).
- **`skills/config/write` RPC exists in the v2 protocol and works on 0.120.** Live-verified:
  ```
  → skills/config/write { name: "gh-fix-ci", enabled: false }
  ← { effectiveEnabled: false }
  → skills/config/write { name: "gh-fix-ci", enabled: true }
  ← { effectiveEnabled: true }
  ```
- Selector: either `name` or `path` (absolute). Response: `{ effectiveEnabled: boolean }`.
- Persisted by Codex somewhere outside `config.toml` — exact location not investigated (not blocking, since the RPC is authoritative).

#### 3. Cache invalidation / refresh

- `skills/list` accepts `{ forceReload: true }` to bypass the in-process skills cache and re-scan disk.
- `skills/changed` notification is pushed by Codex when watched skill files change. Empty payload, treat as an invalidation signal and re-call `skills/list`.
- File watcher is built into Codex — no external tooling needed.

#### 4. Scope boundaries

- `.system/` directory is user-writable on disk (permissions: 755, owned by `party`), but the convention — enforced by the `scope: "system"` field in `skills/list` responses — is that users do not modify it. UI must enforce by disabling edit for `scope !== "user" && scope !== "repo"`.

#### 5. Bonus — Marketplace primitives exist

Protocol also exposes `plugin/list` and `plugin/install { marketplacePath, pluginName }`. Not needed for Phase 2/3 but sets up a clean Phase 4 (Codex marketplace install UI).

### Decision

| Phase | Verdict | Notes |
|-------|---------|-------|
| Phase 2 — enable toggle | **GREEN** | `skills/config/write` is the clean primitive. Zero filesystem hacks. Subscribe to `skills/changed` for auto-refresh. |
| Phase 3 — edit / delete / create | **YELLOW** | Possible, but blocked on solving the symlink ambiguity. Must: (a) `lstat` each Codex skill before offering edit, (b) route to the symlink target if it's a Claude skill and show a "shared with Claude" warning, (c) refuse edit on `system` / `admin` scope. Create / delete are less dangerous because they're new files in `~/.codex/skills/`. |
| Phase 4 — marketplace install (out of current scope) | not evaluated | `plugin/install` RPC exists. Revisit later. |

### Recommendation

Proceed with **Phase 2** as the next spec. It's the cleanest win: a single new RPC call, auto-refresh via push notification, no filesystem concerns, and closes the biggest UX gap (users can't currently turn off Codex skills).

**Hold Phase 3** until Phase 2 ships and we have a design for the symlink-ambiguity UX. Options to explore:
- Detect symlinks and unify the editor with Claude's skill editor (single source of truth).
- Disable edit-from-Codex-tab on symlinked skills; link user to the Claude tab instead.
- Show a prominent "this file is shared with Claude — edits affect both" banner.

### What we learned more generally

- **Always generate the protocol schema from the CLI** (`codex app-server generate-json-schema --out <dir>`) when doing feasibility work. Saved us an afternoon of guessing.
- **Codex 0.120 already has the v2 skills primitives.** The changelog language around 0.121 "more reliable plugin cache refreshes" is about reliability improvements, not new APIs.
- **Symlink-heavy skill installations are the norm**, not the exception. Any multi-backend tooling that edits skills must handle this from day one.
