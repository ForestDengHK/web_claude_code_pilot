import fs from 'fs';
import path from 'path';
import { publishArtifact } from '@/lib/artifacts';
import { updateProjectDashboard, type DashboardEntryInput } from '@/lib/artifact-dashboard';
import { defaultArtifactOutputPath, defaultDashboardEntryPath } from '@/lib/artifact-paths';
export {
  defaultArtifactOutputPath,
  defaultDashboardEntryPath,
  formatArtifactDatePath,
  formatArtifactTimestampForPath,
} from '@/lib/artifact-paths';

export interface CodexArtifactRequest {
  filePath: string;
  title: string;
  favicon: string;
  label?: string;
  artifactId?: string;
}

export function parseCodexArtifactCommand(content: string): { userContext: string; artifactId?: string } | null {
  const trimmed = content.trim();
  const slash = trimmed.match(/^\/artifact(?:\s+([\s\S]*))?$/);
  if (slash) {
    const rawArgs = slash[1]?.trim() ?? '';
    const update = rawArgs.match(/(?:^|\s)--update\s+([^\s]+)/);
    const artifactId = update?.[1];
    const userContext = rawArgs
      .replace(/(?:^|\s)--update\s+[^\s]+/, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return artifactId ? { userContext, artifactId } : { userContext };
  }

  const legacyUpdate = trimmed.match(/artifact_id=["']([^"']+)["']/);
  if (/publish_artifact/.test(trimmed) && legacyUpdate?.[1]) {
    return { userContext: trimmed, artifactId: legacyUpdate[1] };
  }

  if (/publish_artifact/.test(trimmed) && /artifact-digest\.html/.test(trimmed)) {
    return { userContext: trimmed };
  }

  return null;
}

export function buildCodexArtifactPrompt(userContext: string, artifactId?: string, filePath = defaultArtifactOutputPath()): string {
  const updateLine = artifactId
    ? `Update existing artifact id "${artifactId}" by writing a new version.`
    : 'Create a new artifact.';
  const contextLine = userContext ? `User context: ${userContext}` : 'User context: turn this conversation/work into the page.';

  return [
    `${updateLine} Write a single self-contained interactive HTML file to ${filePath} in the working directory. Create the output directory first if needed.`,
    'Inline all CSS/JS/data. Do not use external scripts, CDNs, fonts, fetches, or network resources.',
    "Choose the form by what the work produced, favoring interaction plain text can't replicate: structured/tabular results → a sortable/filterable table; relationships or architecture → a zoomable graph/diagram; code changes → an expandable diff; a task list → a stateful checklist. Only if nothing is structured, fall back to a progressive-disclosure prose digest.",
    `Include a useful <title>. When the file is written, finish normally; CodePilot will publish ${filePath} automatically.`,
    contextLine,
  ].join('\n');
}

export function resolveArtifactPath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
}

export function readArtifactMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function extractHtmlTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = match?.[1]
    ?.replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return title || null;
}

export function publishCodexArtifactFromFile(params: {
  request: CodexArtifactRequest;
  workingDirectory: string;
  projectId: string;
  beforeMtimeMs: number | null;
}): { payload?: { artifact_id: string; version: number; internal_url: string; title: string; favicon: string }; error?: string } {
  const abs = resolveArtifactPath(params.workingDirectory, params.request.filePath);
  const afterMtimeMs = readArtifactMtimeMs(abs);

  if (afterMtimeMs === null) {
    return { error: `Codex artifact publish failed: ${params.request.filePath} was not written.` };
  }

  if (params.beforeMtimeMs !== null && afterMtimeMs <= params.beforeMtimeMs) {
    return { error: `Codex artifact publish failed: ${params.request.filePath} was not updated during this turn.` };
  }

  let html: string;
  try {
    html = fs.readFileSync(abs, 'utf8');
  } catch {
    return { error: `Codex artifact publish failed: cannot read ${params.request.filePath}.` };
  }

  const title = extractHtmlTitle(html) ?? params.request.title;
  const favicon = params.request.favicon.trim() || '📄';
  const { artifactId, version } = publishArtifact({
    html,
    title,
    favicon,
    label: params.request.label,
    projectId: params.projectId,
    artifactId: params.request.artifactId,
  });

  return {
    payload: {
      artifact_id: artifactId,
      version,
      internal_url: `/api/artifacts/${artifactId}?version=${version}`,
      title,
      favicon,
    },
  };
}

