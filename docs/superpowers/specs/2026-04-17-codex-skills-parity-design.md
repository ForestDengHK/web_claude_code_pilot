# Codex Skills Parity Design

## Goal

Bring Codex skills to the `/extensions` UI at parity with Claude skills (read / enable / edit / delete / create), under an extensible provider-registry architecture that accommodates future backends (Gemini, etc.) with zero UI-layer changes.

Shipped in three phases, gated on feasibility. **Phase 1 (read-only) is the only phase covered by this spec.** Phase 2 (enable toggle) and Phase 3 (edit/delete/create) are scoped out pending a post–Phase 1 feasibility POC.

## Principles

- **OCP**: Adding a new backend = adding one provider module + one line in a registry index. `ExtensionsPage` never learns about specific backends.
- **Non-breaking**: Phase 1 touches zero existing Claude code paths. `/api/skills*` routes, `SkillsManager.tsx`, `/` command autocomplete, MCP tab, Plugins tab — all unchanged.
- **YAGNI**: No unified skill editor, no cross-backend copy, no marketplace install. Those are separate specs if/when Phase 2/3 prove feasible.
- **Feasibility gate**: Phase 1 DoD includes a 45-minute POC that decides whether Phase 2/3 are even possible given Codex app-server constraints.

## Non-Goals (Phase 1)

- Editing / deleting / creating Codex skills from the UI (Phase 3).
- Enable/disable toggle for Codex skills (Phase 2).
- Installing Codex plugins from GitHub / git / local (Codex 0.121 marketplace — separate spec).
- Unifying Claude's "file-exists = enabled" model with Codex's explicit `enabled` field.
- Any change to `/` command autocomplete in `MessageInput.tsx` (already works across both backends).

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  ExtensionsPage  (existing — minimal change)            │
│  Outer tabs: [Skills] [MCP Servers] [Plugins]           │
└──────────────────┬──────────────────────────────────────┘
                   │ (Skills tab body replaced)
                   ▼
┌─────────────────────────────────────────────────────────┐
│  ProviderSkillsTabs  (NEW)                              │
│  Inner tabs: [Claude] [Codex] [<future backends>]       │
└──────────────────┬──────────────────────────────────────┘
                   │ reads
                   ▼
┌─────────────────────────────────────────────────────────┐
│  SKILL_PROVIDERS registry                               │
│  src/lib/skill-providers/index.ts                       │
│                                                         │
│    [claudeSkillProvider, codexSkillProvider, ...]       │
└─────────────────────────────────────────────────────────┘
```

### Provider interface

```ts
// src/lib/skill-providers/types.ts

export interface UnifiedSkill {
  id: string;            // stable within a provider (e.g. Codex path or Claude name)
  name: string;
  description: string;
  enabled: boolean;
}

export interface SkillCapabilities {
  read: boolean;         // can list + view content
  enableToggle: boolean; // Phase 2
  edit: boolean;         // Phase 3
  create: boolean;       // Phase 3
}

