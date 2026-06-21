/**
 * Per-project "main dashboard" artifact — a single living page that accumulates
 * one structured entry per session (decisions, changes, status, links) instead
 * of spawning a throwaway digest each time.
 *
 * Each project maps to ONE deterministic dashboard artifact id, so every update
 * appends a new version of the same artifact. Entries are stored structurally
 * (entries.json) and re-rendered with a fixed template here, so the page stays
 * consistent across sessions and the token cost of an update does not grow with
 * the log. The rendered HTML goes through the same hardened sandbox as any other
 * artifact, so it must be fully self-contained (no external network).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { publishArtifact } from './artifacts';

export type DashboardStatus = 'done' | 'in-progress' | 'blocked';

export interface DashboardEntryInput {
  title: string;
  summary: string;
  status?: DashboardStatus;
  decisions?: string[];
  changes?: string[];
  links?: { label: string; url: string }[];
}

export interface DashboardEntry extends DashboardEntryInput {
  /** ISO timestamp, stamped server-side at append time. */
  ts: string;
}

const DASHBOARD_PREFIX = 'project-dashboard-';
const DASHBOARD_FAVICON = '📋';

/** True for ids produced by {@link dashboardArtifactId}. */
export function isDashboardId(id: string): boolean {
  return id.startsWith(DASHBOARD_PREFIX);
}

/** Deterministic dashboard artifact id for a project (CodePilot uses the cwd). */
export function dashboardArtifactId(projectId: string): string {
  const hash = crypto.createHash('sha1').update(projectId).digest('hex').slice(0, 12);
  return `${DASHBOARD_PREFIX}${hash}`;
}

function artifactsDir(): string {
  const dataDir = process.env.CLAUDE_GUI_DATA_DIR || path.join(os.homedir(), '.codepilot');
  return path.join(dataDir, 'artifacts');
}

function entriesPath(dashId: string): string {
  return path.join(artifactsDir(), dashId, 'entries.json');
}

function readEntries(dashId: string): DashboardEntry[] {
  try {
    const raw = fs.readFileSync(entriesPath(dashId), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DashboardEntry[]) : [];
  } catch {
    return [];
  }
}

