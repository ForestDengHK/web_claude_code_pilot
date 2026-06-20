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
    return {
      text: `ERROR: cannot read file_path "${args.file_path}". Write the self-contained HTML file first, then call publish_artifact with its path.`,
      isError: true,
    };
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
      file_path: z
        .string()
        .min(1)
        .describe('Path to the self-contained .html file to publish (relative to cwd or absolute).'),
      title: z
        .string()
        .min(1)
        .describe('Short human-readable title; also the browser-tab title and the basis for the artifact id/slug.'),
      favicon: z.string().optional().describe('One or two emoji for the browser-tab icon, e.g. "📊". No markup.'),
      label: z
        .string()
        .optional()
        .describe('Short name for this version, shown in the version picker (e.g. "after-fix").'),
      artifact_id: z
        .string()
        .optional()
        .describe('Existing artifact id to publish a new version to. Omit for a new artifact.'),
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
1. Write the file into a dated summary directory in the working directory, e.g. \`artifacts-summary/YYYY-MM-DD/artifact-digest.html\`. Create the directory first if needed.
2. Call \`publish_artifact({ file_path, title, favicon })\`.
3. To update an artifact later, call again with its \`artifact_id\` — that adds a new version at the same URL.
`;
