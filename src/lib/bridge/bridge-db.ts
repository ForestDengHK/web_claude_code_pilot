/**
 * Bridge-specific DB layer.
 * Imports getDb() from the main db module and lazily creates bridge tables.
 * Does NOT modify existing tables in src/lib/db.ts.
 */

import { getDb } from '../db';
import crypto from 'crypto';
import type { ChannelBinding, ChannelType, PermissionLink } from './types';

const MIGRATION_KEY = '__bridge_db_migrated__';

function ensureBridgeTables(): void {
  const g = globalThis as Record<string, boolean>;
  if (g[MIGRATION_KEY]) return;
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_bindings (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      codepilot_session_id TEXT NOT NULL,
      sdk_session_id TEXT DEFAULT '',
      working_directory TEXT DEFAULT '',
      model TEXT DEFAULT '',
      mode TEXT DEFAULT 'code',
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(channel_type, chat_id)
    );

    CREATE TABLE IF NOT EXISTS channel_offsets (
      channel_key TEXT PRIMARY KEY,
      offset_value TEXT NOT NULL DEFAULT '0'
    );

    CREATE TABLE IF NOT EXISTS channel_dedupe (
      dedup_key TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_outbound_refs (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      codepilot_session_id TEXT NOT NULL,
      platform_message_id TEXT NOT NULL,
      purpose TEXT DEFAULT 'response',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channel_audit_logs (
      id TEXT PRIMARY KEY,
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      direction TEXT NOT NULL,
      message_id TEXT NOT NULL,
      summary TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS channel_permission_links (
      id TEXT PRIMARY KEY,
      permission_request_id TEXT NOT NULL UNIQUE,
      channel_type TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      tool_name TEXT DEFAULT '',
      suggestions TEXT DEFAULT '',
      resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  g[MIGRATION_KEY] = true;
}

// ==========================================
// Row → TS mapping helpers
// ==========================================

interface ChannelBindingRow {
  id: string;
  channel_type: string;
  chat_id: string;
  codepilot_session_id: string;
  sdk_session_id: string;
  working_directory: string;
  model: string;
  mode: string;
  active: number;
  created_at: string;
  updated_at: string;
}

function rowToBinding(row: ChannelBindingRow): ChannelBinding {
  return {
    id: row.id,
    channelType: row.channel_type,
    chatId: row.chat_id,
    codepilotSessionId: row.codepilot_session_id,
    sdkSessionId: row.sdk_session_id,
    workingDirectory: row.working_directory,
    model: row.model,
    mode: row.mode as ChannelBinding['mode'],
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface PermissionLinkRow {
  id: string;
  permission_request_id: string;
  channel_type: string;
  chat_id: string;
  message_id: string;
  tool_name: string;
  suggestions: string;
  resolved: number;
  created_at: string;
}

function rowToPermissionLink(row: PermissionLinkRow): PermissionLink {
  return {
    id: row.id,
    permissionRequestId: row.permission_request_id,
    channelType: row.channel_type,
    chatId: row.chat_id,
    messageId: row.message_id,
    toolName: row.tool_name || undefined,
    suggestions: row.suggestions || undefined,
    resolved: row.resolved === 1,
    createdAt: row.created_at,
  };
}

// ==========================================
// Channel Bindings
// ==========================================

export function upsertChannelBinding(params: {
  channelType: string;
  chatId: string;
  codepilotSessionId: string;
  workingDirectory?: string;
  model?: string;
}): ChannelBinding {
  ensureBridgeTables();
  const db = getDb();
  const id = crypto.randomUUID();

  db.prepare(`
    INSERT INTO channel_bindings (id, channel_type, chat_id, codepilot_session_id, working_directory, model)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_type, chat_id) DO UPDATE SET
      codepilot_session_id = excluded.codepilot_session_id,
      working_directory = COALESCE(excluded.working_directory, channel_bindings.working_directory),
      model = COALESCE(excluded.model, channel_bindings.model),
      active = 1,
      updated_at = datetime('now')
  `).run(
    id,
    params.channelType,
    params.chatId,
    params.codepilotSessionId,
    params.workingDirectory || null,
    params.model || null,
  );

  return getChannelBinding(params.channelType, params.chatId)!;
}

export function getChannelBinding(channelType: string, chatId: string): ChannelBinding | undefined {
  ensureBridgeTables();
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM channel_bindings WHERE channel_type = ? AND chat_id = ?'
  ).get(channelType, chatId) as ChannelBindingRow | undefined;
  return row ? rowToBinding(row) : undefined;
}

export function updateChannelBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active'>>,
): void {
  ensureBridgeTables();
  const db = getDb();

  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (updates.sdkSessionId !== undefined) {
    setClauses.push('sdk_session_id = ?');
    values.push(updates.sdkSessionId);
  }
  if (updates.workingDirectory !== undefined) {
    setClauses.push('working_directory = ?');
    values.push(updates.workingDirectory);
  }
  if (updates.model !== undefined) {
    setClauses.push('model = ?');
    values.push(updates.model);
  }
  if (updates.mode !== undefined) {
    setClauses.push('mode = ?');
    values.push(updates.mode);
  }
  if (updates.active !== undefined) {
    setClauses.push('active = ?');
    values.push(updates.active ? 1 : 0);
  }

  if (setClauses.length === 0) return;

  setClauses.push("updated_at = datetime('now')");
  values.push(id);

  db.prepare(`UPDATE channel_bindings SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);
}

export function listChannelBindings(channelType?: ChannelType): ChannelBinding[] {
  ensureBridgeTables();
  const db = getDb();

  let rows: ChannelBindingRow[];
  if (channelType) {
    rows = db.prepare('SELECT * FROM channel_bindings WHERE channel_type = ?').all(channelType) as ChannelBindingRow[];
  } else {
    rows = db.prepare('SELECT * FROM channel_bindings').all() as ChannelBindingRow[];
  }
  return rows.map(rowToBinding);
}

export function deleteChannelBinding(id: string): boolean {
  ensureBridgeTables();
  const db = getDb();
  const result = db.prepare('DELETE FROM channel_bindings WHERE id = ?').run(id);
  return result.changes > 0;
}

// ==========================================
// Channel Offsets
// ==========================================

export function getChannelOffset(channelKey: string): string {
  ensureBridgeTables();
  const db = getDb();
  const row = db.prepare('SELECT offset_value FROM channel_offsets WHERE channel_key = ?').get(channelKey) as { offset_value: string } | undefined;
  return row?.offset_value ?? '0';
}

export function setChannelOffset(channelKey: string, offsetValue: string): void {
  ensureBridgeTables();
  const db = getDb();
  db.prepare(
    'INSERT INTO channel_offsets (channel_key, offset_value) VALUES (?, ?) ON CONFLICT(channel_key) DO UPDATE SET offset_value = excluded.offset_value'
  ).run(channelKey, offsetValue);
}

// ==========================================
// Deduplication
// ==========================================

export function checkDedup(dedupKey: string): boolean {
  ensureBridgeTables();
  const db = getDb();
  const now = Date.now();
  const row = db.prepare(
    'SELECT 1 FROM channel_dedupe WHERE dedup_key = ? AND expires_at > ?'
  ).get(dedupKey, now);
  return !!row;
}

export function insertDedup(dedupKey: string, ttlMs: number = 24 * 60 * 60 * 1000): void {
  ensureBridgeTables();
  const db = getDb();
  const now = Date.now();
  db.prepare(
    'INSERT OR REPLACE INTO channel_dedupe (dedup_key, created_at, expires_at) VALUES (?, ?, ?)'
  ).run(dedupKey, now, now + ttlMs);
}

export function cleanupExpiredDedup(): number {
  ensureBridgeTables();
  const db = getDb();
  const now = Date.now();
  const result = db.prepare('DELETE FROM channel_dedupe WHERE expires_at <= ?').run(now);
  return result.changes;
}

// ==========================================
// Audit Logs
// ==========================================

export function getAuditMessageIds(channelType: string, chatId: string): string[] {
  ensureBridgeTables();
  const db = getDb();
  const rows = db.prepare(
    'SELECT DISTINCT message_id FROM channel_audit_logs WHERE channel_type = ? AND chat_id = ? ORDER BY created_at'
  ).all(channelType, chatId) as { message_id: string }[];
  return rows.map((r) => r.message_id);
}

export function clearAuditLogs(channelType: string, chatId: string): void {
  ensureBridgeTables();
  const db = getDb();
  db.prepare('DELETE FROM channel_audit_logs WHERE channel_type = ? AND chat_id = ?').run(channelType, chatId);
}

export function clearOutboundRefs(channelType: string, chatId: string): void {
  ensureBridgeTables();
  const db = getDb();
  db.prepare('DELETE FROM channel_outbound_refs WHERE channel_type = ? AND chat_id = ?').run(channelType, chatId);
}

export function insertAuditLog(params: {
  channelType: string;
  chatId: string;
  direction: string;
  messageId: string;
  summary: string;
}): void {
  ensureBridgeTables();
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO channel_audit_logs (id, channel_type, chat_id, direction, message_id, summary) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, params.channelType, params.chatId, params.direction, params.messageId, params.summary);
}

// ==========================================
// Outbound Refs
// ==========================================

export function insertOutboundRef(params: {
  channelType: string;
  chatId: string;
  codepilotSessionId: string;
  platformMessageId: string;
  purpose: string;
}): void {
  ensureBridgeTables();
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO channel_outbound_refs (id, channel_type, chat_id, codepilot_session_id, platform_message_id, purpose) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, params.channelType, params.chatId, params.codepilotSessionId, params.platformMessageId, params.purpose);
}

// ==========================================
// Permission Links
// ==========================================

export function insertPermissionLink(params: {
  permissionRequestId: string;
  channelType: string;
  chatId: string;
  messageId: string;
  toolName?: string;
  suggestions?: string;
}): void {
  ensureBridgeTables();
  const db = getDb();
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO channel_permission_links (id, permission_request_id, channel_type, chat_id, message_id, tool_name, suggestions) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(id, params.permissionRequestId, params.channelType, params.chatId, params.messageId, params.toolName ?? '', params.suggestions ?? '');
}

export function getPermissionLink(permissionRequestId: string): PermissionLink | null {
  ensureBridgeTables();
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM channel_permission_links WHERE permission_request_id = ?'
  ).get(permissionRequestId) as PermissionLinkRow | undefined;
  return row ? rowToPermissionLink(row) : null;
}

export function markPermissionLinkResolved(permissionRequestId: string): boolean {
  ensureBridgeTables();
  const db = getDb();
  const result = db.prepare(
    'UPDATE channel_permission_links SET resolved = 1 WHERE permission_request_id = ? AND resolved = 0'
  ).run(permissionRequestId);
  return result.changes > 0;
}

// ==========================================
// Reset (for testing)
// ==========================================

/** @internal — reset migration flag so tables are re-checked */
export function _resetMigrationFlag(): void {
  const g = globalThis as Record<string, boolean>;
  delete g[MIGRATION_KEY];
}
