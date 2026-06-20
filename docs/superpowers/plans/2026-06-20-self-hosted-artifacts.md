# Self-Hosted Artifacts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CodePilot-native artifacts feature: `/artifact` produces a self-contained interactive HTML "run digest", an in-process MCP tool publishes it to a versioned store, and a hardened sandboxed panel renders it.

**Architecture:** A new in-process SDK MCP tool `publish_artifact` (mirroring `src/lib/spawn-subagents-mcp.ts`) reads a model-written `.html`, copies it into `~/.codepilot/artifacts/<id>/v<N>.html`, records metadata in two new SQLite tables, and returns `{artifact_id, version, internal_url}`. `claude-client.ts` registers the tool and emits an `artifact_published` SSE event on its result. The frontend renders the artifact in a hardened iframe (`srcDoc` + `sandbox="allow-scripts"` + CSP), opened via the existing panel system.

**Tech Stack:** Next.js (app router), better-sqlite3, `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`/`tool`/zod), React, vitest.

---

## Deviations from the design spec (2026-06-20-self-hosted-artifacts-design.md)

1. **In-process MCP tool, not an external script.** Spec said `scripts/artifacts-mcp-server.mjs`. We use an **in-process** SDK MCP server `src/lib/artifacts-mcp.ts`, mirroring the established `src/lib/spawn-subagents-mcp.ts` precedent. Reason: direct DB + filesystem access, no subprocess/HTTP hop, registered exactly like `codepilot-subagents` at `claude-client.ts:495-528`. Strictly better; everything else in the spec is unchanged.

Everything else follows the spec: native `/artifact` trigger, two-phase (v1 in-app panel, no public URL/live), snapshot + re-trigger, versioned store, hardened sandbox, run-digest as the primary type.

---

## File Structure

**Create:**
- `src/lib/artifacts.ts` — store module: tables-agnostic CRUD over `artifacts`/`artifact_versions` + filesystem writes. One responsibility: persist & retrieve artifacts.
- `src/lib/artifacts-mcp.ts` — in-process MCP server exposing `publish_artifact` + the system-prompt fragment.
- `src/app/api/artifacts/route.ts` — `GET` list artifacts for a project.
- `src/app/api/artifacts/[id]/route.ts` — `GET` one artifact version's HTML (as `text/plain`) + version list.
- `src/components/layout/ArtifactView.tsx` — hardened renderer + version dropdown + "update" button.
- Test files under `src/__tests__/unit/`.

**Modify:**
- `src/lib/db.ts:91-178` (`initDb`) — add two `CREATE TABLE` statements.
- `src/lib/claude-client.ts:528` — register the artifacts MCP + auto-allow + prompt fragment; and `:786-823` — emit `artifact_published`.
- `src/types/index.ts:433-453` — add `'artifact_published'` to `SSEEventType` + an `ArtifactPublishedEvent` interface.
- `src/hooks/useSSEStream.ts:34-54,78+` — add `onArtifactPublished` callback + `case`.
- `src/hooks/usePanel.ts:22-49` — add `artifactPreview` state to the context type.
- `src/components/layout/AppShell.tsx:268-389` — hold `artifactPreview` state + render `ArtifactView`.
- `src/components/chat/MessageInput.tsx:133-156` — add `/artifact` command + `COMMAND_PROMPTS` entry.
- The `useSSEStream` consumer (ChatView) — wire `onArtifactPublished` → open panel.

---

# Increment 1 — Storage, MCP tool, SSE (no UI)

Produces a working backend: `/artifact` (added in Inc 2) aside, the tool + store + event are independently testable.

## Task 1: Database tables

**Files:**
- Modify: `src/lib/db.ts:178` (end of the `db.exec` template in `initDb`)
- Test: `src/__tests__/unit/artifacts-store.test.ts` (created in Task 2; tables are exercised there)

- [ ] **Step 1: Add the two tables** inside the existing `db.exec(\`...\`)` in `initDb`, before the closing `` ); `` at line 178 (after the `organize_session_cache` table, alongside the other `CREATE TABLE IF NOT EXISTS`):

```sql
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      favicon TEXT NOT NULL DEFAULT '📄',
      current_version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS artifact_versions (
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      path TEXT NOT NULL,
      label TEXT,
      byte_size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (artifact_id, version),
      FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_project_id ON artifacts(project_id);
```

- [ ] **Step 2: Verify it compiles** — `npx tsc --noEmit` (Expected: no new errors). Tables are `IF NOT EXISTS`, so no migration entry is needed for fresh DBs.

- [ ] **Step 3: Commit**

```bash
git add src/lib/db.ts
git commit -m "feat(artifacts): add artifacts + artifact_versions tables"
```

## Task 2: Artifacts store module