// --- Project dashboard (Codex parallel of the SDK update_project_dashboard tool) ---
//
// Codex can't call the in-process SDK MCP tool, so it follows the same
// write-a-file-then-publish pattern as artifacts: the model writes ONE JSON
// entry to a file, and after the turn the server reads it and appends it to the
// project dashboard.

export interface CodexDashboardRequest {
  filePath: string;
}

export function parseCodexDashboardCommand(content: string): { userContext: string } | null {
  const slash = content.trim().match(/^\/dashboard(?:\s+([\s\S]*))?$/);
  if (!slash) return null;
  return { userContext: (slash[1] ?? '').replace(/\s+/g, ' ').trim() };
}

export function buildCodexDashboardPrompt(userContext: string, filePath = defaultDashboardEntryPath()): string {
  const contextLine = userContext
    ? `User context: ${userContext}`
    : 'User context: record what we did in this session.';
  return [
    "Record this session as ONE entry on the project's living dashboard. Do NOT write any HTML.",
    `Write a single JSON file to ${filePath} in the working directory (create the directory first if needed) with exactly this shape:`,
    '{"title": string, "summary": string, "status"?: "done" | "in-progress" | "blocked", "decisions"?: string[], "changes"?: string[], "links"?: {"label": string, "url": string}[]}',
    'title = what this session was about; summary = 1–3 sentences. Write only the raw JSON object — no markdown, no code fences.',
    `When the file is written, finish normally; CodePilot will append it to the dashboard automatically.`,
    contextLine,
  ].join('\n');
}

function stripCodeFences(raw: string): string {
  const m = raw.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : raw;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((x): x is string => typeof x === 'string');
  return out.length ? out : undefined;
}

function sanitizeDashboardEntry(parsed: Record<string, unknown>): DashboardEntryInput | null {
  if (typeof parsed.title !== 'string' || typeof parsed.summary !== 'string') return null;
  const status =
    parsed.status === 'done' || parsed.status === 'in-progress' || parsed.status === 'blocked'
      ? parsed.status
      : undefined;
  const links = Array.isArray(parsed.links)
    ? parsed.links
        .filter(
          (l): l is { label: string; url: string } =>
            !!l && typeof (l as Record<string, unknown>).label === 'string' && typeof (l as Record<string, unknown>).url === 'string',
        )
        .map((l) => ({ label: l.label, url: l.url }))
    : undefined;
  const decisions = asStringArray(parsed.decisions);
  const changes = asStringArray(parsed.changes);
  return {
    title: parsed.title,
    summary: parsed.summary,
    ...(status ? { status } : {}),
    ...(decisions ? { decisions } : {}),
    ...(changes ? { changes } : {}),
    ...(links && links.length ? { links } : {}),
  };
}

export function publishCodexDashboardFromFile(params: {
  request: CodexDashboardRequest;
  workingDirectory: string;
  projectId: string;
  beforeMtimeMs: number | null;
}): { payload?: { artifact_id: string; version: number; internal_url: string; title: string; favicon: string }; error?: string } {
  const abs = resolveArtifactPath(params.workingDirectory, params.request.filePath);
  const afterMtimeMs = readArtifactMtimeMs(abs);

  if (afterMtimeMs === null) {
    return { error: `Codex dashboard update failed: ${params.request.filePath} was not written.` };
  }
  if (params.beforeMtimeMs !== null && afterMtimeMs <= params.beforeMtimeMs) {
    return { error: `Codex dashboard update failed: ${params.request.filePath} was not updated during this turn.` };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    return { error: `Codex dashboard update failed: cannot read ${params.request.filePath}.` };
  }

  let entry: DashboardEntryInput | null;
  try {
    const parsed = JSON.parse(stripCodeFences(raw)) as Record<string, unknown>;
    entry = sanitizeDashboardEntry(parsed);
  } catch {
    return { error: `Codex dashboard update failed: ${params.request.filePath} is not valid JSON.` };
  }
  if (!entry) {
    return { error: 'Codex dashboard update failed: JSON must include string "title" and "summary".' };
  }

  const out = updateProjectDashboard({ projectId: params.projectId, entry });
  return {
    payload: {
      artifact_id: out.artifactId,
      version: out.version,
      internal_url: `/api/artifacts/${out.artifactId}?version=${out.version}`,
      title: out.title,
      favicon: out.favicon,
    },
  };
}