function writeEntries(dashId: string, entries: DashboardEntry[]): void {
  const dir = path.join(artifactsDir(), dashId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(entriesPath(dashId), JSON.stringify(entries, null, 2), 'utf8');
}

function dashboardTitle(projectId: string): string {
  const base = path.basename(projectId.replace(/[/\\]+$/, '')) || 'Project';
  return `${base} · Dashboard`;
}

/**
 * Append one entry to a project's dashboard and publish it as a new version.
 * Creates the dashboard on first call.
 */
export function updateProjectDashboard(opts: {
  projectId: string;
  entry: DashboardEntryInput;
}): { artifactId: string; version: number; title: string; favicon: string } {
  const dashId = dashboardArtifactId(opts.projectId);
  const entries = readEntries(dashId);
  entries.push({ ...opts.entry, ts: new Date().toISOString() });

  const title = dashboardTitle(opts.projectId);
  const html = renderDashboardHtml(entries, title);
  const { version } = publishArtifact({
    html,
    title,
    favicon: DASHBOARD_FAVICON,
    projectId: opts.projectId,
    fixedId: dashId,
    label: opts.entry.title,
  });
  // publishArtifact created the version dir; persist the structured log there too.
  writeEntries(dashId, entries);
  return { artifactId: dashId, version, title, favicon: DASHBOARD_FAVICON };
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return esc(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderList(label: string, items?: string[]): string {
  if (!items || items.length === 0) return '';
  const lis = items.map((i) => `<li>${esc(i)}</li>`).join('');
  return `<div class="sec"><div class="sec-h">${esc(label)}</div><ul>${lis}</ul></div>`;
}

function renderLinks(links?: { label: string; url: string }[]): string {
  if (!links || links.length === 0) return '';
  const lis = links
    .map((l) => `<li><a href="${esc(l.url)}">${esc(l.label || l.url)}</a></li>`)
    .join('');
  return `<div class="sec"><div class="sec-h">Links</div><ul class="links">${lis}</ul></div>`;
}

function renderEntry(entry: DashboardEntry, open: boolean): string {
  const status = entry.status ?? '';
  const badge = status ? `<span class="badge ${esc(status)}">${esc(status)}</span>` : '';
  const body = [
    `<p class="summary">${esc(entry.summary)}</p>`,
    renderList('Decisions', entry.decisions),
    renderList('Changes', entry.changes),
    renderLinks(entry.links),
  ].join('');
  return `<details class="entry"${open ? ' open' : ''}>
  <summary>
    <span class="e-title">${esc(entry.title)}</span>
    ${badge}
    <span class="e-date">${fmtDate(entry.ts)}</span>
  </summary>
  <div class="e-body">${body}</div>
</details>`;
}

/** Render the full self-contained dashboard HTML (newest entry first). */
export function renderDashboardHtml(entries: DashboardEntry[], title: string): string {
  const ordered = [...entries].reverse();
  const cards = ordered.map((e, i) => renderEntry(e, i === 0)).join('\n');
  const last = entries.length ? fmtDate(entries[entries.length - 1].ts) : '—';
  const sub = `${entries.length} update${entries.length === 1 ? '' : 's'} · last ${esc(last)}`;
  const empty = ordered.length
    ? ''
    : '<p class="empty">No entries yet. Use /dashboard to add the first one.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root {
    --bg: #f7f7f8; --fg: #18181b; --muted: #71717a; --card: #ffffff;
    --border: #e4e4e7; --accent: #4f46e5;
    --done-bg: #dcfce7; --done-fg: #166534;
    --prog-bg: #fef3c7; --prog-fg: #92400e;
    --block-bg: #fee2e2; --block-fg: #991b1b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0c0c0e; --fg: #ededf0; --muted: #8b8b95; --card: #161618;
      --border: #2a2a30; --accent: #818cf8;
      --done-bg: #14331f; --done-fg: #6ee7a8;
      --prog-bg: #3a2c0a; --prog-fg: #fcd34d;
      --block-bg: #3a1414; --block-fg: #fca5a5;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 16px 64px; background: var(--bg); color: var(--fg);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }
  main, header { max-width: 820px; margin: 0 auto; }
  header { margin-bottom: 20px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: var(--muted); font-size: 13px; }
  .entry {
    background: var(--card); border: 1px solid var(--border); border-radius: 12px;
    margin-bottom: 12px; overflow: hidden;
  }
  .entry > summary {
    list-style: none; cursor: pointer; padding: 14px 16px;
    display: flex; align-items: center; gap: 10px;
  }
  .entry > summary::-webkit-details-marker { display: none; }
  .entry > summary::before {
    content: "▸"; color: var(--muted); font-size: 12px; transition: transform .15s;
  }
  .entry[open] > summary::before { transform: rotate(90deg); }
  .e-title { font-weight: 600; flex: 1; min-width: 0; }
  .e-date { color: var(--muted); font-size: 12px; white-space: nowrap; }
  .badge {
    font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px;
    text-transform: capitalize; white-space: nowrap;
  }
  .badge.done { background: var(--done-bg); color: var(--done-fg); }
  .badge.in-progress { background: var(--prog-bg); color: var(--prog-fg); }
  .badge.blocked { background: var(--block-bg); color: var(--block-fg); }
  .e-body { padding: 0 16px 16px 16px; border-top: 1px solid var(--border); }
  .summary { margin: 14px 0; }
  .sec { margin: 12px 0; }
  .sec-h {
    font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
    color: var(--muted); margin-bottom: 6px;
  }
  ul { margin: 0; padding-left: 20px; }
  li { margin: 3px 0; }
  a { color: var(--accent); }
  .links a { word-break: break-all; }
  .empty { color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>${esc(title)}</h1>
  <div class="sub">${sub}</div>
</header>
<main>
${cards}${empty}
</main>
</body>
</html>`;
}