**Files:**
- Create: `src/lib/artifacts.ts`
- Test: `src/__tests__/unit/artifacts-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/__tests__/unit/artifacts-store.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-artifacts-'));
  process.env.CLAUDE_GUI_DATA_DIR = tmp;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.CLAUDE_GUI_DATA_DIR;
});

describe('artifacts store', () => {
  it('creates v1 on first publish and writes the html file', async () => {
    const { publishArtifact, getArtifactHtml } = await import('../../lib/artifacts');
    const { artifactId, version } = publishArtifact({
      html: '<html><body>hello</body></html>',
      title: 'Incident Report',
      favicon: '🚨',
      projectId: '/proj',
    });
    expect(version).toBe(1);
    expect(artifactId).toBe('incident-report');
    expect(getArtifactHtml(artifactId, 1)).toContain('hello');
  });

  it('appends a new version when given an existing artifact_id', async () => {
    const { publishArtifact, listVersions } = await import('../../lib/artifacts');
    const first = publishArtifact({ html: '<p>a</p>', title: 'Run Digest', favicon: '📊', projectId: '/proj' });
    const second = publishArtifact({ html: '<p>b</p>', title: 'Run Digest', favicon: '📊', projectId: '/proj', artifactId: first.artifactId });
    expect(second.artifactId).toBe(first.artifactId);
    expect(second.version).toBe(2);
    expect(listVersions(first.artifactId).map(v => v.version)).toEqual([1, 2]);
  });

  it('disambiguates slugs for distinct artifacts with the same title', async () => {
    const { publishArtifact } = await import('../../lib/artifacts');
    const a = publishArtifact({ html: '<p>a</p>', title: 'Report', favicon: '📄', projectId: '/proj' });
    const b = publishArtifact({ html: '<p>b</p>', title: 'Report', favicon: '📄', projectId: '/proj' });
    expect(a.artifactId).toBe('report');
    expect(b.artifactId).toBe('report-2');
  });

  it('lists artifacts for a project, newest first', async () => {
    const { publishArtifact, listArtifacts } = await import('../../lib/artifacts');
    publishArtifact({ html: '<p>x</p>', title: 'One', favicon: '📄', projectId: '/proj' });
    publishArtifact({ html: '<p>y</p>', title: 'Two', favicon: '📄', projectId: '/other' });
    const list = listArtifacts('/proj');
    expect(list.map(a => a.title)).toEqual(['One']);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/unit/artifacts-store.test.ts`
Expected: FAIL — `Cannot find module '../../lib/artifacts'`.

- [ ] **Step 3: Implement `src/lib/artifacts.ts`**

```ts
// src/lib/artifacts.ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb } from './db';

export interface ArtifactMeta {
  id: string;
  projectId: string;
  title: string;
  favicon: string;
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactVersionMeta {
  artifactId: string;
  version: number;
  path: string;
  label: string | null;
  byteSize: number;
  createdAt: string;
}

export interface PublishInput {
  html: string;
  title: string;
  favicon: string;
  projectId: string;
  label?: string;
  /** When set and the artifact exists, append a new version instead of creating one. */
  artifactId?: string;
}

function artifactsDir(): string {
  const dataDir = process.env.CLAUDE_GUI_DATA_DIR || path.join(os.homedir(), '.codepilot');
  return path.join(dataDir, 'artifacts');
}

function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'artifact'
  );
}

function uniqueSlug(base: string): string {
  const db = getDb();
  const exists = db.prepare('SELECT 1 FROM artifacts WHERE id = ?');
  if (!exists.get(base)) return base;
  let n = 2;
  while (exists.get(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function publishArtifact(input: PublishInput): { artifactId: string; version: number } {
  const db = getDb();
  const now = new Date().toISOString();
  let artifactId = input.artifactId;
  let version: number;

  const existing = artifactId
    ? (db.prepare('SELECT current_version FROM artifacts WHERE id = ?').get(artifactId) as
        | { current_version: number }
        | undefined)
    : undefined;

  if (artifactId && existing) {
    version = existing.current_version + 1;
    db.prepare('UPDATE artifacts SET title=?, favicon=?, current_version=?, updated_at=? WHERE id=?').run(
      input.title,
      input.favicon,
      version,
      now,
      artifactId,
    );
  } else {
    artifactId = uniqueSlug(slugify(input.title));
    version = 1;
    db.prepare(
      'INSERT INTO artifacts (id, project_id, title, favicon, current_version, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    ).run(artifactId, input.projectId, input.title, input.favicon, version, now, now);
  }

  const dir = path.join(artifactsDir(), artifactId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `v${version}.html`);
  fs.writeFileSync(filePath, input.html, 'utf8');
  const byteSize = Buffer.byteLength(input.html, 'utf8');

  db.prepare(
    'INSERT INTO artifact_versions (artifact_id, version, path, label, byte_size, created_at) VALUES (?,?,?,?,?,?)',
  ).run(artifactId, version, filePath, input.label ?? null, byteSize, now);

  return { artifactId, version };
}

export function listArtifacts(projectId: string): ArtifactMeta[] {
  const rows = getDb()
    .prepare('SELECT * FROM artifacts WHERE project_id = ? ORDER BY updated_at DESC')
    .all(projectId) as Record<string, unknown>[];
  return rows.map(rowToMeta);
}

export function getArtifact(artifactId: string): ArtifactMeta | null {
  const row = getDb().prepare('SELECT * FROM artifacts WHERE id = ?').get(artifactId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToMeta(row) : null;
}

export function listVersions(artifactId: string): ArtifactVersionMeta[] {
  const rows = getDb()
    .prepare('SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version ASC')
    .all(artifactId) as Record<string, unknown>[];
  return rows.map((r) => ({
    artifactId: r.artifact_id as string,
    version: r.version as number,
    path: r.path as string,
    label: (r.label as string) ?? null,
    byteSize: r.byte_size as number,
    createdAt: r.created_at as string,
  }));
}

export function getArtifactHtml(artifactId: string, version?: number): string | null {
  const db = getDb();
  const ver =
    version ??
    (db.prepare('SELECT current_version FROM artifacts WHERE id = ?').get(artifactId) as
      | { current_version: number }
      | undefined)?.current_version;
  if (!ver) return null;
  const row = db
    .prepare('SELECT path FROM artifact_versions WHERE artifact_id = ? AND version = ?')
    .get(artifactId, ver) as { path: string } | undefined;
  if (!row) return null;
  try {
    return fs.readFileSync(row.path, 'utf8');
  } catch {
    return null;
  }
}

function rowToMeta(r: Record<string, unknown>): ArtifactMeta {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    title: r.title as string,
    favicon: r.favicon as string,
    currentVersion: r.current_version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/unit/artifacts-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/artifacts.ts src/__tests__/unit/artifacts-store.test.ts
git commit -m "feat(artifacts): add versioned artifact store module"
```

