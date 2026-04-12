import Database from 'better-sqlite3';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import type { ChatSession, Message, SettingsMap, TaskItem, TaskStatus, ApiProvider, CreateProviderRequest, UpdateProviderRequest } from '@/types';

/**
 * Extract searchable plain text from a message content string.
 * Handles both plain text and JSON-encoded MessageContentBlock arrays.
 */
function extractTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      const parts: string[] = [];
      for (const block of parsed) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text);
        } else if (block.type === 'tool_use' && block.input) {
          if (block.name) parts.push(block.name);
          const input = block.input as Record<string, unknown>;
          if (typeof input.command === 'string') parts.push(input.command);
          if (typeof input.description === 'string') parts.push(input.description);
        } else if (block.type === 'tool_result' && block.content) {
          parts.push(block.content);
        }
      }
      return parts.join('\n');
    }
  } catch {
    // Not JSON — plain text message
  }
  return content;
}

let db: Database.Database | null = null;

/** Compute DB path at call-time so tests can override CLAUDE_GUI_DATA_DIR before first open. */
function getDbPath(): string {
  const dataDir = process.env.CLAUDE_GUI_DATA_DIR || path.join(os.homedir(), '.codepilot');
  return path.join(dataDir, 'codepilot.db');
}

export function getDb(): Database.Database {
  if (!db) {
    const DB_PATH = getDbPath();
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Migrate from old locations if the new DB doesn't exist yet
    if (!fs.existsSync(DB_PATH)) {
      const home = os.homedir();
      const oldPaths = [
        // Old app userData paths
        path.join(home, 'Library', 'Application Support', 'CodePilot', 'codepilot.db'),
        path.join(home, 'Library', 'Application Support', 'codepilot', 'codepilot.db'),
        path.join(home, 'Library', 'Application Support', 'Claude GUI', 'codepilot.db'),
        // Old dev-mode fallback
        path.join(process.cwd(), 'data', 'codepilot.db'),
        // Legacy name
        path.join(home, 'Library', 'Application Support', 'CodePilot', 'claude-gui.db'),
        path.join(home, 'Library', 'Application Support', 'codepilot', 'claude-gui.db'),
      ];
      for (const oldPath of oldPaths) {
        if (fs.existsSync(oldPath)) {
          try {
            fs.copyFileSync(oldPath, DB_PATH);
            // Also copy WAL/SHM if they exist
            if (fs.existsSync(oldPath + '-wal')) fs.copyFileSync(oldPath + '-wal', DB_PATH + '-wal');
            if (fs.existsSync(oldPath + '-shm')) fs.copyFileSync(oldPath + '-shm', DB_PATH + '-shm');
            console.log(`[db] Migrated database from ${oldPath}`);
            break;
          } catch (err) {
            console.warn(`[db] Failed to migrate from ${oldPath}:`, err);
          }
        }
      }
    }

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initDb(db);
  }
  return db;
}

