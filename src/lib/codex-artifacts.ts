import fs from 'fs';
import path from 'path';
import { publishArtifact } from '@/lib/artifacts';

export interface CodexArtifactRequest {
  filePath: string;
  title: string;
  favicon: string;
  label?: string;
  artifactId?: string;
}

export function formatArtifactDatePath(date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function defaultArtifactOutputPath(date = new Date()): string {
  return `artifacts-summary/${formatArtifactDatePath(date)}/artifact-digest.html`;
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
  const contextLine = userContext ? `User context: ${userContext}` : 'User context: summarize this conversation/work at medium granularity.';

  return [
    `${updateLine} Write a single self-contained interactive HTML file to ${filePath} in the working directory. Create the output directory first if needed.`,
    'Inline all CSS/JS/data. Do not use external scripts, CDNs, fonts, fetches, or network resources.',
    'Default content shape: mid-altitude run digest with the throughline and key decisions visible, details in collapsible sections.',
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