## Task 3: In-process `publish_artifact` MCP tool

**Files:**
- Create: `src/lib/artifacts-mcp.ts`
- Test: `src/__tests__/unit/artifacts-mcp.test.ts`

- [ ] **Step 1: Write the failing test** (tests the handler's effect via the store, not the SDK wire)

```ts
// src/__tests__/unit/artifacts-mcp.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmp: string;
let cwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-artmcp-'));
  process.env.CLAUDE_GUI_DATA_DIR = tmp;
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-cwd-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(cwd, { recursive: true, force: true });
  delete process.env.CLAUDE_GUI_DATA_DIR;
});

describe('publish_artifact tool', () => {
  it('reads the html file and persists an artifact, returning JSON', async () => {
    const { runPublishArtifact } = await import('../../lib/artifacts-mcp');
    fs.writeFileSync(path.join(cwd, 'digest.html'), '<html><body>run digest</body></html>');
    const out = await runPublishArtifact(
      { cwd, projectId: cwd },
      { file_path: 'digest.html', title: 'Run Digest', favicon: '📊' },
    );
    const payload = JSON.parse(out.text);
    expect(out.isError).toBeUndefined();
    expect(payload.artifact_id).toBe('run-digest');
    expect(payload.version).toBe(1);
    expect(payload.internal_url).toBe('/api/artifacts/run-digest?version=1');
  });

  it('returns an error result when the file is missing', async () => {
    const { runPublishArtifact } = await import('../../lib/artifacts-mcp');
    const out = await runPublishArtifact({ cwd, projectId: cwd }, { file_path: 'nope.html', title: 'X', favicon: '📄' });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('cannot read');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/unit/artifacts-mcp.test.ts`
Expected: FAIL — `Cannot find module '../../lib/artifacts-mcp'`.

- [ ] **Step 3: Implement `src/lib/artifacts-mcp.ts`**

The pure logic lives in `runPublishArtifact` (unit-testable); `createArtifactsMcp` wraps it in the SDK `tool()` exactly like `spawn-subagents-mcp.ts:84-210`.

```ts
// src/lib/artifacts-mcp.ts
import fs from 'fs';
import path from 'path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { publishArtifact } from './artifacts';

export interface ArtifactsMcpConfig {
  /** Working directory the model writes the html into; relative file_path resolves here. */
  cwd: string;
  /** Project key the artifact is associated with (CodePilot uses the working directory). */
  projectId: string;
}

export interface PublishArtifactArgs {
  file_path: string;
  title: string;
  favicon?: string;
  label?: string;
  artifact_id?: string;
}

/** Pure handler — shared by the SDK tool and unit tests. */
export async function runPublishArtifact(
  config: ArtifactsMcpConfig,
  args: PublishArtifactArgs,
): Promise<{ text: string; isError?: true }> {
  const abs = path.isAbsolute(args.file_path) ? args.file_path : path.join(config.cwd, args.file_path);
  let html: string;
  try {
    html = fs.readFileSync(abs, 'utf8');
  } catch {
    return { text: `ERROR: cannot read file_path "${args.file_path}". Write the self-contained HTML file first, then call publish_artifact with its path.`, isError: true };
  }
  const favicon = args.favicon?.trim() || '📄';
  const { artifactId, version } = publishArtifact({
    html,
    title: args.title,
    favicon,
    label: args.label,
    projectId: config.projectId,
    artifactId: args.artifact_id,
  });
  return {
    text: JSON.stringify({
      artifact_id: artifactId,
      version,
      internal_url: `/api/artifacts/${artifactId}?version=${version}`,
      title: args.title,
      favicon,
    }),
  };
}

const ARTIFACT_TOOL_DESCRIPTION = [
  'Publish a self-contained HTML file as a shareable, versioned CodePilot artifact and return its internal URL.',
  '',
  'The file MUST be a single self-contained .html (inline all CSS/JS, embed all data, NO external network requests or CDN links) because it is rendered in a locked-down sandbox with a strict CSP that blocks all external network access.',
  'Pass artifact_id to publish a NEW VERSION of an existing artifact (same URL, version picker keeps the old one); omit it to create a new artifact.',
].join('\n');

export function createArtifactsMcp(config: ArtifactsMcpConfig): McpSdkServerConfigWithInstance {
  const publishTool = tool(
    'publish_artifact',
    ARTIFACT_TOOL_DESCRIPTION,
    {
      file_path: z.string().min(1).describe('Path to the self-contained .html file to publish (relative to cwd or absolute).'),
      title: z.string().min(1).describe('Short human-readable title; also the browser-tab title and the basis for the artifact id/slug.'),
      favicon: z.string().optional().describe('One or two emoji for the browser-tab icon, e.g. "📊". No markup.'),
      label: z.string().optional().describe('Short name for this version, shown in the version picker (e.g. "after-fix").'),
      artifact_id: z.string().optional().describe('Existing artifact id to publish a new version to. Omit for a new artifact.'),
    },
    async (args) => {
      const out = await runPublishArtifact(config, args as PublishArtifactArgs);
      return { content: [{ type: 'text', text: out.text }], ...(out.isError ? { isError: true } : {}) };
    },
    { alwaysLoad: true },
  );
  return createSdkMcpServer({ name: 'codepilot-artifacts', version: '1.0.0', tools: [publishTool] });
}

export const ARTIFACTS_PROMPT_FRAGMENT = `

# Publishing artifacts — \`mcp__codepilot-artifacts__publish_artifact\`

When the user runs \`/artifact\` (or asks you to "make an artifact / page / dashboard / digest"), build a **single self-contained interactive HTML file** and publish it with this tool.

## Content — a mid-altitude run digest by default
Default to a **digest of the work you just did at medium granularity** (progressive disclosure):
- Up front, the throughline: what the goal was, the key decisions, what changed and why.
- Collapsible sections for detail (diffs, tried-and-rejected paths, open questions) — overview expanded, detail folded.
- Not the final answer only (too little), not a replay of every step (too much).
Other shapes (dashboard you can filter/sort, PR walkthrough, checklist) are fine when the user asks for them — same tool.

## Hard constraints (the sandbox enforces these)
- ONE self-contained .html: inline ALL CSS and JS, embed ALL data. NO external \`<script src>\`, CDN, fonts, or network calls — they are blocked by CSP and will silently fail.
- Interactivity via inline \`<script>\` is allowed (filter/sort/collapse).

## How to publish
1. Write the file into a dated summary directory in the working directory (e.g. \`artifacts-summary/YYYY-MM-DD/artifact-digest.html\`).
2. Call \`publish_artifact({ file_path, title, favicon })\`.
3. To update an artifact later, call again with its \`artifact_id\` — that adds a new version at the same URL.
`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/unit/artifacts-mcp.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/artifacts-mcp.ts src/__tests__/unit/artifacts-mcp.test.ts
git commit -m "feat(artifacts): add in-process publish_artifact MCP tool"
```

## Task 4: Register the tool in claude-client.ts

**Files:**
- Modify: `src/lib/claude-client.ts` (imports near `:29`; registration after the spawn-subagents block ending `:528`; prompt-fragment append site)

- [ ] **Step 1: Add the import** next to the spawn-subagents import at line 29:

```ts
import { createArtifactsMcp, ARTIFACTS_PROMPT_FRAGMENT } from './artifacts-mcp';
```

- [ ] **Step 2: Register the MCP + auto-allow** immediately after the spawn-subagents `if (spawnSubagentsEnabled) { ... }` block closes at line 528, mirroring it:

```ts
        // Inject the in-process `publish_artifact` MCP server unless disabled.
        const artifactsEnabled = getSetting('enable_artifacts') !== 'false';
        if (artifactsEnabled) {
          const artifactsMcp = createArtifactsMcp({
            cwd: (queryOptions.cwd as string) ?? workingDirectory,
            projectId: workingDirectory,
          });
          queryOptions.mcpServers = {
            ...(queryOptions.mcpServers ?? {}),
            'codepilot-artifacts': artifactsMcp,
          };
          queryOptions.allowedTools = [
            ...(queryOptions.allowedTools ?? []),
            'mcp__codepilot-artifacts__publish_artifact',
          ];
        }
```

- [ ] **Step 3: Append the prompt fragment.** Locate where `SPAWN_SUBAGENTS_PROMPT_FRAGMENT` is concatenated onto `queryOptions.systemPrompt` (search the file: `grep -n SPAWN_SUBAGENTS_PROMPT_FRAGMENT src/lib/claude-client.ts`). Append `ARTIFACTS_PROMPT_FRAGMENT` in the same expression, e.g. change `... + SPAWN_SUBAGENTS_PROMPT_FRAGMENT` to `... + SPAWN_SUBAGENTS_PROMPT_FRAGMENT + ARTIFACTS_PROMPT_FRAGMENT`. Gate it behind `artifactsEnabled` if the spawn fragment is similarly gated.

- [ ] **Step 4: Verify it compiles** — `npx tsc --noEmit` (Expected: no new errors).

- [ ] **Step 5: Commit**

```bash
git add src/lib/claude-client.ts
git commit -m "feat(artifacts): register publish_artifact MCP + prompt fragment"
```

## Task 5: Emit the `artifact_published` SSE event

**Files:**
- Modify: `src/types/index.ts:433-453` (union) + `~:513` (interface)
- Modify: `src/lib/claude-client.ts:769` (map), `:786-797` (record name), `:806-823` (emit)
- Modify: `src/hooks/useSSEStream.ts:34-54` (callback) + `:104` (case)
- Test: `src/__tests__/unit/artifact-sse-mapping.test.ts`

- [ ] **Step 1: Add the SSE type + interface** in `src/types/index.ts`. In the `SSEEventType` union (after `'channel_queue'`, ~line 452) add:

```ts
  | 'artifact_published'
```

And after the `InputRequestEvent`/`InputResponseRequest` interfaces (~line 513) add:

```ts
export interface ArtifactPublishedEvent {
  artifactId: string;
  version: number;
  internalUrl: string;
  title?: string;
  favicon?: string;
}
```

- [ ] **Step 2: Correlate tool name → result and emit** in `src/lib/claude-client.ts`. Before the `for await (const message of conversation)` loop (~line 769) add:

```ts
        const toolNamesById = new Map<string, string>();
```

In the `case 'assistant':` `tool_use` loop (after the existing `controller.enqueue({type:'tool_use', ...})` at ~line 794) record the name:

```ts
            toolNamesById.set(block.id, block.name);
```

In the `case 'user':` `tool_result` branch, after the existing `controller.enqueue({type:'tool_result', ...})` (~line 822) add:

```ts
            const publishedToolName = toolNamesById.get(block.tool_use_id) ?? '';
            if (publishedToolName.endsWith('__publish_artifact')) {
              try {
                const ap = JSON.parse(resultContent);
                if (ap && ap.artifact_id) {
                  controller.enqueue(formatSSE({
                    type: 'artifact_published',
                    data: JSON.stringify({
                      artifactId: ap.artifact_id,
                      version: ap.version,
                      internalUrl: ap.internal_url,
                      title: ap.title,
                      favicon: ap.favicon,
                    }),
                  }));
                }
              } catch {
                // tool_result wasn't our JSON (e.g. an error string) — tool_result already emitted; skip.
              }
            }
```

- [ ] **Step 3: Add the frontend callback + case** in `src/hooks/useSSEStream.ts`. In the `SSECallbacks` interface (~line 47, near `onHeartbeat`) add:

```ts
  onArtifactPublished?: (data: ArtifactPublishedEvent) => void;
```

Import the type at the top of the file (alongside the other `*Event` imports from `@/types`). Then in the `switch (event.type)` add a case (after `case 'tool_result':` block, ~line 117):

```ts
    case 'artifact_published': {
      try {
        callbacks.onArtifactPublished?.(JSON.parse(event.data));
      } catch {
        // ignore malformed payloads
      }
      break;
    }
```

- [ ] **Step 4: Write the mapping test**

```ts
// src/__tests__/unit/artifact-sse-mapping.test.ts
import { describe, it, expect, vi } from 'vitest';
import { processSSEEvent } from '../../hooks/useSSEStream';

function noopCallbacks(overrides = {}) {
  return {
    onText: vi.fn(), onThinking: vi.fn(), onToolUse: vi.fn(), onToolResult: vi.fn(),
    onToolOutput: vi.fn(), onToolProgress: vi.fn(), onStatus: vi.fn(), onResult: vi.fn(),
    onPermissionRequest: vi.fn(), onInputRequest: vi.fn(), onToolTimeout: vi.fn(), onError: vi.fn(),
    ...overrides,
  };
}

describe('artifact_published SSE mapping', () => {
  it('parses the payload and invokes onArtifactPublished', () => {
    const onArtifactPublished = vi.fn();
    processSSEEvent(
      { type: 'artifact_published', data: JSON.stringify({ artifactId: 'run-digest', version: 2, internalUrl: '/api/artifacts/run-digest?version=2', title: 'Run Digest', favicon: '📊' }) },
      '',
      noopCallbacks({ onArtifactPublished }) as never,
    );
    expect(onArtifactPublished).toHaveBeenCalledWith(expect.objectContaining({ artifactId: 'run-digest', version: 2 }));
  });
});
```

> Note: confirm the exact exported name/signature of the event processor (`grep -n "export function process\|export const process" src/hooks/useSSEStream.ts`) and adjust the import/args to match (the switch lives in that function, ~line 76).

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/__tests__/unit/artifact-sse-mapping.test.ts && npx tsc --noEmit`
Expected: PASS + no new type errors.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/lib/claude-client.ts src/hooks/useSSEStream.ts src/__tests__/unit/artifact-sse-mapping.test.ts
git commit -m "feat(artifacts): emit and route artifact_published SSE event"
```

---

# Increment 2 — API + frontend panel

## Task 6: API routes

**Files:**
- Create: `src/app/api/artifacts/route.ts`
- Create: `src/app/api/artifacts/[id]/route.ts`

- [ ] **Step 1: List route** — `src/app/api/artifacts/route.ts`:

```ts
import { NextRequest, NextResponse } from 'next/server';
import { listArtifacts } from '@/lib/artifacts';

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('projectId') ?? '';
  return NextResponse.json({ artifacts: listArtifacts(projectId) });
}
```

- [ ] **Step 2: Get-one route** — `src/app/api/artifacts/[id]/route.ts`. Returns the HTML as **`text/plain`** so it can never execute same-origin if opened directly; the client puts it into a sandboxed `srcDoc`. Also returns version list via `?meta=1`.

```ts
import { NextRequest, NextResponse } from 'next/server';
import { getArtifact, getArtifactHtml, listVersions } from '@/lib/artifacts';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (req.nextUrl.searchParams.get('meta') === '1') {
    const meta = getArtifact(id);
    if (!meta) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ meta, versions: listVersions(id) });
  }
  const versionParam = req.nextUrl.searchParams.get('version');
  const version = versionParam ? parseInt(versionParam, 10) : undefined;
  const html = getArtifactHtml(id, version);
  if (html == null) return new NextResponse('not found', { status: 404 });
  return new NextResponse(html, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}