function initDb(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      model TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      working_directory TEXT NOT NULL DEFAULT '',
      sdk_session_id TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      token_usage TEXT,
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS api_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'anthropic',
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      extra_env TEXT NOT NULL DEFAULT '{}',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS terminal_sessions (
      id          TEXT PRIMARY KEY,
      host_id     TEXT NOT NULL DEFAULT 'local',
      tmux_name   TEXT NOT NULL,
      title       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON chat_sessions(updated_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
  `);

  // FTS5 full-text search index for messages (standalone storage)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED,
      text_content
    );
  `);

  // Run migrations for existing databases
  migrateDb(db);
}

function migrateDb(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(chat_sessions)").all() as { name: string }[];
  const colNames = columns.map(c => c.name);

  if (!colNames.includes('model')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN model TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('system_prompt')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN system_prompt TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('sdk_session_id')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN sdk_session_id TEXT NOT NULL DEFAULT ''");
  }
  if (!colNames.includes('project_name')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN project_name TEXT NOT NULL DEFAULT ''");
    // Backfill project_name from working_directory for existing rows
    db.exec(`
      UPDATE chat_sessions
      SET project_name = CASE
        WHEN working_directory != '' THEN REPLACE(REPLACE(working_directory, RTRIM(working_directory, REPLACE(working_directory, '/', '')), ''), '/', '')
        ELSE ''
      END
      WHERE project_name = ''
    `);
  }
  if (!colNames.includes('status')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }
  if (!colNames.includes('mode')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN mode TEXT NOT NULL DEFAULT 'code'");
  }
  if (!colNames.includes('skip_permissions')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN skip_permissions INTEGER NOT NULL DEFAULT 0");
  }
  if (!colNames.includes('backend')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN backend TEXT NOT NULL DEFAULT 'claude'");
  }
  if (!colNames.includes('codex_thread_id')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN codex_thread_id TEXT");
  }

  // Context bridge: track which backend's context window ends where
  if (!colNames.includes('last_claude_bridged_msg_id')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN last_claude_bridged_msg_id TEXT");
  }
  if (!colNames.includes('last_codex_bridged_msg_id')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN last_codex_bridged_msg_id TEXT");
  }
  if (!colNames.includes('advisor_model')) {
    db.exec("ALTER TABLE chat_sessions ADD COLUMN advisor_model TEXT");
  }

  const msgColumns = db.prepare("PRAGMA table_info(messages)").all() as { name: string }[];
  const msgColNames = msgColumns.map(c => c.name);

  if (!msgColNames.includes('token_usage')) {
    db.exec("ALTER TABLE messages ADD COLUMN token_usage TEXT");
  }
  if (!msgColNames.includes('backend')) {
    db.exec("ALTER TABLE messages ADD COLUMN backend TEXT");
  }
  if (!msgColNames.includes('status')) {
    db.exec("ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'");
  }
  if (!msgColNames.includes('bookmarked')) {
    db.exec("ALTER TABLE messages ADD COLUMN bookmarked INTEGER DEFAULT 0");
  }

  // Ensure tasks table exists for databases created before this migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'failed')),
      description TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
  `);

  // Ensure api_providers table exists for databases created before this migration
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      provider_type TEXT NOT NULL DEFAULT 'anthropic',
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      is_active INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      extra_env TEXT NOT NULL DEFAULT '{}',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate existing settings to a default provider if api_providers is empty
  const providerCount = db.prepare('SELECT COUNT(*) as count FROM api_providers').get() as { count: number };
  if (providerCount.count === 0) {
    const tokenRow = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_auth_token'").get() as { value: string } | undefined;
    const baseUrlRow = db.prepare("SELECT value FROM settings WHERE key = 'anthropic_base_url'").get() as { value: string } | undefined;
    if (tokenRow || baseUrlRow) {
      const id = crypto.randomBytes(16).toString('hex');
      const now = new Date().toISOString().replace('T', ' ').split('.')[0];
      db.prepare(
        'INSERT INTO api_providers (id, name, provider_type, base_url, api_key, is_active, sort_order, extra_env, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(id, 'Default', 'anthropic', baseUrlRow?.value || '', tokenRow?.value || '', 1, 0, '{}', 'Migrated from settings', now, now);
    }
  }

  // Migrate FTS table: if old schema (external content mode) exists, recreate it
  try {
    db.prepare("SELECT message_id FROM messages_fts LIMIT 0").run();
  } catch {
    // Old FTS table doesn't have message_id column — drop and recreate
    console.log('[db] Recreating FTS table with new schema...');
    db.exec('DROP TABLE IF EXISTS messages_fts');
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        message_id UNINDEXED,
        text_content
      );
    `);
  }

  // Backfill FTS index if empty but messages exist
  const ftsCount = db.prepare('SELECT COUNT(*) as count FROM messages_fts').get() as { count: number };
  const msgCount = db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number };
  if (ftsCount.count === 0 && msgCount.count > 0) {
    console.log(`[db] Backfilling FTS index for ${msgCount.count} messages...`);
    const allMsgs = db.prepare('SELECT id, content FROM messages').all() as { id: string; content: string }[];
    const insertFts = db.prepare('INSERT INTO messages_fts(message_id, text_content) VALUES (?, ?)');
    const backfill = db.transaction(() => {
      for (const msg of allMsgs) {
        insertFts.run(msg.id, extractTextContent(msg.content));
      }
    });
    backfill();
    console.log(`[db] FTS index backfill complete`);
  }

  // Push subscriptions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      keys_p256dh TEXT NOT NULL,
      keys_auth TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      user_agent TEXT
    )
  `);

  // Add terminal_sessions table for databases created before this feature
  db.exec(`
    CREATE TABLE IF NOT EXISTS terminal_sessions (
      id          TEXT PRIMARY KEY,
      host_id     TEXT NOT NULL DEFAULT 'local',
      tmux_name   TEXT NOT NULL,
      title       TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      last_seen   INTEGER NOT NULL
    )
  `);
}

// ==========================================
// Session Operations
// ==========================================

export function getAllSessions(): ChatSession[] {
  const db = getDb();
  return db.prepare('SELECT * FROM chat_sessions ORDER BY updated_at DESC').all() as ChatSession[];
}

export function getRecentWorkingDirectory(): string | undefined {
  const db = getDb();
  const row = db.prepare(
    "SELECT working_directory FROM chat_sessions WHERE working_directory != '' ORDER BY updated_at DESC LIMIT 1"
  ).get() as { working_directory: string } | undefined;
  return row?.working_directory || undefined;
}

export function getAllWorkingDirectories(): string[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT DISTINCT working_directory FROM chat_sessions WHERE working_directory != '' ORDER BY updated_at DESC"
  ).all() as { working_directory: string }[];
  return rows.map(r => r.working_directory);
}

export function getSession(id: string): ChatSession | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as ChatSession | undefined;
}

export function createSession(
  title?: string,
  model?: string,
  systemPrompt?: string,
  workingDirectory?: string,
  mode?: string,
  backend?: 'claude' | 'codex',
): ChatSession {
  if (!workingDirectory?.trim()) {
    throw new Error('Cannot create session without a working directory');
  }
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const wd = workingDirectory;
  const projectName = path.basename(wd);

  db.prepare(
    'INSERT INTO chat_sessions (id, title, created_at, updated_at, model, system_prompt, working_directory, sdk_session_id, project_name, status, mode, backend) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(id, title || 'New Chat', now, now, model || '', systemPrompt || '', wd, '', projectName, 'active', mode || 'code', backend || 'claude');

  return getSession(id)!;
}

export function deleteSession(id: string): boolean {
  const db = getDb();
  // Delete FTS entries for this session's messages before cascade
  const msgIds = db.prepare('SELECT id FROM messages WHERE session_id = ?').all(id) as { id: string }[];
  const deleteFts = db.prepare('DELETE FROM messages_fts WHERE message_id = ?');
  for (const msg of msgIds) {
    deleteFts.run(msg.id);
  }
  const result = db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
  return result.changes > 0;
}

export function updateSessionTimestamp(id: string): void {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, id);
}

export function updateSessionTitle(id: string, title: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(title, id);
}

export function updateSdkSessionId(id: string, sdkSessionId: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET sdk_session_id = ? WHERE id = ?').run(sdkSessionId, id);
}

export function updateCodexThreadId(id: string, codexThreadId: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET codex_thread_id = ? WHERE id = ?').run(codexThreadId, id);
}

export function updateSessionBackend(id: string, backend: 'claude' | 'codex'): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET backend = ? WHERE id = ?').run(backend, id);
}

export function updateSessionWorkingDirectory(id: string, workingDirectory: string): void {
  const db = getDb();
  const projectName = path.basename(workingDirectory);
  db.prepare('UPDATE chat_sessions SET working_directory = ?, project_name = ? WHERE id = ?').run(workingDirectory, projectName, id);
}

export function updateSessionModel(id: string, model: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET model = ? WHERE id = ?').run(model, id);
}

export function updateSessionMode(id: string, mode: string): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET mode = ? WHERE id = ?').run(mode, id);
}

export function updateSessionSkipPermissions(id: string, skip: boolean): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET skip_permissions = ? WHERE id = ?').run(skip ? 1 : 0, id);
}

export function updateSessionAdvisorModel(id: string, advisorModel: string | null): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET advisor_model = ? WHERE id = ?').run(advisorModel, id);
}

// ==========================================
// Message Operations
// ==========================================

export function getMessages(
  sessionId: string,
  options?: { limit?: number; beforeRowId?: number },
): { messages: Message[]; hasMore: boolean } {
  const db = getDb();
  const limit = options?.limit ?? 100;
  const beforeRowId = options?.beforeRowId;

  let rows: Message[];
  if (beforeRowId) {
    // Fetch `limit + 1` rows before the cursor to detect if there are more
    rows = db.prepare(
      'SELECT *, rowid as _rowid FROM messages WHERE session_id = ? AND rowid < ? ORDER BY rowid DESC LIMIT ?'
    ).all(sessionId, beforeRowId, limit + 1) as Message[];
  } else {
    // Fetch the most recent `limit + 1` messages
    rows = db.prepare(
      'SELECT *, rowid as _rowid FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT ?'
    ).all(sessionId, limit + 1) as Message[];
  }

  const hasMore = rows.length > limit;
  if (hasMore) {
    rows = rows.slice(0, limit);
  }

  // Reverse to chronological order (ASC)
  rows.reverse();
  return { messages: rows, hasMore };
}

export function addMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  tokenUsage?: string | null,
  backend?: 'claude' | 'codex' | null,
): Message {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  db.prepare(
    'INSERT INTO messages (id, session_id, role, content, created_at, token_usage, backend) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, sessionId, role, content, now, tokenUsage || null, backend || null);

  // Sync FTS index
  db.prepare('INSERT INTO messages_fts(message_id, text_content) VALUES (?, ?)').run(
    id,
    extractTextContent(content)
  );

  updateSessionTimestamp(sessionId);

  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message;
}

/**
 * Insert a draft assistant message with status='streaming'.
 * Called once when the first content event arrives during streaming.
 */
export function addDraftMessage(
  sessionId: string,
  content: string,
  backend?: 'claude' | 'codex' | null,
): Message {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, created_at, status, backend) VALUES (?, ?, 'assistant', ?, ?, 'streaming', ?)"
  ).run(id, sessionId, content, now, backend || null);

  // FTS index — even draft content should be searchable
  db.prepare('INSERT INTO messages_fts(message_id, text_content) VALUES (?, ?)').run(
    id,
    extractTextContent(content)
  );

  updateSessionTimestamp(sessionId);
  return db.prepare('SELECT *, rowid as _rowid FROM messages WHERE id = ?').get(id) as Message;
}

/**
 * Update a draft message's content (periodic checkpoint during streaming).
 */
export function updateDraftMessage(messageId: string, content: string): void {
  const db = getDb();
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, messageId);

  // Update FTS index
  db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(messageId);
  db.prepare('INSERT INTO messages_fts(message_id, text_content) VALUES (?, ?)').run(
    messageId,
    extractTextContent(content)
  );
}

/**
 * Finalize a draft message: set status='complete', update content, add token usage.
 * Called when streaming ends normally.
 */
export function finalizeDraftMessage(
  messageId: string,
  content: string,
  tokenUsage?: string | null,
): void {
  const db = getDb();
  db.prepare(
    "UPDATE messages SET content = ?, token_usage = ?, status = 'complete' WHERE id = ?"
  ).run(content, tokenUsage || null, messageId);

  // Update FTS index with final content
  db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(messageId);
  db.prepare('INSERT INTO messages_fts(message_id, text_content) VALUES (?, ?)').run(
    messageId,
    extractTextContent(content)
  );
}

export function getLastMessageInfo(sessionId: string): { role: string; created_at: string } | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT role, created_at FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 1'
  ).get(sessionId) as { role: string; created_at: string } | undefined;
  return row ?? null;
}

export function getAllMessages(sessionId: string): Message[] {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC'
  ).all(sessionId) as Message[];
}

/**
 * Get messages added after the given message ID (by rowid order).
 * Used by the incremental context bridge to find the "gap" messages
 * that a backend hasn't seen yet.
 */
export function getMessagesSince(sessionId: string, afterMsgId: string | null): Message[] {
  const db = getDb();
  if (!afterMsgId) {
    // No previous bridge — return all messages
    return db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC'
    ).all(sessionId) as Message[];
  }

  // Get the rowid of the marker message
  const marker = db.prepare('SELECT rowid FROM messages WHERE id = ?').get(afterMsgId) as { rowid: number } | undefined;
  if (!marker) {
    // Marker message was deleted — return all messages
    return db.prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY rowid ASC'
    ).all(sessionId) as Message[];
  }

  return db.prepare(
    'SELECT * FROM messages WHERE session_id = ? AND rowid > ? ORDER BY rowid ASC'
  ).all(sessionId, marker.rowid) as Message[];
}

/**
 * Update the "last bridged message ID" marker for a backend.
 * This tracks up to which message a backend has received context.
 */
export function updateLastBridgedMsgId(sessionId: string, backend: 'claude' | 'codex', msgId: string): void {
  const db = getDb();
  const col = backend === 'claude' ? 'last_claude_bridged_msg_id' : 'last_codex_bridged_msg_id';
  db.prepare(`UPDATE chat_sessions SET ${col} = ? WHERE id = ?`).run(msgId, sessionId);
}

/**
 * Get the backend that handled the last assistant message in a session.
 * Returns null if there are no assistant messages or no backend is recorded.
 */
export function getLastAssistantBackend(sessionId: string): 'claude' | 'codex' | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT backend FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY rowid DESC LIMIT 1"
  ).get(sessionId) as { backend: string | null } | undefined;
  if (!row?.backend) return null;
  return row.backend as 'claude' | 'codex';
}

export function clearSessionMessages(sessionId: string): void {
  const db = getDb();
  // Delete FTS entries for this session's messages
  const msgIds = db.prepare('SELECT id FROM messages WHERE session_id = ?').all(sessionId) as { id: string }[];
  const deleteFts = db.prepare('DELETE FROM messages_fts WHERE message_id = ?');
  for (const { id } of msgIds) {
    deleteFts.run(id);
  }
  db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
  // Reset SDK session ID so next message starts fresh
  db.prepare('UPDATE chat_sessions SET sdk_session_id = ? WHERE id = ?').run('', sessionId);
}

export function searchMessages(query: string, limit = 50): { results: Array<{
  message_id: string;
  session_id: string;
  session_title: string;
  project_name: string;
  working_directory: string;
  role: string;
  snippet: string;
  created_at: string;
}>; total: number } {
  const db = getDb();

  const safeTerm = query.replace(/['"]/g, '').trim();
  if (!safeTerm) return { results: [], total: 0 };

  // Use prefix matching for better UX
  const ftsQuery = safeTerm.split(/\s+/).map(t => `"${t}"*`).join(' ');

  try {
    const rows = db.prepare(`
      SELECT f.message_id, m.session_id, m.role, m.created_at,
             s.title as session_title, s.project_name, s.working_directory,
             snippet(messages_fts, 1, '<mark>', '</mark>', '...', 40) as snippet
      FROM messages_fts f
      JOIN messages m ON f.message_id = m.id
      JOIN chat_sessions s ON m.session_id = s.id
      WHERE messages_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, limit) as Array<{
      message_id: string;
      session_id: string;
      session_title: string;
      project_name: string;
      working_directory: string;
      role: string;
      snippet: string;
      created_at: string;
    }>;

    const countRow = db.prepare(`
      SELECT COUNT(*) as total
      FROM messages_fts f
      JOIN messages m ON f.message_id = m.id
      WHERE messages_fts MATCH ?
    `).get(ftsQuery) as { total: number };

    return { results: rows, total: countRow.total };
  } catch {
    return { results: [], total: 0 };
  }
}

