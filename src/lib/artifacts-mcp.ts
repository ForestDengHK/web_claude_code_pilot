import fs from 'fs';
import path from 'path';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { publishArtifact } from './artifacts';
import { updateProjectDashboard } from './artifact-dashboard';

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

const DASHBOARD_TOOL_DESCRIPTION = [
  "Append one entry to this PROJECT'S living dashboard — a single persistent page that accumulates a structured log across sessions (decisions, changes, status, links).",
  '',
  'Use this (instead of publish_artifact) when the work is worth recording on the project board: it always targets the same per-project dashboard artifact and adds a new version, so the log builds up over time. You do not manage the id or the HTML — provide the structured entry and CodePilot renders and versions it.',
].join('\n');

export function createArtifactsMcp(config: ArtifactsMcpConfig): McpSdkServerConfigWithInstance {
  const dashboardTool = tool(
    'update_project_dashboard',
    DASHBOARD_TOOL_DESCRIPTION,
    {
      title: z.string().min(1).describe('Short title for this entry — what this session was about.'),
      summary: z.string().min(1).describe('1–3 sentence summary of the work, shown collapsed by default.'),
      status: z
        .enum(['done', 'in-progress', 'blocked'])
        .optional()
        .describe('Status badge for this entry.'),
      decisions: z.array(z.string()).optional().describe('Key decisions made this session.'),
      changes: z.array(z.string()).optional().describe('Notable changes/outputs this session.'),
      links: z
        .array(z.object({ label: z.string(), url: z.string() }))
        .optional()
        .describe('Relevant links (e.g. other artifacts, files, URLs).'),
    },
    async (args) => {
      const a = args as {
        title: string;
        summary: string;
        status?: 'done' | 'in-progress' | 'blocked';
        decisions?: string[];
        changes?: string[];
        links?: { label: string; url: string }[];
      };
      const out = updateProjectDashboard({ projectId: config.projectId, entry: a });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              artifact_id: out.artifactId,
              version: out.version,
              internal_url: `/api/artifacts/${out.artifactId}?version=${out.version}`,
              title: out.title,
              favicon: out.favicon,
            }),
          },
        ],
      };
    },
    { alwaysLoad: true },
  );
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
  return createSdkMcpServer({ name: 'codepilot-artifacts', version: '1.0.0', tools: [publishTool, dashboardTool] });
}

export const ARTIFACTS_PROMPT_FRAGMENT = `

# Publishing artifacts — \`mcp__codepilot-artifacts__publish_artifact\`

When the user runs \`/artifact\` (or asks you to "make an artifact / page / dashboard / digest"), build a **single self-contained interactive HTML file** and publish it with this tool.

## Content — favor interaction that text can't replicate
Pick the form by what the work actually produced. Reach for something a chat summary genuinely can't do:
- Structured / tabular results (file lists, test results, search hits, dependencies) → a **sortable / filterable table**.
- Relationships or architecture → a **zoomable graph / diagram**.
- Code changes → an **expandable diff**.
- A task list → a **stateful checklist**.
Only when the work produced nothing structured, fall back to a progressive-disclosure prose digest (throughline expanded, detail in collapsible sections).
If there is genuinely nothing worth an interactive page this time, do NOT force one — tell the user a plain chat summary is enough and skip publishing. A digest that just reformats what's already in the chat adds no value.

## Hard constraints (the sandbox enforces these)
- ONE self-contained .html: inline ALL CSS and JS, embed ALL data. NO external \`<script src>\`, CDN, fonts, or network calls — they are blocked by CSP and will silently fail.
- Interactivity via inline \`<script>\` is allowed (filter/sort/collapse).

## How to publish
1. Write the file into a dated summary directory in the working directory, with a timestamped filename to avoid overwrites, e.g. \`artifacts-summary/YYYY-MM-DD/artifact-digest-YYYY-MM-DD-HHMMSS.html\`. Create the directory first if needed.
2. Call \`publish_artifact({ file_path, title, favicon })\`.
3. To update an artifact later, call again with its \`artifact_id\` — that adds a new version at the same URL.

## Project dashboard — \`mcp__codepilot-artifacts__update_project_dashboard\`
This project has ONE living dashboard: a persistent page that accumulates a structured log across sessions. When the user runs \`/dashboard\` (or asks to record this session on the project board), call \`update_project_dashboard\` with a structured entry (\`title\`, \`summary\`, optional \`status\`/\`decisions\`/\`changes\`/\`links\`). It always targets the same per-project artifact and appends a new version — you do NOT write HTML or manage the id for this one. Use this for cumulative project history; use \`publish_artifact\` for one-off interactive pages.
`;