```

> Confirm the params signature against an existing dynamic route (`cat src/app/api/versions/*/route.ts` or another `[id]` route) — Next version determines whether `params` is a Promise.

- [ ] **Step 3: Verify** — `npx tsc --noEmit`. Manual smoke after Inc 1: publish via a chat `/artifact`, then `curl 'http://localhost:4000/api/artifacts?projectId=<dir>'`.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/artifacts
git commit -m "feat(artifacts): add list + get-html API routes"
```

## Task 7: Hardened ArtifactView renderer

**Files:**
- Create: `src/components/layout/ArtifactView.tsx`
- Test: `src/__tests__/unit/artifact-view.test.tsx`

- [ ] **Step 1: Write the failing component test** (asserts the security-critical attributes)

```tsx
// src/__tests__/unit/artifact-view.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { ArtifactView } from '../../components/layout/ArtifactView';

describe('ArtifactView security', () => {
  it('renders fetched html in a sandbox without allow-same-origin and injects a CSP', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, text: async () => '<h1>digest</h1>' })) as never);
    const { container } = render(<ArtifactView artifactId="run-digest" version={1} onUpdate={() => {}} />);
    const iframe = await waitFor(() => container.querySelector('iframe')!);
    const sandbox = iframe.getAttribute('sandbox') ?? '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-same-origin');
    expect(iframe.getAttribute('srcDoc') ?? iframe.getAttribute('srcdoc') ?? '').toContain('Content-Security-Policy');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/__tests__/unit/artifact-view.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/components/layout/ArtifactView.tsx`** (renderer pattern copied from `DocPreview.tsx:1222-1257`'s draw.io view; `PinchZoomContainer` reused as in `DocPreview.tsx:929`)

```tsx
"use client";

import { useEffect, useMemo, useState } from "react";
import { PinchZoomContainer } from "./DocPreview";

const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:";

/** Wrap raw artifact html with a CSP meta so the sandbox blocks all external network. */
function withCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`);
  return `<!DOCTYPE html><html><head>${meta}</head><body>${html}</body></html>`;
}

export interface ArtifactViewProps {
  artifactId: string;
  version: number;
  onUpdate: () => void;
}

export function ArtifactView({ artifactId, version, onUpdate }: ArtifactViewProps) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    fetch(`/api/artifacts/${artifactId}?version=${version}`)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("not found"))))
      .then((t) => { if (!cancelled) setHtml(t); })
      .catch(() => { if (!cancelled) setHtml("<p>Failed to load artifact.</p>"); });
    return () => { cancelled = true; };
  }, [artifactId, version]);

  const srcDoc = useMemo(() => (html == null ? null : withCsp(html)), [html]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end gap-2 border-b px-2 py-1">
        <button type="button" onClick={onUpdate} className="text-xs text-muted-foreground hover:text-foreground">
          更新此 Artifact
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {srcDoc == null ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <PinchZoomContainer iframeMode resetKey={`${artifactId}:${version}`}>
            <iframe
              srcDoc={srcDoc}
              sandbox="allow-scripts"
              className="h-full w-full border-0 bg-white"
              title="Artifact"
            />
          </PinchZoomContainer>
        )}
      </div>
    </div>
  );
}
```

