'use client';

import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { Virtuoso, VirtuosoHandle } from 'react-virtuoso';
import { useSearchParams } from 'next/navigation';
import type { Message, PermissionRequestEvent, InputRequestEvent, ViewMode } from '@/types';
import type { HealthAlert } from '@/lib/context-health';
import {
  Conversation,
  ConversationScrollButton,
  ConversationScrollTopButton,
  ConversationEmptyState,
} from '@/components/ai-elements/conversation';
import { MessageItem } from './MessageItem';
import { StreamingMessage } from './StreamingMessage';
import { CodePilotLogo } from './CodePilotLogo';

interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultInfo {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// ── Virtuoso context type (passes data to stable Header/Footer components) ──
interface VirtuosoContextData {
  hasMore?: boolean;
  loadingMore?: boolean;
  isStreaming: boolean;
  streamingContent: string;
  toolUses: ToolUseInfo[];
  toolResults: ToolResultInfo[];
  streamingToolOutput?: string;
  statusText?: string;
  pendingPermission?: PermissionRequestEvent | null;
  onPermissionResponse?: (decision: 'allow' | 'allow_session' | 'deny') => void;
  permissionResolved?: 'allow' | 'deny' | null;
  pendingInputRequest?: InputRequestEvent | null;
  onInputResponse?: (answers: Record<string, string>) => void;
  inputRequestResolved?: boolean;
  onForceStop?: () => void;
  viewMode?: ViewMode;
}

// ── Stable component definitions (defined OUTSIDE render to preserve identity) ──
// React won't unmount/remount these on re-renders because the function reference
// stays the same. Data flows in via Virtuoso's `context` prop.

function VirtuosoHeader({ context }: { context?: VirtuosoContextData }) {
  if (!context?.hasMore) return null;
  return (
    <div className="flex justify-center py-4">
      <span className="text-sm text-muted-foreground">
        {context.loadingMore ? 'Loading...' : 'Scroll up to load earlier messages'}
      </span>
    </div>
  );
}

function VirtuosoFooter({ context }: { context?: VirtuosoContextData }) {
  if (!context?.isStreaming) return null;
  return (
    <div className="mx-auto max-w-3xl px-4 py-3">
      <StreamingMessage
        content={context.streamingContent}
        isStreaming={context.isStreaming}
        toolUses={context.toolUses}
        toolResults={context.toolResults}
        streamingToolOutput={context.streamingToolOutput}
        statusText={context.statusText}
        pendingPermission={context.pendingPermission}
        onPermissionResponse={context.onPermissionResponse}
        permissionResolved={context.permissionResolved}
        pendingInputRequest={context.pendingInputRequest}
        onInputResponse={context.onInputResponse}
        inputRequestResolved={context.inputRequestResolved}
        onForceStop={context.onForceStop}
        viewMode={context.viewMode}
      />
    </div>
  );
}

// Stable components object (same reference across renders)
const virtuosoComponents = {
  Header: VirtuosoHeader,
  Footer: VirtuosoFooter,
};

interface MessageListProps {
  messages: Message[];
  streamingContent: string;
  thinkingContent?: string;
  isStreaming: boolean;
  toolUses?: ToolUseInfo[];
  toolResults?: ToolResultInfo[];
  streamingToolOutput?: string;
  statusText?: string;
  pendingPermission?: PermissionRequestEvent | null;
  onPermissionResponse?: (decision: 'allow' | 'allow_session' | 'deny') => void;
  permissionResolved?: 'allow' | 'deny' | null;
  pendingInputRequest?: InputRequestEvent | null;
  onInputResponse?: (answers: Record<string, string>) => void;
  inputRequestResolved?: boolean;
  onForceStop?: () => void;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  highlightMessageIds?: Set<string>;
  activeMessageId?: string | null;
  searchQuery?: string;
  viewMode?: ViewMode;
  messageHealthAlerts?: Map<string, HealthAlert[]>;
  onDismissHealthAlert?: (ruleId: string) => void;
  onEditMessage?: (messageId: string, newContent: string) => Promise<void>;
}

export function MessageList({
  messages,
  streamingContent,
  thinkingContent,
  isStreaming,
  toolUses = [],
  toolResults = [],
  streamingToolOutput,
  statusText,
  pendingPermission,
  onPermissionResponse,
  permissionResolved,
  pendingInputRequest,
  onInputResponse,
  inputRequestResolved,
  onForceStop,
  hasMore,
  loadingMore,
  onLoadMore,
  highlightMessageIds,
  activeMessageId,
  searchQuery,
  viewMode = 'normal',
  messageHealthAlerts,
  onDismissHealthAlert,
  onEditMessage,
}: MessageListProps) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  // Mirror of scrollerRef in state, so the user-input listener useEffect can
  // attach/detach when Virtuoso (re)mounts the scroller element.
  const [scrollerEl, setScrollerEl] = useState<HTMLElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [atTop, setAtTop] = useState(true);

  // Track whether we should follow output (auto-scroll to bottom)
  const followOutputRef = useRef(true);
  // Ref mirror of isStreaming — Virtuoso caches callback closures, so inline
  // arrow functions in Virtuoso props may read stale state. Refs always give
  // the current value regardless of closure capture.
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;

  // Stable firstItemIndex for Virtuoso prepend support.
  // Start high, decrease when messages are prepended (load earlier).
  // This tells Virtuoso items were prepended, so it maintains scroll position.
  const FIRST_ITEM_INDEX = 100000;
  const firstItemIndexRef = useRef(FIRST_ITEM_INDEX);
  const prevMessagesRef = useRef(messages);

  // Detect prepend vs replace: if new messages share the same last ID
  // but have more items, it's a prepend (pagination). Otherwise it's a replace (recovery).
  useEffect(() => {
    const prev = prevMessagesRef.current;
    const prevLast = prev[prev.length - 1];
    const currLast = messages[messages.length - 1];
    if (prevLast && currLast && prevLast.id === currLast.id && messages.length > prev.length) {
      // Prepend: shift firstItemIndex down by the number of prepended items
      const prependCount = messages.length - prev.length;
      firstItemIndexRef.current -= prependCount;
    } else if (prev.length > 0 && messages.length > 0 && prev[0].id !== messages[0].id) {
      // Full replace (recovery) — reset to start
      firstItemIndexRef.current = FIRST_ITEM_INDEX;
    }
    prevMessagesRef.current = messages;
  }, [messages]);

  // Highlight message from search navigation (?highlight=<message_id>)
  const searchParams = useSearchParams();
  const highlightMessageId = searchParams.get('highlight');

  useEffect(() => {
    if (!highlightMessageId) return;
    const idx = messages.findIndex(m => m.id === highlightMessageId);
    if (idx >= 0) {
      const timer = setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'smooth' });
        const el = document.getElementById(`msg-${highlightMessageId}`);
        if (el) {
          el.classList.add('search-highlight');
          setTimeout(() => el.classList.remove('search-highlight'), 3000);
        }
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [highlightMessageId, messages]);

  // Scroll to active search result
  useEffect(() => {
    if (!activeMessageId) return;
    const idx = messages.findIndex(m => m.id === activeMessageId);
    if (idx >= 0) {
      virtuosoRef.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'smooth' });
    }
  }, [activeMessageId, messages]);

  // Re-engage follow (auto-scroll) when streaming starts
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (isStreaming && !prevStreamingRef.current) {
      followOutputRef.current = true;
      virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, align: 'end' });
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, messages.length]);

  // Scroll to bottom when messages are bulk-replaced (recovery).
  // Detect recovery: firstItemIndex was reset (replace, not prepend) + not streaming.
  const prevFirstItemIndexRef = useRef(FIRST_ITEM_INDEX);
  useEffect(() => {
    const wasReset = firstItemIndexRef.current === FIRST_ITEM_INDEX && prevFirstItemIndexRef.current !== FIRST_ITEM_INDEX;
    if (wasReset && !isStreaming && messages.length > 0) {
      virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, align: 'end' });
    }
    prevFirstItemIndexRef.current = firstItemIndexRef.current;
  }, [messages, isStreaming]);

  const handleScrollToBottom = useCallback(() => {
    followOutputRef.current = true;
    // Scroll the actual DOM element — Virtuoso's API methods don't reach the Footer.
    if (scrollerRef.current) {
      scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
    }
  }, []);

  const handleScrollToTop = useCallback(() => {
    virtuosoRef.current?.scrollToIndex({ index: 0, align: 'start', behavior: 'smooth' });
  }, []);

  // Build context object for Virtuoso's stable Header/Footer components.
  // The context changes when data changes, but the component *identity* stays the same
  // (VirtuosoHeader/VirtuosoFooter are defined outside render), so React updates
  // props without unmounting — preserving ElapsedTimer state, etc.
  const virtuosoContext = useMemo<VirtuosoContextData>(() => ({
    hasMore, loadingMore, isStreaming, streamingContent,
    toolUses, toolResults, streamingToolOutput, statusText,
    pendingPermission, onPermissionResponse, permissionResolved,
    pendingInputRequest, onInputResponse, inputRequestResolved, onForceStop,
    viewMode,
  }), [hasMore, loadingMore, isStreaming, streamingContent,
    toolUses, toolResults, streamingToolOutput, statusText,
    pendingPermission, onPermissionResponse, permissionResolved,
    pendingInputRequest, onInputResponse, inputRequestResolved, onForceStop,
    viewMode]);

  // Auto-scroll when Footer content grows during streaming.
  // Virtuoso's followOutput/autoscrollToBottom only fire when DATA items change.
  // During streaming, content grows in the Footer (no new data items), so Virtuoso's
  // internal follow-output state is never engaged. We must scroll the underlying
  // DOM element directly — verified via browser testing that this works.
  useEffect(() => {
    if (isStreaming && followOutputRef.current && scrollerRef.current) {
      requestAnimationFrame(() => {
        if (scrollerRef.current) {
          scrollerRef.current.scrollTop = scrollerRef.current.scrollHeight;
        }
      });
    }
  }, [isStreaming, streamingContent, toolUses.length, toolResults.length, statusText]);

  // Detect user-initiated scroll-up during streaming so we stop forcing the
  // viewport down. `atBottomStateChange` can't be trusted here: the Footer
  // grows between scrolls and triggers spurious "left bottom" events. Wheel
  // and touch events only fire from real user gestures, so they reliably
  // distinguish intent. Re-engagement happens via atBottomStateChange when
  // the user scrolls back to the bottom, or via the Scroll-to-Bottom button.
  useEffect(() => {
    if (!scrollerEl) return;
    const disengage = () => {
      if (isStreamingRef.current && followOutputRef.current) {
        followOutputRef.current = false;
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY < 0) disengage();
    };
    let touchStartY = 0;
    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0]?.clientY ?? 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const currentY = e.touches[0]?.clientY ?? 0;
      // Threshold filters out taps and accidental jitter — only swipe-down
      // (which scrolls the content up) counts as scroll-up intent.
      if (currentY - touchStartY > 5) disengage();
    };
    scrollerEl.addEventListener('wheel', onWheel, { passive: true });
    scrollerEl.addEventListener('touchstart', onTouchStart, { passive: true });
    scrollerEl.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      scrollerEl.removeEventListener('wheel', onWheel);
      scrollerEl.removeEventListener('touchstart', onTouchStart);
      scrollerEl.removeEventListener('touchmove', onTouchMove);
    };
  }, [scrollerEl]);

  if (messages.length === 0 && !isStreaming) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <ConversationEmptyState
          title="Web Claude Code Pilot"
          description="Start a conversation with Claude. Ask questions, get help with code, or explore ideas."
          icon={<CodePilotLogo className="h-16 w-16" />}
        />
      </div>
    );
  }

  return (
    <Conversation>
      <Virtuoso
        ref={virtuosoRef}
        scrollerRef={(ref) => {
          scrollerRef.current = ref as HTMLElement;
          setScrollerEl(ref as HTMLElement);
        }}
        style={{ height: '100%' }}
        data={messages}
        context={virtuosoContext}
        firstItemIndex={firstItemIndexRef.current}
        initialTopMostItemIndex={messages.length - 1}
        followOutput={(isAtBottom) => {
          if (followOutputRef.current || isAtBottom) return 'smooth';
          return false;
        }}
        atBottomStateChange={(bottom) => {
          setAtBottom(bottom);
          // During streaming, Footer content grows between our scroll and the
          // next Virtuoso layout pass, making Virtuoso think we left the bottom.
          // So we ignore the "left bottom" signal here during streaming — real
          // user-initiated scroll-up is detected via wheel/touchmove listeners.
          // But "reached bottom" is always trustworthy: re-engage follow so the
          // viewport tracks new content again after the user scrolls back down.
          if (!isStreamingRef.current) {
            followOutputRef.current = bottom;
          } else if (bottom) {
            followOutputRef.current = true;
          }
        }}
        atTopStateChange={(top) => {
          setAtTop(top);
        }}
        atBottomThreshold={50}
        startReached={() => {
          if (hasMore && !loadingMore) {
            onLoadMore?.();
          }
        }}
        increaseViewportBy={200}
        itemContent={(index, message) => {
          const isLast = index === messages.length - 1;
          return (
            <div className="mx-auto max-w-3xl px-4 py-3">
              <div
                id={`msg-${message.id}`}
                className={
                  highlightMessageIds?.has(message.id)
                    ? activeMessageId === message.id
                      ? 'ring-2 ring-primary/60 rounded-lg transition-shadow duration-200'
                      : 'ring-1 ring-primary/30 rounded-lg transition-shadow duration-200'
                    : ''
                }
              >
                <MessageItem
                  message={message}
                  searchQuery={searchQuery}
                  isLatestMessage={isLast && !isStreaming}
                  viewMode={viewMode}
                  healthAlerts={messageHealthAlerts?.get(message.id)}
                  onDismissHealthAlert={onDismissHealthAlert}
                  onEditMessage={onEditMessage}
                  isStreaming={isStreaming}
                />
              </div>
            </div>
          );
        }}
        components={virtuosoComponents}
      />
      <ConversationScrollTopButton isAtTop={atTop} onScrollToTop={handleScrollToTop} />
      <ConversationScrollButton isAtBottom={atBottom} onScrollToBottom={handleScrollToBottom} />
    </Conversation>
  );
}
