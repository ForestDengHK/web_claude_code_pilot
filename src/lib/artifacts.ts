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