> If `PinchZoomContainer` is not currently exported from `DocPreview.tsx`, add `export` to its declaration (single-word change) and commit it with this task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/__tests__/unit/artifact-view.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/ArtifactView.tsx src/__tests__/unit/artifact-view.test.tsx src/components/layout/DocPreview.tsx
git commit -m "feat(artifacts): hardened sandboxed ArtifactView renderer"
```

## Task 8: Panel state + open-on-publish wiring

**Files:**
- Modify: `src/hooks/usePanel.ts:22-49`
- Modify: `src/components/layout/AppShell.tsx:268-389,406-424`
- Modify: the `useSSEStream` consumer (ChatView) that builds the callbacks object

- [ ] **Step 1: Extend the panel context type** in `src/hooks/usePanel.ts` `PanelContextValue` (after `diffTarget`, ~line 44):

```ts
  artifactPreview: { id: string; version: number } | null;
  setArtifactPreview: (target: { id: string; version: number } | null) => void;
```

- [ ] **Step 2: Hold the state in AppShell** (`src/components/layout/AppShell.tsx`). Near the other preview state (~line 268):

```tsx
  const [artifactPreview, setArtifactPreview] = useState<{ id: string; version: number } | null>(null);
```

Add `artifactPreview` and `setArtifactPreview` to the `panelContextValue` object (~line 372) and to its `useMemo` dependency array (~line 385).

- [ ] **Step 3: Render the artifact panel** in AppShell where `previewFile` drives `DocPreview` (~lines 406-424). Add a branch (taking precedence over file preview when set):

```tsx
          {isChatDetailRoute && artifactPreview && (
            <ArtifactView
              artifactId={artifactPreview.id}
              version={artifactPreview.version}
              onUpdate={() => {
                // re-trigger: send /artifact-update intent for this artifact id (wired in Task 9)
                window.dispatchEvent(new CustomEvent('artifact:update', { detail: artifactPreview.id }));
              }}
            />
          )}
