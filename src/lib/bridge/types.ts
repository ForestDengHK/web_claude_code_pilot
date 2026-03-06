/**
 * Bridge system types — shared across all bridge modules.
 */

import type { FileAttachment } from '@/types';

// ChannelType: string alias (extensible without enum modification)
export type ChannelType = string;

// ChannelAddress: identifies a user within a channel
export interface ChannelAddress {
  channelType: ChannelType;
  chatId: string;
  userId?: string;
  displayName?: string;
}

// InboundMessage from an IM channel
export interface InboundMessage {
  messageId: string;
  address: ChannelAddress;
  text: string;
  timestamp: number;
  callbackData?: string;
  callbackMessageId?: string;
  raw?: unknown;
  updateId?: number;
  attachments?: FileAttachment[];
}

// OutboundMessage to send to an IM channel
export interface OutboundMessage {
  address: ChannelAddress;
  text: string;
  parseMode?: 'HTML' | 'Markdown' | 'plain';
  inlineButtons?: InlineButton[][];
  replyToMessageId?: string;
}

export interface InlineButton {
  text: string;
  callbackData: string;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
  httpStatus?: number;
  retryAfter?: number;
}

// ChannelBinding: links an IM chat to a CodePilot session
export interface ChannelBinding {
  id: string;
  channelType: ChannelType;
  chatId: string;
  codepilotSessionId: string;
  sdkSessionId: string;
  workingDirectory: string;
  model: string;
  mode: 'code' | 'plan' | 'ask';
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

// Bridge status
export interface BridgeStatus {
  running: boolean;
  startedAt: string | null;
  adapters: AdapterStatus[];
}

export interface AdapterStatus {
  channelType: ChannelType;
  running: boolean;
  connectedAt: string | null;
  lastMessageAt: string | null;
  error: string | null;
}

// Audit log entry
export interface AuditLogEntry {
  id: string;
  channelType: ChannelType;
  chatId: string;
  direction: 'inbound' | 'outbound';
  messageId: string;
  summary: string;
  createdAt: string;
}

// Permission link: maps permissionRequestId to an IM message
export interface PermissionLink {
  id: string;
  permissionRequestId: string;
  channelType: ChannelType;
  chatId: string;
  messageId: string;
  toolName?: string;
  suggestions?: string;
  resolved: boolean;
  createdAt: string;
}

// Streaming preview
export interface PreviewCapabilities {
  supported: boolean;
  privateOnly: boolean;
}

export interface StreamingPreviewState {
  draftId: number;
  chatId: string;
  lastSentText: string;
  lastSentAt: number;
  degraded: boolean;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  pendingText: string;
}

// Stream configuration
export interface StreamConfig {
  intervalMs: number;
  minDeltaChars: number;
  maxChars: number;
}