export interface SkillProvider {
  id: 'claude' | 'codex' | string;
  label: string;
  icon?: React.ReactNode;
  capabilities: SkillCapabilities;
  /** Async probe — false => tab is not rendered. Must never throw. */
  isAvailable: () => Promise<boolean>;
  /** Owns its own fetch, error state, and rendering. */
  ListComponent: React.ComponentType;
}
```

### Files

**New**

| Path | Purpose |
|------|---------|
| `src/lib/skill-providers/types.ts` | `UnifiedSkill`, `SkillCapabilities`, `SkillProvider` |
| `src/lib/skill-providers/claude.tsx` | Thin wrapper around existing `SkillsManager`. Capabilities `{ read, enableToggle, edit, create: all true }` |
| `src/lib/skill-providers/codex.tsx` | New provider. Capabilities `{ read: true, rest: false }` for Phase 1 |
| `src/lib/skill-providers/index.ts` | Exports `SKILL_PROVIDERS` array and `useAvailableSkillProviders()` hook |
| `src/components/skills/CodexSkillsList.tsx` | Phase 1 read-only list with detail drawer. Visual parity with existing `SkillListItem` |
| `src/components/skills/ProviderSkillsTabs.tsx` | Consumes registry, renders inner tabs, wraps each panel in an Error Boundary |
| `src/lib/__tests__/skill-providers.test.ts` | Registry shape, `isAvailable` contract, mock-provider extension test |
| `src/lib/__tests__/codex-skill-provider.test.ts` | Fetch paths: success / 500 / `available: false` / timeout |

**Modified (minimal)**

| Path | Change |
|------|--------|
| `src/app/extensions/page.tsx` | `{tab === "skills" && <ProviderSkillsTabs />}` replaces `<SkillsManager />`. MCP/Plugins tabs untouched. |
| `src/app/api/codex/skills/route.ts` | Accept `?probe=1`. When set, return `{ available: boolean }` fast (no process spawn) based on `which codex` check. Existing behavior untouched for non-probe calls. |

**Explicitly NOT modified**

- `src/components/skills/SkillsManager.tsx`, `SkillEditor.tsx`, `CreateSkillDialog.tsx`, `SkillListItem.tsx`
- `src/app/api/skills/route.ts`, `src/app/api/skills/[name]/route.ts`
- `src/components/chat/MessageInput.tsx` (already cross-backend for `/` autocomplete)
- `src/app/api/plugins/*`, `src/components/plugins/*`

## Data Flow (Phase 1, read-only)

```
User opens /extensions, Skills tab
  │
  ▼
ProviderSkillsTabs mounts
  │  useAvailableSkillProviders():
  │    for each provider: await provider.isAvailable()
  │    claudeSkillProvider  → true  (always default)
  │    codexSkillProvider   → GET /api/codex/skills?probe=1 → { available: boolean }
  │
  ▼
Render inner tabs for available providers only. Default-select first.
  │
  ▼  (user clicks Codex tab)
<codexSkillProvider.ListComponent />
  │  useEffect(): fetch('/api/codex/skills?cwd=<current chat cwd | omit>')
  │    existing route: 5-min TTL, in-flight mutex, 15s RPC timeout
  │  states:
  │    loading → spinner
  │    ok      → list of skills (virtualized if > 50 items)
  │    empty   → "No Codex skills installed" + docs link
  │    error   → error card with [Retry]
  │
  ▼  (user clicks a row)
Read-only drawer showing name / description / scope / content.
No write actions visible.
```

### `cwd` resolution

- If a chat session is active, use its working directory (same as `/api/codex/skills` today when called from chat).
- If opened directly from nav with no active session, omit `cwd`. Codex returns `system` + `user` scope skills only (no repo skills). Acceptable for Phase 1.

## Error Handling

| Scenario | UI behavior | Invariant |
|----------|-------------|-----------|
| Codex CLI not on PATH | Codex tab not rendered. Skills tab shows only Claude. | Identical to current user experience. |
| `/api/codex/skills` returns 500 | Codex tab visible; panel shows error card with `[Retry]`. | Never crashes Skills tab. |
| `skills/list` RPC times out (15s, existing) | Same as 500. | — |
| Empty skill list | Friendly empty state + link to Codex docs. | Not treated as error. |
| Provider's `ListComponent` throws during render | React Error Boundary around each `<ProviderTabPanel>` contains the failure; other provider tabs remain usable. | One provider cannot break another. |
| Probe endpoint fails | Treated as `available: false`; tab hidden. | Never red-screens. |

### Non-negotiable invariants

1. Any Codex-side failure **never** affects Claude tab rendering.
2. `isAvailable()` must **never throw**; exceptions are caught and coerced to `false`.
3. Zero changes to existing Claude code paths in Phase 1. Verified via `git diff`.

## Mobile Considerations

- Inner tabs use compact styling (one size smaller than outer tabs) to avoid vertical stacking on narrow screens.
- If only one provider is available, inner tabs still render for consistency. Hiding the inner tab row when `providers.length === 1` is **Phase 2 polish**, not Phase 1.
- Tested on Tailscale-served mobile client per project convention.

## Testing Strategy

### Automated (Vitest/Jest, existing stack)

- `src/lib/__tests__/skill-providers.test.ts`
  - `SKILL_PROVIDERS` array is non-empty and contains `claude` provider
  - A mock `SkillProvider` can be added without touching `ExtensionsPage` or `ProviderSkillsTabs` source
  - `isAvailable()` returning `false` excludes the provider from the rendered list
  - `isAvailable()` that throws is coerced to `false`
- `src/lib/__tests__/codex-skill-provider.test.ts`
  - Fetch success → skills rendered
  - Fetch 500 → error state, list not rendered
  - Fetch `{ available: false }` → `isAvailable()` returns false
  - Fetch timeout → error state with retry available

### Manual (dev + production)

Each item below must pass on `:4000` (dev, HMR) **and** `:4001` (production, after `./scripts/rebuild-production.sh`):

1. `/extensions` → Skills tab shows both Claude and Codex inner tabs
2. Codex tab list count matches `codex skills list` CLI output
3. Clicking a Codex skill opens read-only detail drawer with full content
4. Claude tab: create / edit / delete / list all still work (regression)
5. MCP Servers tab and Plugins tab unchanged
6. `/` command autocomplete in chat still lists skills from both backends
7. With `codex` binary removed from PATH: Codex tab gone, Claude tab normal
8. Injected failure on `/api/codex/skills`: error card with retry, no red screen, Claude tab still fine
9. Empty Codex skills directory: friendly empty state
10. Mobile (real phone over Tailscale): inner tabs readable, list scrolls, detail drawer fits viewport

## Phase 1 Definition of Done

- All automated tests above pass
- All 10 manual checks pass on both `:4000` and `:4001`
- `git diff main` shows new files + exactly one replacement in `extensions/page.tsx` + additive `?probe=1` branch in `/api/codex/skills/route.ts`. No edits to any file listed in "Explicitly NOT modified."
- `npm run build` succeeds (standalone output)
- Feasibility POC below completed with a written decision

## Post-Phase-1 Feasibility POC

Before writing a Phase 2/3 spec, spend up to 45 minutes answering:

1. **Codex skill filesystem layout**
   - Inspect `~/.codex/skills/` on the dev box.
   - Are skills single `SKILL.md` files, directories, or something else? Is there a manifest (`plugin.json`)?
   - Can we `fs.writeFileSync` to them the way Claude's `/api/skills/[name]` PUT does?

2. **Cache invalidation after edit**
   - Edit a Codex skill file directly. Start a new Codex chat turn. Does Codex see the change?
   - If no: is there a `skills/refresh` RPC in Codex 0.121? (Changelog mentions "more reliable plugin cache refreshes.")
   - Fallback: can killing the temp `TEMP_SESSION_ID` process force a reload on next spawn?

3. **Scope enforcement**
   - Do `system` and `admin` scope skills live under user-writable paths? (They shouldn't — those are Codex-shipped.)
   - Confirm `user` and `repo` scope are the only writable categories.

**Outcome — pick one and record in `lessons-learned.md`:**

- **Green**: Write Phase 2/3 spec and continue.
- **Yellow**: Write Phase 2/3 spec with a documented precondition (e.g. "requires Reload Skills button because refresh RPC is missing").
- **Red**: Stop at Phase 1. Record findings. Revisit when Codex upstream exposes the missing primitive.

## Open Questions (answerable during implementation)

- Icon for Codex tab: reuse existing Codex brand asset from `components/chat/` or Hugeicons stand-in? (UI polish; either works for Phase 1.)
- Virtualization threshold for the skill list: 50 items is a guess. Confirm on real data.

## Out of Scope (separate specs if/when needed)

- Memory control frontend (Task B of the broader Codex update borrowing effort)
- Realtime V2 background progress → SSE (Task C)
- Codex marketplace install from GitHub / git / local (Codex 0.121 feature)
- In-browser preview panel (browser-native advantage over Codex desktop app)