```

Import `ArtifactView` at the top. Confirm the surrounding conditionals so `artifactPreview` and `previewFile` don't render simultaneously (gate the existing `previewFile` block with `&& !artifactPreview`).

- [ ] **Step 4: Open the panel on publish.** In the component that constructs the `useSSEStream` callbacks (ChatView — `grep -rn "onToolResult:" src/components` to find it), add:

```ts
    onArtifactPublished: (data) => {
      setArtifactPreview({ id: data.artifactId, version: data.version });
      setPanelOpen(true);
    },
```

(Get `setArtifactPreview`/`setPanelOpen` from `usePanel()` in that component.)

- [ ] **Step 5: Verify** — `npx tsc --noEmit`. Manual: run `/artifact` in a chat → panel opens with the rendered page.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/usePanel.ts src/components/layout/AppShell.tsx src/components/chat/ChatView.tsx
git commit -m "feat(artifacts): open hardened artifact panel on publish"
```

## Task 9: `/artifact` command + update trigger

**Files:**
- Modify: `src/components/chat/MessageInput.tsx:133-156`
- Modify: ChatView (handle the `artifact:update` event → send an update prompt)

- [ ] **Step 1: Add the command + expansion prompt** in `src/components/chat/MessageInput.tsx`. In `COMMAND_PROMPTS` (~line 133) add:

