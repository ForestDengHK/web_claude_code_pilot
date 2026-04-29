'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import type { Message, TokenUsage, FileAttachment, ViewMode } from '@/types';
import {
  Message as AIMessage,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import { ToolActionsGroup } from '@/components/ai-elements/tool-actions-group';
import { CopyIcon, CheckIcon, ChevronDownIcon, ChevronUpIcon, PencilIcon } from 'lucide-react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Bookmark02Icon, BrainIcon } from '@hugeicons/core-free-icons';
import { usePanel } from '@/hooks/usePanel';
import { RememberDialog } from './RememberDialog';
import { DownloadMenu } from './DownloadMenu';
import { FileAttachmentDisplay } from './FileAttachmentDisplay';
import { TTSButton } from './TTSButton';
import { useTTS } from '@/contexts/TTSContext';
import { findTextRange, highlightRange, scrollToRange } from '@/lib/tts/highlight';
import type { HealthAlert } from '@/lib/context-health';
import { ContextHealthDot } from './ContextHealthDot';

interface MessageItemProps {
  message: Message;
  searchQuery?: string;
  isLatestMessage?: boolean;
  viewMode?: ViewMode;
  healthAlerts?: HealthAlert[];
  /**
   * Optional session-level dismiss callback forwarded from ChatView's
   * `useContextHealth` hook so the dot's ✕ suppresses the same rule the
   * top-level toast would suppress. No-op when absent (backwards compat).
   */
  onDismissHealthAlert?: (ruleId: string) => void;
  /**
   * When provided, user messages get an edit affordance that — on save —
   * rolls the Codex thread back to before this turn and resends the new
   * prompt. Currently only wired for Codex-backend sessions.
   */
  onEditMessage?: (messageId: string, newContent: string) => Promise<void>;
  isStreaming?: boolean;
}

interface ToolBlock {
  type: 'tool_use' | 'tool_result';
  id?: string;
  name?: string;
  input?: unknown;
  content?: string;
  is_error?: boolean;
}

interface ImageBlockInfo {
  path: string;
  alt?: string;
}

function parseToolBlocks(content: string): { text: string; tools: ToolBlock[]; thinking: string; images: ImageBlockInfo[] } {
  const tools: ToolBlock[] = [];
  const images: ImageBlockInfo[] = [];
  let text = '';
  let thinking = '';

  // Try to parse as JSON array (new format from chat API)
  if (content.startsWith('[')) {
    try {
      const blocks = JSON.parse(content) as Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: unknown;
        tool_use_id?: string;
        content?: string;
        is_error?: boolean;
        path?: string;
        alt?: string;
      }>;

      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          if (text) text += '\n\n';
          text += block.text;
        } else if (block.type === 'thinking' && block.text) {
          thinking += block.text;
        } else if (block.type === 'tool_use') {
          tools.push({
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input,
          });
        } else if (block.type === 'tool_result') {
          tools.push({
            type: 'tool_result',
            id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error,
          });
        } else if (block.type === 'image' && block.path) {
          images.push({ path: block.path, alt: block.alt });
        }
      }

      return { text: text.trim(), tools, thinking, images };
    } catch {
      // Not valid JSON, fall through to legacy parsing
    }
  }

  // Legacy format: HTML comments
  text = content;
  const toolUseRegex = /<!--tool_use:([\s\S]*?)-->/g;
  let match;
  while ((match = toolUseRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      tools.push({ type: 'tool_use', ...parsed });
    } catch {
      // skip malformed
    }
    text = text.replace(match[0], '');
  }

  const toolResultRegex = /<!--tool_result:([\s\S]*?)-->/g;
  while ((match = toolResultRegex.exec(content)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      tools.push({ type: 'tool_result', ...parsed });
    } catch {
      // skip malformed
    }
    text = text.replace(match[0], '');
  }

  return { text: text.trim(), tools, thinking: '', images: [] };
}

function GeneratedImage({ path, alt, sessionId }: { path: string; alt?: string; sessionId: string }) {
  const src = `/api/codex/image?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`;
  const filename = path.split('/').pop() || 'image';
  return (
    <a href={src} target="_blank" rel="noreferrer" className="block my-2">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt || filename}
        className="max-w-full rounded-md border border-border/40"
        loading="lazy"
      />
    </a>
  );
}

