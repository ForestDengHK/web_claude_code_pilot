// Next-side canvas store: wraps the shared pure core (canvas-core.mjs) and adds
// DB version indexing. The file under the diagrams dir is the source of truth;
// the DB rows (diagrams + diagram_versions) are an index for listing / snapshot pins.
import path from 'path';
import os from 'os';
import fs from 'fs';
import { getDb } from './db';
import {
  createDiagram, writeScene, updateDiagram, readElements, readMeta, listDiagrams, safeId,
  type Engine, type CanvasElement, type CanvasOps, type DiagramMeta,
} from './canvas-core.mjs';

/** Central diagrams directory (file = source of truth). */
export function getDiagramsDir(): string {
  const dataDir = process.env.CLAUDE_GUI_DATA_DIR || path.join(os.homedir(), '.codepilot');
  const dir = path.join(dataDir, 'diagrams');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Upsert the diagrams row + a diagram_versions row from the on-disk meta. Idempotent. */
function indexFromMeta(meta: DiagramMeta, sessionId: string, messageId?: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO diagrams (id, session_id, title, engine, file_path, current_version, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET title=excluded.title, current_version=excluded.current_version, updated_at=datetime('now')`,
  ).run(meta.id, sessionId, meta.title, meta.engine, `${meta.id}.${meta.engine === 'mermaid' ? 'mmd' : meta.engine}`, meta.version);
  db.prepare(
    `INSERT OR IGNORE INTO diagram_versions (diagram_id, version, author, message_id, summary)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(meta.id, meta.version, meta.lastAuthor ?? 'unknown', messageId ?? null, '');
}

export function createCanvas(args: { sessionId?: string; id?: string; engine?: Engine; title?: string; scene?: unknown; author?: string }): { id: string; version: number } {
  const dir = getDiagramsDir();
  const res = createDiagram(dir, { id: args.id, engine: args.engine ?? 'excalidraw', title: args.title, scene: args.scene ?? { elements: [] }, author: args.author ?? 'user' });
  indexFromMeta(readMeta(dir, res.id), args.sessionId ?? '');
  return res;
}

/** User-draw save path: replace the full Excalidraw scene. */
export function saveScene(id: string, elements: CanvasElement[], author = 'user', messageId?: string): { id: string; version: number } {
  const dir = getDiagramsDir();
  const res = writeScene(dir, id, elements, author);
  indexFromMeta(readMeta(dir, id), getSessionId(id), messageId);
  return { id: res.id, version: res.version };
}

/** Claude incremental write path (also used by the watcher reconcile). */
export function applyCanvasOps(id: string, ops: CanvasOps, author = 'claude', messageId?: string) {
  const dir = getDiagramsDir();
  const res = updateDiagram(dir, id, ops, author);
  indexFromMeta(readMeta(dir, id), getSessionId(id), messageId);
  return res;
}

/** Reconcile DB from the current on-disk meta (called by the chokidar watcher). */
export function reconcileFromMeta(id: string): { id: string; version: number; engine: Engine } | null {
  const dir = getDiagramsDir();
  let meta: DiagramMeta;
  try { meta = readMeta(dir, safeId(id)); } catch { return null; }
  indexFromMeta(meta, getSessionId(id));
  return { id: meta.id, version: meta.version, engine: meta.engine };
}

/** Full scene for the editor (Excalidraw elements + meta). */
export function getScene(id: string): { id: string; engine: Engine; version: number; title: string; elements: CanvasElement[] } {
  const dir = getDiagramsDir();
  const meta = readMeta(dir, safeId(id));
  const elements = meta.engine === 'excalidraw' ? readElements(dir, meta.id, meta.engine) : [];
  return { id: meta.id, engine: meta.engine, version: meta.version, title: meta.title, elements };
}

export function listCanvases(sessionId?: string) {
  const all = listDiagrams(getDiagramsDir());
  if (!sessionId) return all;
  const db = getDb();
  const rows = db.prepare('SELECT id FROM diagrams WHERE session_id = ?').all(sessionId) as { id: string }[];
  const ids = new Set(rows.map((r) => r.id));
  return all.filter((d) => ids.has(d.id));
}

function getSessionId(id: string): string {
  try {
    const row = getDb().prepare('SELECT session_id FROM diagrams WHERE id = ?').get(id) as { session_id?: string } | undefined;
    return row?.session_id ?? '';
  } catch { return ''; }
}