```ts
  '/artifact': 'Create a self-contained, interactive single-file HTML page that is a mid-altitude run digest of the work in this conversation (progressive disclosure: throughline and key decisions expanded, details in collapsible sections). Inline all CSS/JS and embed all data — NO external network requests or CDN links. Write it to artifacts-summary/YYYY-MM-DD/artifact-digest.html in the working directory, then call the publish_artifact tool with its path, a short title, and a fitting emoji favicon.',
```

In `BUILT_IN_COMMANDS` (~line 155) add a **non-immediate** entry (so it expands via `COMMAND_PROMPTS` and is sent to the model — see the dispatch at `MessageInput.tsx:1017-1024`):

```ts
  { label: 'artifact', value: '/artifact', description: 'Turn this session into a shareable interactive page', builtIn: true, icon: Target02Icon },
```

`Target02Icon` is already imported (line 30).

- [ ] **Step 2: Wire the "update" trigger.** In ChatView, listen for the `artifact:update` event (dispatched by Task 8 Step 3) and send an update instruction:

```ts
  useEffect(() => {
    const handler = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      onSend(`Rebuild and republish artifact "${id}" with the latest state of the work. Write the updated self-contained HTML, then call publish_artifact with artifact_id="${id}".`);
    };
    window.addEventListener('artifact:update', handler);
    return () => window.removeEventListener('artifact:update', handler);
  }, [onSend]);
```