function pairTools(tools: ToolBlock[]): Array<{
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
}> {
  const paired: Array<{
    name: string;
    input: unknown;
    result?: string;
    isError?: boolean;
  }> = [];

  const resultMap = new Map<string, ToolBlock>();
  for (const t of tools) {
    if (t.type === 'tool_result' && t.id) {
      resultMap.set(t.id, t);
    }
  }

  for (const t of tools) {
    if (t.type === 'tool_use' && t.name) {
      const result = t.id ? resultMap.get(t.id) : undefined;
      paired.push({
        name: t.name,
        input: t.input,
        result: result?.content,
        isError: result?.is_error,
      });
    }
  }

  for (const t of tools) {
    if (t.type === 'tool_result' && !tools.some(u => u.type === 'tool_use' && u.id === t.id)) {
      paired.push({
        name: 'tool_result',
        input: {},
        result: t.content,
        isError: t.is_error,
      });
    }
  }

  return paired;
}

function parseMessageFiles(content: string): { files: FileAttachment[]; text: string } {
  const match = content.match(/^<!--files:(.*?)-->\n?/);
  if (!match) return { files: [], text: content };
  try {
    const files = JSON.parse(match[1]);
    const text = content.slice(match[0].length);
    return { files, text };
  } catch {
    return { files: [], text: content };
  }
}

// Relies on AppShell's global polyfill for non-secure contexts (HTTP via Tailscale).
function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
}

function CopyButton({ text }: { text: string }) {
  // Use a counter so each click always triggers a re-render (even if already showing ✓)
  const [copyCount, setCopyCount] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const copied = copyCount > 0;

  const handleCopy = useCallback(() => {
    try {
      copyToClipboard(text);
    } catch {
      // ignore clipboard errors
    }
    // Clear previous timer to prevent stale timeout resetting state
    clearTimeout(timerRef.current);
    // Increment counter — always triggers re-render even when ✓ is already shown
    setCopyCount(c => c + 1);
    timerRef.current = setTimeout(() => setCopyCount(0), 2000);
  }, [text]);

  // Cleanup on unmount
  useEffect(() => () => clearTimeout(timerRef.current), []);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center justify-center rounded-md min-w-[32px] min-h-[32px] px-1.5 py-1 text-xs text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted active:bg-muted/80 transition-colors"
      title="Copy"
    >
      {copied ? (
        <CheckIcon key={copyCount} className="h-3.5 w-3.5 text-green-500" />
      ) : (
        <CopyIcon className="h-3.5 w-3.5" />
      )}
    </button>
  );
}


