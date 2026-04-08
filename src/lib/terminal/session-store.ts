import { getDb } from '../db.js';
import { nanoid } from 'nanoid';

export interface TerminalSession {
  id: string;
  hostId: string;
  tmuxName: string;
  title: string;
  createdAt: number;
  lastSeen: number;
}

type Row = {
  id: string;
  host_id: string;
  tmux_name: string;
  title: string;
  created_at: number;
  last_seen: number;
};

function toSession(row: Row): TerminalSession {
  return {
    id: row.id,
    hostId: row.host_id,
    tmuxName: row.tmux_name,
    title: row.title,
    createdAt: row.created_at,
    lastSeen: row.last_seen,
  };
}

export function createSession(hostId: string, tmuxName: string, title: string): TerminalSession {
  const db = getDb();
  const id = nanoid(10);
  const now = Date.now();
  db.prepare(
    `INSERT INTO terminal_sessions (id, host_id, tmux_name, title, created_at, last_seen)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, hostId, tmuxName, title, now, now);
  return { id, hostId, tmuxName, title, createdAt: now, lastSeen: now };
}

export function getSession(id: string): TerminalSession | undefined {
  const row = getDb()
    .prepare('SELECT * FROM terminal_sessions WHERE id = ?')
    .get(id) as Row | undefined;
  return row ? toSession(row) : undefined;
}

export function listSessions(): TerminalSession[] {
  const rows = getDb()
    .prepare('SELECT * FROM terminal_sessions ORDER BY last_seen DESC')
    .all() as Row[];
  return rows.map(toSession);
}

export function touchSession(id: string): void {
  getDb()
    .prepare('UPDATE terminal_sessions SET last_seen = ? WHERE id = ?')
    .run(Date.now(), id);
}

export function deleteSession(id: string): void {
  getDb()
    .prepare('DELETE FROM terminal_sessions WHERE id = ?')
    .run(id);
}