(Adapt `onSend` to ChatView's actual send function.)

- [ ] **Step 3: Verify** — `npm run dev`, open a chat, type `/artifact` → the model builds a page and the panel opens. Click "更新此 Artifact" → a v2 is published and shown.

- [ ] **Step 4: Commit**

```bash
git add src/components/chat/MessageInput.tsx src/components/chat/ChatView.tsx
git commit -m "feat(artifacts): add /artifact command and update trigger"
```

## Task 10: Regression guard — existing .html preview untouched

**Files:**
- Test: `src/__tests__/unit/docpreview-html-sandbox.test.tsx` (or extend an existing DocPreview test)

- [ ] **Step 1: Write a guard test** asserting the generic `.html` preview branch (`DocPreview.tsx:924-937`) still uses its `allow-same-origin` src-based iframe (i.e. we did NOT weaken or accidentally reroute trusted user-file preview through the artifact renderer). Render `DocPreview` with a `.html` `filePath` and assert the iframe has `src` starting `/api/preview` and `sandbox` containing `allow-same-origin`.

```tsx
// src/__tests__/unit/docpreview-html-sandbox.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { DocPreview } from '../../components/layout/DocPreview';

describe('generic html preview is unchanged', () => {
  it('keeps the src-based allow-same-origin iframe for user .html files', () => {
    const { container } = render(<DocPreview filePath="/proj/report.html" viewMode="rendered" />);
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('src')).toContain('/api/preview');
    expect(iframe.getAttribute('sandbox')).toContain('allow-same-origin');
  });
});
```

> Adjust `DocPreview`'s required props to its real signature (`grep -n "export function DocPreview\|export const DocPreview" src/components/layout/DocPreview.tsx`).

- [ ] **Step 2: Run** — `npx vitest run src/__tests__/unit/docpreview-html-sandbox.test.tsx` (Expected: PASS).

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/unit/docpreview-html-sandbox.test.tsx
git commit -m "test(artifacts): guard generic html preview path unchanged"
```

## Task 11: Manual end-to-end (mobile)

- [ ] **Step 1: Full suite + typecheck** — `npx vitest run && npx tsc --noEmit` (Expected: all pass).
- [ ] **Step 2: agent-browser E2E on a Pixel device** (per project testing rule — use `agent-browser`, not Playwright):
  - Open a chat at a real long working dir; run `/artifact`.
  - Verify the panel opens and the page renders, scripts run (e.g. a collapsible section toggles), and pinch-zoom works.
  - Click "更新此 Artifact"; verify a v2 publishes and renders.
  - Reload; verify the artifact is retrievable (`GET /api/artifacts?projectId=...`).
  - Verify CSP blocks external network: include an `<img src="https://example.com/x.png">` in a test artifact and confirm it does not load.
- [ ] **Step 3: Commit any fixes found.**

---

## Self-Review

**Spec coverage:**
- Native `/artifact` trigger → Task 9. ✅
- `publish_artifact` MCP (handoff) → Tasks 3-4 (in-process; deviation documented). ✅
- Versioned store (files + 2 DB tables) → Tasks 1-2. ✅
- `artifact_published` SSE → Task 5. ✅
- Hardened sandbox render (`srcDoc`+`allow-scripts`+CSP, no same-origin) → Task 7. ✅
- Version dropdown + "更新此 Artifact" → Tasks 7-9 (dropdown is the version state in ArtifactView; **gap:** a version *picker dropdown* UI is described in the spec but Task 7 only renders a given version + update button). **Added below.**
- Per-project artifact list → API in Task 6; **list UI gap** (see below).
- Primary type = run digest (progressive disclosure) → prompt fragment (Task 3) + `/artifact` template (Task 9). ✅
- Snapshot only, no live/public URL → respected (out of scope sections). ✅
- Regression guard → Task 10. ✅

**Identified gaps (carry into execution; small, additive):**
1. **Version picker dropdown** in `ArtifactView` header: add a `<select>` populated from `GET /api/artifacts/<id>?meta=1` that calls `setArtifactPreview({id, version})` on change. Fold into Task 7 (add a test asserting the select lists all versions).
2. **Artifact list UI**: a small list in the panel (reuse the `panelContent` tab system in `RightPanel.tsx` — add an `"artifacts"` tab) fetching `GET /api/artifacts?projectId=...` and setting `artifactPreview` on click. This is additive UI; spec marks the *cross-project gallery* as v2, so v1 only needs the current project's list. Add as **Task 12** if desired, or defer to a follow-up — it does not block the core flow (publish → auto-open → render → update).

**Placeholder scan:** No "TBD"/"handle errors"/"similar to Task N". A few steps say "confirm the exact signature against the real file" (params Promise shape, processor export name, DocPreview props, systemPrompt append site) — these are **verification instructions**, not missing code; the surrounding code is complete.

**Type consistency:** `publishArtifact`/`getArtifactHtml`/`listArtifacts`/`listVersions`/`getArtifact` names consistent across Tasks 2/3/6. Tool result keys `artifact_id`/`version`/`internal_url` consistent between Task 3 (producer) and Task 5 (consumer parse). SSE payload keys `artifactId`/`version`/`internalUrl` consistent between Task 5 (emit) and Tasks 7/8 (consume). ✅