// ==========================================
// Settings Operations
// ==========================================

export function getSetting(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function getAllSettings(): SettingsMap {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: SettingsMap = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

// ==========================================
// Session Status Operations
// ==========================================

export function updateSessionStatus(id: string, status: 'active' | 'archived'): void {
  const db = getDb();
  db.prepare('UPDATE chat_sessions SET status = ? WHERE id = ?').run(status, id);
}

// ==========================================
// Task Operations
// ==========================================

export function getTasksBySession(sessionId: string): TaskItem[] {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as TaskItem[];
}

export function getTask(id: string): TaskItem | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskItem | undefined;
}

export function createTask(sessionId: string, title: string, description?: string): TaskItem {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  db.prepare(
    'INSERT INTO tasks (id, session_id, title, status, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, sessionId, title, 'pending', description || null, now, now);

  return getTask(id)!;
}

export function updateTask(id: string, updates: { title?: string; status?: TaskStatus; description?: string }): TaskItem | undefined {
  const db = getDb();
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const existing = getTask(id);
  if (!existing) return undefined;

  const title = updates.title ?? existing.title;
  const status = updates.status ?? existing.status;
  const description = updates.description !== undefined ? updates.description : existing.description;

  db.prepare(
    'UPDATE tasks SET title = ?, status = ?, description = ?, updated_at = ? WHERE id = ?'
  ).run(title, status, description, now, id);

  return getTask(id);
}

export function deleteTask(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return result.changes > 0;
}

// ==========================================
// API Provider Operations
// ==========================================

export function getAllProviders(): ApiProvider[] {
  const db = getDb();
  return db.prepare('SELECT * FROM api_providers ORDER BY sort_order ASC, created_at ASC').all() as ApiProvider[];
}

export function getProvider(id: string): ApiProvider | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM api_providers WHERE id = ?').get(id) as ApiProvider | undefined;
}

export function getActiveProvider(): ApiProvider | undefined {
  const db = getDb();
  return db.prepare('SELECT * FROM api_providers WHERE is_active = 1 LIMIT 1').get() as ApiProvider | undefined;
}

export function createProvider(data: CreateProviderRequest): ApiProvider {
  const db = getDb();
  const id = crypto.randomBytes(16).toString('hex');
  const now = new Date().toISOString().replace('T', ' ').split('.')[0];

  // Get max sort_order to append at end
  const maxRow = db.prepare('SELECT MAX(sort_order) as max_order FROM api_providers').get() as { max_order: number | null };
  const sortOrder = (maxRow.max_order ?? -1) + 1;

  db.prepare(
    'INSERT INTO api_providers (id, name, provider_type, base_url, api_key, is_active, sort_order, extra_env, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    id,
    data.name,
    data.provider_type || 'anthropic',
    data.base_url || '',
    data.api_key || '',
    0,
    sortOrder,
    data.extra_env || '{}',
    data.notes || '',
    now,
    now,
  );

  return getProvider(id)!;
}

export function updateProvider(id: string, data: UpdateProviderRequest): ApiProvider | undefined {
  const db = getDb();
  const existing = getProvider(id);
  if (!existing) return undefined;

  const now = new Date().toISOString().replace('T', ' ').split('.')[0];
  const name = data.name ?? existing.name;
  const providerType = data.provider_type ?? existing.provider_type;
  const baseUrl = data.base_url ?? existing.base_url;
  const apiKey = data.api_key ?? existing.api_key;
  const extraEnv = data.extra_env ?? existing.extra_env;
  const notes = data.notes ?? existing.notes;
  const sortOrder = data.sort_order ?? existing.sort_order;

  db.prepare(
    'UPDATE api_providers SET name = ?, provider_type = ?, base_url = ?, api_key = ?, extra_env = ?, notes = ?, sort_order = ?, updated_at = ? WHERE id = ?'
  ).run(name, providerType, baseUrl, apiKey, extraEnv, notes, sortOrder, now, id);

  return getProvider(id);
}

export function deleteProvider(id: string): boolean {
  const db = getDb();
  const result = db.prepare('DELETE FROM api_providers WHERE id = ?').run(id);
  return result.changes > 0;
}

export function activateProvider(id: string): boolean {
  const db = getDb();
  const existing = getProvider(id);
  if (!existing) return false;

  const transaction = db.transaction(() => {
    db.prepare('UPDATE api_providers SET is_active = 0').run();
    db.prepare('UPDATE api_providers SET is_active = 1 WHERE id = ?').run(id);
  });
  transaction();
  return true;
}

export function deactivateAllProviders(): void {
  const db = getDb();
  db.prepare('UPDATE api_providers SET is_active = 0').run();
}

// ==========================================
// Favorite & Recent Directory Operations
// ==========================================

export function getFavoriteDirectories(): Array<{ path: string; name: string }> {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get('favorite_directories') as { value: string } | undefined;
  if (!row) return [];
  try { return JSON.parse(row.value); } catch { return []; }
}

export function addFavoriteDirectory(dirPath: string, name: string): void {
  const db = getDb();
  const favorites = getFavoriteDirectories();
  if (favorites.some(f => f.path === dirPath)) return;
  favorites.push({ path: dirPath, name });
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run('favorite_directories', JSON.stringify(favorites));
}

export function removeFavoriteDirectory(dirPath: string): void {
  const db = getDb();
  const favorites = getFavoriteDirectories().filter(f => f.path !== dirPath);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run('favorite_directories', JSON.stringify(favorites));
}

export function getRecentDirectories(limit = 5): string[] {
  const db = getDb();
  const rows = db.prepare(
    "SELECT DISTINCT working_directory FROM chat_sessions WHERE working_directory IS NOT NULL AND working_directory != '' ORDER BY updated_at DESC LIMIT ?"
  ).all(limit) as Array<{ working_directory: string }>;
  return rows.map(r => r.working_directory);
}

// --- Push Subscriptions ---

export function upsertPushSubscription(
  endpoint: string,
  keysP256dh: string,
  keysAuth: string,
  userAgent?: string,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, keys_p256dh, keys_auth, user_agent)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      keys_p256dh = excluded.keys_p256dh,
      keys_auth = excluded.keys_auth,
      user_agent = excluded.user_agent
  `).run(endpoint, keysP256dh, keysAuth, userAgent || null);
}

export function deletePushSubscription(endpoint: string): void {
  const db = getDb();
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export function getAllPushSubscriptions(): Array<{
  endpoint: string;
  keys_p256dh: string;
  keys_auth: string;
  created_at: string;
  user_agent: string | null;
}> {
  const db = getDb();
  return db.prepare('SELECT * FROM push_subscriptions').all() as Array<{
    endpoint: string;
    keys_p256dh: string;
    keys_auth: string;
    created_at: string;
    user_agent: string | null;
  }>;
}

// --- Message Bookmarks ---

export function toggleBookmark(messageId: string, bookmarked: boolean): void {
  const db = getDb();
  db.prepare('UPDATE messages SET bookmarked = ? WHERE id = ?').run(bookmarked ? 1 : 0, messageId);
}

// ==========================================
// Graceful Shutdown
// ==========================================

/**
 * Close the database connection gracefully.
 * In WAL mode, this ensures the WAL is checkpointed and the
 * -wal/-shm files are cleaned up properly.
 */
export function closeDb(): void {
  if (db) {
    try {
      db.close();
      console.log('[db] Database closed gracefully');
    } catch (err) {
      console.warn('[db] Error closing database:', err);
    }
    db = null;
  }
}

// Register shutdown handlers to close the database when the process exits.
// This prevents WAL file accumulation and potential data loss.
function registerShutdownHandlers(): void {
  let shuttingDown = false;

  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[db] Received ${signal}, closing database...`);
    closeDb();
  };

  // 'exit' fires synchronously when the process is about to exit
  process.on('exit', () => shutdown('exit'));

  // Handle termination signals (Docker stop, systemd, Ctrl+C, etc.)
  process.on('SIGTERM', () => {
    shutdown('SIGTERM');
    process.exit(0);
  });
  process.on('SIGINT', () => {
    shutdown('SIGINT');
    process.exit(0);
  });

  // Handle Windows-specific close events
  if (process.platform === 'win32') {
    process.on('SIGHUP', () => {
      shutdown('SIGHUP');
      process.exit(0);
    });
  }
}

registerShutdownHandlers();