function TokenUsageDisplay({ usage }: { usage: TokenUsage }) {
  const totalTokens = usage.input_tokens + usage.output_tokens;
  const reasoningTokens = usage.reasoning_output_tokens ?? 0;
  const hasTokenMetrics = totalTokens > 0
    || (usage.cache_read_input_tokens ?? 0) > 0
    || (usage.cache_creation_input_tokens ?? 0) > 0
    || usage.cost_usd !== undefined;
  const costStr = usage.cost_usd !== undefined && usage.cost_usd !== null
    ? ` · $${usage.cost_usd.toFixed(4)}`
    : '';
  const effortLabel = usage.effort
    ? { low: 'Lo', medium: 'Med', high: 'Hi', xhigh: 'XHi', max: 'Max' }[usage.effort] ?? usage.effort
    : null;

  return (
    <span className="text-xs text-muted-foreground/50">
      {usage.model && <>{usage.model}</>}
      {effortLabel && <span className="ml-1 px-1 rounded bg-muted/60 font-mono">{effortLabel}</span>}
      {hasTokenMetrics && (usage.model || effortLabel) && <> · </>}
      {hasTokenMetrics && <>{totalTokens.toLocaleString()} tokens{costStr}</>}
      {reasoningTokens > 0 && <> · {reasoningTokens.toLocaleString()} reasoning</>}
    </span>
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark key={i} className="bg-yellow-300/40 dark:bg-yellow-500/30 text-inherit rounded-sm px-0.5">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}

function formatThinkingContent(raw: string): string {
  return raw
    .replace(/\*\*\*\*/g, '\n')
    .replace(/\*\*/g, '')
    .replace(/^\n+/, '')
    .trim();
}

function StoredThinkingBlock({ content }: { content: string }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const formatted = formatThinkingContent(content);

  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
      >
        <span className="text-sm">{'\u{1F4AD}'}</span>
        <span>{isExpanded ? 'Thinking' : 'Thinking (tap to expand)'}</span>
        <svg
          className={`h-3 w-3 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isExpanded && (
        <div className="pl-6 text-xs text-muted-foreground/70 whitespace-pre-wrap break-words border-l-2 border-muted-foreground/20 ml-1 max-h-[50vh] overflow-y-auto">
          {formatted}
        </div>
      )}
    </div>
  );
}

const COLLAPSE_HEIGHT = 300;

export function MessageItem({ message, searchQuery, isLatestMessage, viewMode = 'normal', healthAlerts, onDismissHealthAlert, onEditMessage, isStreaming }: MessageItemProps) {
  const { sessionTitle, workingDirectory } = usePanel();
  const [rememberDialogOpen, setRememberDialogOpen] = useState(false);

  // Build filename base for downloads: {sessionTitle}-{YYYY-MM-DD-HH-mm}
  const filenameBase = (() => {
    const date = new Date(message.created_at);
    const ts = [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
      String(date.getHours()).padStart(2, '0'),
      String(date.getMinutes()).padStart(2, '0'),
    ].join('-');
    const base = (sessionTitle || 'codepilot')
      .replace(/[/\\?%*:|"<>]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 80) || 'codepilot';
    return `${base}-${ts}`;
  })();

  const isUser = message.role === 'user';
  const { text, tools, thinking, images } = parseToolBlocks(message.content);
  const pairedTools = pairTools(tools);

  // Parse file attachments from user messages
  const { files, text: textWithoutFiles } = isUser
    ? parseMessageFiles(text)
    : { files: [], text };

  const displayText = isUser ? textWithoutFiles : text;

  // Bookmark state — sync with message prop when it changes (e.g., messages reloaded from API)
  const [isBookmarked, setIsBookmarked] = useState(!!message.bookmarked);
  useEffect(() => {
    setIsBookmarked(!!message.bookmarked);
  }, [message.bookmarked]);

  const handleBookmarkToggle = useCallback(async () => {
    const newState = !isBookmarked;
    setIsBookmarked(newState);
    // Also update the message object directly so parent filters see the change
    message.bookmarked = newState ? 1 : 0;
    try {
      const res = await fetch(
        `/api/chat/sessions/${message.session_id}/messages/${message.id}/bookmark`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bookmarked: newState }),
        },
      );
      if (!res.ok) {
        setIsBookmarked(!newState);
        message.bookmarked = newState ? 0 : 1;
      }
    } catch {
      setIsBookmarked(!newState);
      message.bookmarked = newState ? 0 : 1;
    }
  }, [isBookmarked, message]);

  // Collapse/expand state for long user messages
  const [isExpanded, setIsExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isUser && contentRef.current) {
      setIsOverflowing(contentRef.current.scrollHeight > COLLAPSE_HEIGHT);
    }
  }, [isUser, displayText]);

  // Edit-and-resend (Codex rollback flow). Only enabled when ChatView wires
  // onEditMessage — for now that's Codex-backend sessions only.
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const canEdit = isUser && !!onEditMessage && !isStreaming;
  const startEdit = useCallback(() => {
    setEditText(displayText);
    setEditError(null);
    setIsEditing(true);
  }, [displayText]);
  const cancelEdit = useCallback(() => {
    setIsEditing(false);
    setEditText('');
    setEditError(null);
  }, []);
  const saveEdit = useCallback(async () => {
    if (!onEditMessage) return;
    const trimmed = editText.trim();
    if (!trimmed) return;
    setEditSaving(true);
    setEditError(null);
    try {
      await onEditMessage(message.id, trimmed);
      // On success this message is removed from the list, so we don't bother
      // resetting isEditing — the component unmounts.
    } catch (err) {
      setEditError(err instanceof Error ? err.message : String(err));
      setEditSaving(false);
    }
  }, [editText, message.id, onEditMessage]);

  let tokenUsage: TokenUsage | null = null;
  if (message.token_usage) {
    try {
      tokenUsage = JSON.parse(message.token_usage);
    } catch {
      // skip
    }
  }

  // TTS highlight
  const tts = useTTS();
  const responseRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const isThisMessageActive = tts.activeMessageId === `msg-${message.id}`;

  // Sequential position tracking — prevents highlight from jumping to
  // earlier occurrences of repeated/similar text in the message
  const lastMatchEndRef = useRef(0);
  const prevSegmentRef = useRef(-1);

  useEffect(() => {
    // Cleanup previous highlight
    cleanupRef.current?.();
    cleanupRef.current = null;

    if (!isThisMessageActive || !responseRef.current) {
      lastMatchEndRef.current = 0;
      prevSegmentRef.current = -1;
      return;
    }
    if (tts.activeSegmentIndex < 0 || tts.activeSegmentIndex >= tts.segments.length) return;

    // Only use position tracking for sequential advance (index incremented by 1);
    // for seeks or jumps, reset to search from the beginning
    const isSequential = tts.activeSegmentIndex === prevSegmentRef.current + 1;
    prevSegmentRef.current = tts.activeSegmentIndex;
    const searchAfter = isSequential ? lastMatchEndRef.current : 0;

    const activeSegment = tts.segments[tts.activeSegmentIndex];
    const result = findTextRange(responseRef.current, activeSegment.text, searchAfter);
    if (!result) return;

    lastMatchEndRef.current = result.textOffset;
    cleanupRef.current = highlightRange(result.range, responseRef.current);

    // Auto-scroll
    const scrollContainer = responseRef.current.closest('[data-scroll-container]') ||
      responseRef.current.closest('[data-test-id="virtuoso-scroller"]');
    scrollToRange(result.range, scrollContainer);

    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [isThisMessageActive, tts.activeSegmentIndex, tts.segments]);

  // Seek on click: when TTS is active, tapping text jumps to that segment
  const handleSeekClick = useCallback((e: React.MouseEvent) => {
    if (!isThisMessageActive || !responseRef.current) return;
    if (tts.state !== 'playing' && tts.state !== 'paused') return;
    if (tts.segments.length === 0) return;

    // Don't intercept clicks on buttons/links
    const target = e.target as HTMLElement;
    if (target.closest('button, a')) return;

    // Find which segment contains the clicked position
    // Seek handler searches all segments sequentially from document start
    let seekSearchAfter = 0;
    for (let i = 0; i < tts.segments.length; i++) {
      const result = findTextRange(responseRef.current, tts.segments[i].text, seekSearchAfter);
      if (!result) continue;
      seekSearchAfter = result.textOffset;

      const rects = result.range.getClientRects();
      for (let r = 0; r < rects.length; r++) {
        const rect = rects[r];
        if (e.clientX >= rect.left && e.clientX <= rect.right &&
            e.clientY >= rect.top && e.clientY <= rect.bottom) {
          tts.seekToSegment(i);
          return;
        }
      }
    }
  }, [isThisMessageActive, tts]);

  const timestamp = new Date(message.created_at).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <AIMessage from={isUser ? 'user' : 'assistant'} id={`msg-${message.id}`}>
      <MessageContent>
        {/* File attachments for user messages */}
        {isUser && files.length > 0 && (
          <FileAttachmentDisplay files={files} />
        )}

        {/* Thinking block for Codex messages (hidden in summary mode) */}
        {!isUser && thinking && viewMode !== 'summary' && (
          <StoredThinkingBlock content={thinking} />
        )}

        {/* Tool calls for assistant messages — compact collapsible group (hidden in summary mode) */}
        {!isUser && pairedTools.length > 0 && viewMode !== 'summary' && (
          <ToolActionsGroup
            tools={pairedTools.map((tool, i) => ({
              id: `hist-${i}`,
              name: tool.name,
              input: tool.input,
              result: tool.result,
              isError: tool.isError,
            }))}
            isLatestMessage={isLatestMessage}
            viewMode={viewMode}
          />
        )}

        {/* Text content */}
        {displayText && (
          isUser ? (
            isEditing ? (
              <div className="space-y-2">
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  disabled={editSaving}
                  autoFocus
                  rows={Math.min(12, Math.max(3, editText.split('\n').length + 1))}
                  className="w-full text-sm rounded-md border border-border/60 bg-background px-2 py-1.5 font-mono resize-y disabled:opacity-50"
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      cancelEdit();
                    } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      saveEdit();
                    }
                  }}
                />
                {editError && (
                  <div className="text-xs text-red-500">{editError}</div>
                )}
                <div className="flex items-center justify-end gap-2">
                  <span className="text-xs text-muted-foreground/70">
                    Saving will roll the Codex thread back and resend
                  </span>
                  <button
                    type="button"
                    onClick={cancelEdit}
                    disabled={editSaving}
                    className="text-xs px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={saveEdit}
                    disabled={editSaving || !editText.trim() || editText.trim() === displayText.trim()}
                    className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {editSaving ? 'Saving…' : 'Save & resend'}
                  </button>
                </div>
              </div>
            ) : (
            <div className="relative">
              <div
                ref={contentRef}
                className="text-sm whitespace-pre-wrap break-words transition-[max-height] duration-300 ease-in-out overflow-hidden"
                style={
                  isOverflowing && !isExpanded
                    ? { maxHeight: `${COLLAPSE_HEIGHT}px` }
                    : undefined
                }
              >
                {searchQuery ? <HighlightedText text={displayText} query={searchQuery} /> : displayText}
              </div>
              {isOverflowing && !isExpanded && (
                <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-secondary to-transparent pointer-events-none" />
              )}
              {isOverflowing && (
                <button
                  type="button"
                  onClick={() => setIsExpanded(!isExpanded)}
                  className="relative z-10 flex items-center gap-1 mt-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {isExpanded ? (
                    <>
                      <ChevronUpIcon className="h-3 w-3" />
                      <span>收起</span>
                    </>
                  ) : (
                    <>
                      <ChevronDownIcon className="h-3 w-3" />
                      <span>展开</span>
                    </>
                  )}
                </button>
              )}
            </div>
            )
          ) : (
            <div ref={responseRef} onClick={handleSeekClick} style={isThisMessageActive ? { cursor: 'pointer' } : undefined}>
              <MessageResponse>{displayText}</MessageResponse>
            </div>
          )
        )}

        {/* Generated images (e.g. gpt-image-2 outputs from Codex) */}
        {!isUser && images.length > 0 && (
          <div className="mt-2 space-y-2">
            {images.map((img, i) => (
              <GeneratedImage key={`${img.path}-${i}`} path={img.path} alt={img.alt} sessionId={message.session_id} />
            ))}
          </div>
        )}
      </MessageContent>

      {/* Footer with always-visible metadata and hover-visible actions */}
      <div className={`flex items-center gap-2 ${isUser ? 'justify-end' : 'w-full justify-between'}`}>
        {!isUser && (
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-xs text-muted-foreground/50">{timestamp}</span>
            {tokenUsage && viewMode !== 'summary' && (
              <>
                <TokenUsageDisplay usage={tokenUsage} />
                {healthAlerts && healthAlerts.length > 0 && (
                  <ContextHealthDot alerts={healthAlerts} onDismiss={onDismissHealthAlert} />
                )}
              </>
            )}
          </div>
        )}

        <div className={`flex items-center gap-2 ${!isUser ? 'md:opacity-0 md:group-hover:opacity-100 transition-opacity duration-200' : ''}`}>
          {!isUser && (
            <button
              onClick={handleBookmarkToggle}
              className={`p-0.5 rounded transition-colors ${
                isBookmarked
                  ? 'text-amber-500'
                  : 'text-muted-foreground/50 hover:text-muted-foreground'
              }`}
              title={isBookmarked ? 'Remove bookmark' : 'Bookmark this message'}
            >
              <HugeiconsIcon
                icon={Bookmark02Icon}
                size={14}
                fill={isBookmarked ? 'currentColor' : 'none'}
              />
            </button>
          )}
          {!isUser && (
            <button
              onClick={() => setRememberDialogOpen(true)}
              className="p-0.5 rounded text-muted-foreground/50 hover:text-blue-500 transition-colors"
              title="Remember this"
            >
              <HugeiconsIcon icon={BrainIcon} size={14} />
            </button>
          )}
          {!isUser && displayText && (
            <TTSButton messageId={`msg-${message.id}`} text={displayText} />
          )}
          {displayText && <CopyButton text={displayText} />}
          {canEdit && !isEditing && (
            <button
              type="button"
              onClick={startEdit}
              className="inline-flex items-center justify-center rounded-md min-w-[32px] min-h-[32px] px-1.5 py-1 text-xs text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted active:bg-muted/80 transition-colors"
              title="Edit and resend (rolls Codex thread back)"
            >
              <PencilIcon className="h-3.5 w-3.5" />
            </button>
          )}
          {!isUser && displayText && (
            <DownloadMenu markdown={displayText} filenameBase={filenameBase} />
          )}
        </div>
      </div>

      {/* Remember dialog */}
      {rememberDialogOpen && (
        <RememberDialog
          open={rememberDialogOpen}
          onClose={() => setRememberDialogOpen(false)}
          defaultContent={displayText?.slice(0, 8000) || ''}
          sourceSessionId={message.session_id}
          workingDirectory={workingDirectory}
        />
      )}
    </AIMessage>
  );
}
