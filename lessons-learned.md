# Lessons Learned

Debugging notes and post-mortems. Chronological, newest first.

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
