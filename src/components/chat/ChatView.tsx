'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import type { Message, MessagesResponse, PermissionRequestEvent, InputRequestEvent, FileAttachment, ViewMode } from '@/types';
import { MessageList } from './MessageList';
import { BranchSummaryCard } from './BranchSummaryCard';
import { MessageInput } from './MessageInput';
import { SearchBar } from './SearchBar';
import { SearchIcon } from 'lucide-react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Bookmark02Icon, BrainIcon, Cancel01Icon, ViewIcon, ViewOffSlashIcon, DashboardSquare01Icon } from '@hugeicons/core-free-icons';
import { RememberDialog } from './RememberDialog';
import { usePanel } from '@/hooks/usePanel';
import { consumeSSEStream } from '@/hooks/useSSEStream';
import type { RateLimitInfo } from '@/hooks/useSSEStream';
import { formatCodexUsageMarkdown } from '@/lib/codex-usage';
import { formatClaudeUsageMarkdown } from '@/lib/claude-usage';
import type { ClaudeAccountInfo } from '@/lib/claude-usage';

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

/** Build message content string: plain text if no tools, structured JSON if tools exist */
function buildMessageContent(
  text: string,
  toolUses: ToolUseInfo[],
  toolResults: ToolResultInfo[],
  thinking?: string,
): string {
  if (toolUses.length === 0 && !thinking) return text;

  const blocks: Array<Record<string, unknown>> = [];
  // Thinking block first (matches backend save order)
  if (thinking) {
    blocks.push({ type: 'thinking', text: thinking });
  }
  if (text) {
    blocks.push({ type: 'text', text });
  } else {
    blocks.push({ type: 'text', text: '*(Task completed with tool activity but no text response)*' });
  }
  for (const tool of toolUses) {
    blocks.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.input });
    const toolResult = toolResults.find((r) => r.tool_use_id === tool.id);
    if (toolResult) {
      blocks.push({
        type: 'tool_result',
        tool_use_id: toolResult.tool_use_id,
        content: toolResult.content,
        is_error: toolResult.is_error || false,
      });
    }
  }
  return JSON.stringify(blocks);
}

const BRANCH_SUMMARY_PROMPT = `Summarize this conversation for context transfer to a new session. Structure your summary as:

## Task Overview
What is being worked on and why.

## Current State
What has been completed, what files were changed, key decisions made.

## Important Details
Technical specifics, file paths, code patterns, and constraints discovered.

## Open Items
What remains to be done, any blockers or concerns.

Keep the summary under 2000 words. Preserve technical terms, file paths, and code references exactly.`;

interface ChatViewProps {
  sessionId: string;
  initialMessages?: Message[];
  initialHasMore?: boolean;
  modelName?: string;
  initialMode?: string;
  backend?: 'claude' | 'codex';
  advisorModel?: string | null;
  branchSummary?: string | null;
  branchSourceSessionId?: string | null;
}

export function ChatView({ sessionId, initialMessages = [], initialHasMore = false, modelName, initialMode, backend = 'claude', advisorModel, branchSummary, branchSourceSessionId }: ChatViewProps) {
  const { setStreamingSessionId, workingDirectory, setWorkingDirectory, setPanelOpen, setPendingApprovalSessionId, sessionTitle } = usePanel();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [streamingThinking, setStreamingThinking] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  // Whether a graceful stop has been requested — drives UI to show "click again to force stop"
  const [stopRequested, setStopRequested] = useState(false);
  const [toolUses, setToolUses] = useState<ToolUseInfo[]>([]);
  const [toolResults, setToolResults] = useState<ToolResultInfo[]>([]);
  const [statusText, setStatusText] = useState<string | undefined>();
  const [mode, setMode] = useState(initialMode || 'code');
  const [currentBackend, setCurrentBackendRaw] = useState<'claude' | 'codex'>(backend || 'claude');
  const [currentModel, setCurrentModelRaw] = useState(modelName || '');
  const [currentEffort, setCurrentEffort] = useState<string | undefined>();
  const [currentAdvisorModel, setCurrentAdvisorModelRaw] = useState<string | null>(advisorModel || null);

  // Memory system state: null = use global default, true/false = session override
  const [memoryEnabled, setMemoryEnabledRaw] = useState<boolean | null>(null);
  const [memoryGlobalDefault, setMemoryGlobalDefault] = useState(false);
  const [sessionRememberOpen, setSessionRememberOpen] = useState(false);

  // View mode: verbose | normal | summary
  const [viewMode, setViewModeRaw] = useState<ViewMode>('normal');

  // Sync backend prop → state when parent loads session data after initial render
  useEffect(() => {
    if (backend) setCurrentBackendRaw(backend);
  }, [backend]);
  // Sync advisorModel prop → state
  useEffect(() => {
    if (advisorModel !== undefined) setCurrentAdvisorModelRaw(advisorModel || null);
  }, [advisorModel]);

  // Fetch memory state and view mode from session and global settings
  useEffect(() => {
    Promise.all([
      fetch(`/api/chat/sessions/${sessionId}`).then(r => r.ok ? r.json() : null),
      fetch('/api/settings/app').then(r => r.ok ? r.json() : null),
    ]).then(([sessionData, settingsData]) => {
      if (sessionData?.session) {
        const me = sessionData.session.memory_enabled;
        setMemoryEnabledRaw(me === null || me === undefined ? null : me === 1);
        // Restore persisted view mode
        const vm = sessionData.session.view_mode;
        if (vm === 'verbose' || vm === 'normal' || vm === 'summary') {
          setViewModeRaw(vm);
        }
      }
      if (settingsData?.settings) {
        setMemoryGlobalDefault(settingsData.settings.memory_enabled === 'true');
      }
    }).catch(() => { /* silent */ });
  }, [sessionId]);

  const setMemoryEnabled = useCallback((enabled: boolean | null) => {
    setMemoryEnabledRaw(enabled);
    if (sessionId) {
      fetch(`/api/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memory_enabled: enabled }),
      }).catch(() => { /* silent */ });
    }
  }, [sessionId]);

  const setViewMode = useCallback((mode: ViewMode) => {
    setViewModeRaw(mode);
    if (sessionId) {
      fetch(`/api/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ view_mode: mode }),
      }).catch(() => { /* silent */ });
    }
  }, [sessionId]);

  const cycleViewMode = useCallback(() => {
    const modes: ViewMode[] = ['normal', 'verbose', 'summary'];
    const nextIndex = (modes.indexOf(viewMode) + 1) % modes.length;
    setViewMode(modes[nextIndex]);
  }, [viewMode, setViewMode]);

  // Effective memory state: session override > global default
  const isMemoryActive = memoryEnabled !== null ? memoryEnabled : memoryGlobalDefault;
  const isMemoryToggleLocked = messages.length > 0;

  const [pendingPermission, setPendingPermission] = useState<PermissionRequestEvent | null>(null);
  const [permissionResolved, setPermissionResolved] = useState<'allow' | 'deny' | null>(null);
  const [pendingInputRequest, setPendingInputRequest] = useState<InputRequestEvent | null>(null);
  const [inputRequestResolved, setInputRequestResolved] = useState(false);
  const [streamingToolOutput, setStreamingToolOutput] = useState('');
  const toolTimeoutRef = useRef<{ toolName: string; elapsedSeconds: number } | null>(null);
  // Rate limit info from Claude SDK (captured during streaming), keyed by rateLimitType
  const rateLimitsRef = useRef<Map<string, RateLimitInfo>>(new Map());
  // Refs to track tool data for building optimistic message (React state may be stale in async context)
  const toolUsesRef = useRef<ToolUseInfo[]>([]);
  const toolResultsRef = useRef<ToolResultInfo[]>([]);

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [bookmarkFilterActive, setBookmarkFilterActive] = useState(false);
  const displayMessages = useMemo(
    () => bookmarkFilterActive ? messages.filter(m => m.bookmarked === 1) : messages,
    [bookmarkFilterActive, messages],
  );
  const [highlightMessageIds, setHighlightMessageIds] = useState<Set<string>>(new Set());
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');

  const handleSearchHighlightChange = useCallback(
    (matchIds: Set<string>, activeId: string | null, query: string) => {
      setHighlightMessageIds(matchIds);
      setActiveMessageId(activeId);
      setSearchQuery(query);
    },
    []
  );

  // Stream recovery: when SSE disconnects (mobile tab suspension), poll DB for the response
  const recoveryActiveRef = useRef(false);
  const recoveryTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Periodic heartbeat timeout check — detects dead SSE connections even without visibilitychange
  const heartbeatWatchdogRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const setCurrentModel = useCallback((newModel: string) => {
    setCurrentModelRaw(newModel);
    // Persist model to database
    if (sessionId) {
      fetch(`/api/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: newModel }),
      }).catch(() => { /* silent */ });
    }
  }, [sessionId]);

  const setCurrentBackend = useCallback((newBackend: 'claude' | 'codex') => {
    setCurrentBackendRaw(newBackend);
    if (sessionId) {
      fetch(`/api/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend: newBackend }),
      }).catch(() => { /* silent */ });
    }
  }, [sessionId]);

  const setCurrentAdvisorModel = useCallback((newAdvisorModel: string | null) => {
    setCurrentAdvisorModelRaw(newAdvisorModel);
    if (sessionId) {
      fetch(`/api/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ advisor_model: newAdvisorModel || '' }),
      }).catch(() => { /* silent */ });
    }
  }, [sessionId]);

  const handleModeChange = useCallback((newMode: string) => {
    setMode(newMode);
    // Persist mode to database and notify chat list
    if (sessionId) {
      fetch(`/api/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: newMode }),
      }).then(() => {
        window.dispatchEvent(new CustomEvent('session-updated'));
      }).catch(() => { /* silent */ });
    }
  }, [sessionId]);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Generation counter: incremented each time sendMessage starts.
  // Used to detect and discard stale recovery polls that would clobber
  // the new stream's state (see startRecovery/poll guard).
  const streamGenerationRef = useRef(0);

  // Ref to keep accumulated streaming content in sync regardless of React batching
  const accumulatedRef = useRef('');
  // Ref for accumulated thinking content (same purpose as accumulatedRef)
  const accumulatedThinkingRef = useRef('');
  // Ref for sendMessage to allow self-referencing in timeout auto-retry without circular deps
  const sendMessageRef = useRef<(content: string, files?: FileAttachment[], skillInfo?: { name: string; content: string }, codexSkills?: Array<{ name: string; path: string }>) => Promise<void>>(undefined);
  // Wake Lock sentinel — keeps the screen on during streaming to prevent socket death on screen-off
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // Independent AbortController for the SSE read loop only (not the backend Claude process).
  // Aborting this does NOT kill Claude — it just exits consumeSSEStream so recovery can start.
  const readerAbortControllerRef = useRef<AbortController | null>(null);
  // Flag: this abort was triggered by tab-resume recovery, not user stop — route to startRecovery()
  const recoveryAbortRef = useRef(false);
  // Timestamp of last SSE data received — used to detect hung reader on tab resume
  const lastSseDataRef = useRef<number>(0);
  // Track whether a graceful stop has been requested — second click escalates to force stop
  const stopRequestedRef = useRef(false);
  // Branch flow: when /branch is triggered, this ref is set to true.
  // After streaming completes, the accumulated text is used as the summary
  // for a new branched session.
  const pendingBranchRef = useRef(false);

  // Fetch messages from DB and check if the backend has finished
  const recoverMessages = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}/messages?limit=100`);
      if (!res.ok) return false;
      const data: MessagesResponse = await res.json();
      setMessages(data.messages);
      setHasMore(data.hasMore ?? false);
      const lastMsg = data.messages[data.messages.length - 1];
      // Done if the last message is a complete assistant message.
      if (lastMsg?.role === 'assistant' && lastMsg.status !== 'streaming') return true;
      // Also treat "last message is user" as done — this means the task was lost
      // (e.g. dev server restarted mid-response). Stop recovery immediately so the
      // user isn't stuck on "Reconnecting..." for 30 seconds; they can just resend.
      if (lastMsg?.role === 'user') return true;
      // Last message is a streaming assistant message — backend may not have
      // finished writing to DB yet. Keep retrying.
      return false;
    } catch {
      return false;
    }
  }, [sessionId]);

  const stopRecovery = useCallback(() => {
    if (recoveryTimerRef.current) {
      clearInterval(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    if (heartbeatWatchdogRef.current) {
      clearInterval(heartbeatWatchdogRef.current);
      heartbeatWatchdogRef.current = null;
    }
    recoveryActiveRef.current = false;
    stopRequestedRef.current = false;
    setStopRequested(false);
    // Perform the deferred cleanup that the finally block skipped
    setIsStreaming(false);
    setStreamingSessionId('');
    setStreamingContent('');
    setStreamingThinking('');
    accumulatedRef.current = '';
    accumulatedThinkingRef.current = '';
    setToolUses([]);
    setToolResults([]);
    toolUsesRef.current = [];
    toolResultsRef.current = [];
    setStreamingToolOutput('');
    setPendingPermission(null);
    setPermissionResolved(null);
    setPendingInputRequest(null);
    setInputRequestResolved(false);
    setPendingApprovalSessionId('');
    abortControllerRef.current = null;
    readerAbortControllerRef.current = null;
    lastSseDataRef.current = 0;
    recoveryAbortRef.current = false;
    setStatusText(undefined);
    window.dispatchEvent(new CustomEvent('refresh-file-tree'));
  }, [setStreamingSessionId, setPendingApprovalSessionId]);

  const startRecovery = useCallback(() => {
    // Prevent duplicate recovery
    if (recoveryActiveRef.current) return;
    recoveryActiveRef.current = true;
    setStatusText('Reconnecting...');

    let doneRetries = 0;
    // Capture the generation at the time recovery starts.
    // If sendMessage increments the generation (new stream started), this
    // poll becomes stale and must not touch UI state.
    const recoveryGeneration = streamGenerationRef.current;
    const isStale = () => !recoveryActiveRef.current || streamGenerationRef.current !== recoveryGeneration;

    const poll = async () => {
      // Guard: recovery was already stopped or a new stream started — bail out.
      if (isStale()) return;
      try {
        const res = await fetch(`/api/chat/sessions/${sessionId}/status`);
        // Re-check after async: a new sendMessage may have started while the fetch was in flight.
        if (isStale()) return;
        if (!res.ok) {
          setStatusText('Connection lost, retrying...');
          return;
        }
        const status: {
          isProcessing: boolean;
          pendingPermission: PermissionRequestEvent | null;
          pendingInputRequest: InputRequestEvent | null;
          streamingContent?: {
            text: string;
            toolUses: ToolUseInfo[];
            toolResults: ToolResultInfo[];
            statusText?: string;
          } | null;
        } = await res.json();

        if (isStale()) return;

        if (!status.isProcessing) {
          // Claude has finished — fetch final messages and stop recovery.
          // Only stop if messages were successfully recovered; otherwise keep
          // polling so we don't lose the UI state before messages are loaded.
          const done = await recoverMessages();
          if (isStale()) return;
          if (done) {
            stopRecovery();
          } else {
            // Message fetch failed or backend hasn't saved yet — retry.
            // Use 10 retries (30s total at 3s intervals) to handle slow saves.
            doneRetries++;
            if (doneRetries >= 10) {
              // Last resort: fetch one more time before giving up
              await recoverMessages();
              if (isStale()) return;
              stopRecovery();
            }
          }
          return;
        }

        doneRetries = 0; // reset when Claude is still processing
        if (status.pendingPermission) {
          // Restore the permission dialog so the user can respond
          setPendingPermission(status.pendingPermission);
          setPermissionResolved(null);
          setPendingApprovalSessionId(sessionId);
          setStatusText('Waiting for permission...');
          return;
        }

        if (status.pendingInputRequest) {
          // Restore the input request dialog so the user can respond
          setPendingInputRequest(status.pendingInputRequest);
          setInputRequestResolved(false);
          setStatusText('Waiting for input...');
          return;
        }

        // Still processing — show intermediate output from the streaming buffer
        if (status.streamingContent) {
          const sc = status.streamingContent;
          if (sc.text) {
            setStreamingContent(sc.text);
            accumulatedRef.current = sc.text;
          }
          if (sc.toolUses?.length) {
            setToolUses(sc.toolUses);
            toolUsesRef.current = sc.toolUses;
          }
          if (sc.toolResults?.length) {
            setToolResults(sc.toolResults);
            toolResultsRef.current = sc.toolResults;
          }
          const backendLabel = currentBackend === 'codex' ? 'Codex' : 'Claude';
          setStatusText(sc.statusText || `${backendLabel} is running...`);
        } else {
          const backendLabel = currentBackend === 'codex' ? 'Codex' : 'Claude';
          setStatusText(`Reconnecting... ${backendLabel} is still running`);
        }
      } catch {
        if (isStale()) return;
        setStatusText('Connection lost, retrying...');
      }
    };

    // Immediate first poll
    poll();
    recoveryTimerRef.current = setInterval(poll, 3000);
  }, [sessionId, recoverMessages, stopRecovery, setPendingApprovalSessionId]);

  // Re-sync streaming content when the window regains visibility (browser tab switch)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Re-sync streaming buffer so UI shows whatever we've accumulated so far
        if (accumulatedRef.current) {
          setStreamingContent(accumulatedRef.current);
        }
        // If recovery polling is already active, check status before fetching messages.
        // Only fetch messages if Claude is done — avoids replacing the messages array
        // mid-processing which can cause messages to briefly disappear.
        if (recoveryActiveRef.current) {
          const gen = streamGenerationRef.current;
          fetch(`/api/chat/sessions/${sessionId}/status`)
            .then(res => res.ok ? res.json() : null)
            .then(status => {
              // Bail if recovery was stopped or a new stream started while we fetched
              if (!recoveryActiveRef.current || streamGenerationRef.current !== gen) return;
              if (status && !status.isProcessing) {
                // Only stop recovery if messages were successfully recovered.
                // If the fetch fails (e.g. mobile network still waking up),
                // let the poll continue retrying.
                recoverMessages().then(done => {
                  if (!recoveryActiveRef.current || streamGenerationRef.current !== gen) return;
                  if (done) stopRecovery();
                });
              }
            })
            .catch(() => {});
          return;
        }
        // Detect hung SSE reader: if we're still streaming but haven't received
        // data for >2s, the socket died while in background (mobile OS behaviour).
        // Cancel only the front-end reader — the backend Claude process keeps
        // running independently (we decoupled it from request.signal).
        // The catch block will see an AbortError, check recoveryAbortRef, and
        // call startRecovery() to poll the DB for the completed response.
        if (readerAbortControllerRef.current && lastSseDataRef.current > 0) {
          const silentMs = Date.now() - lastSseDataRef.current;
          if (silentMs > 2000) {
            recoveryAbortRef.current = true;
            readerAbortControllerRef.current.abort();
          }
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    // iOS Safari sometimes fires focus without visibilitychange
    window.addEventListener('focus', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleVisibilityChange);
    };
  }, [recoverMessages, stopRecovery]);

  // On mount, check if Claude is still processing (e.g., after mobile browser killed
  // and reloaded the page while Claude was running). If so, start recovery polling
  // so we pick up the result when it finishes.
  useEffect(() => {
    // Only check if we're not already streaming (fresh mount, not mid-stream)
    if (isStreaming || recoveryActiveRef.current) return;
    let cancelled = false;
    fetch(`/api/chat/sessions/${sessionId}/status`)
      .then(res => res.ok ? res.json() : null)
      .then(status => {
        if (cancelled || !status) return;
        if (status.isProcessing) {
          // Claude is still running — enter recovery mode to poll for the result.
          // Set isStreaming so the UI shows the streaming indicator.
          setIsStreaming(true);
          startRecovery();
        } else if (status.pendingPermission) {
          setIsStreaming(true);
          setPendingPermission(status.pendingPermission);
          setPermissionResolved(null);
          setPendingApprovalSessionId(sessionId);
          setStatusText('Waiting for permission...');
        } else if (status.pendingInputRequest) {
          setIsStreaming(true);
          setPendingInputRequest(status.pendingInputRequest);
          setInputRequestResolved(false);
          setStatusText('Waiting for input...');
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount
  }, [sessionId]);

  // Cleanup recovery timer on unmount
  useEffect(() => {
    return () => {
      if (recoveryTimerRef.current) {
        clearInterval(recoveryTimerRef.current);
      }
    };
  }, []);

  // Handle push notification deep links
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const approveId = params.get('approve');
    const inputId = params.get('input');

    if (approveId || inputId) {
      // Clean URL without reload
      const url = new URL(window.location.href);
      url.searchParams.delete('approve');
      url.searchParams.delete('input');
      window.history.replaceState({}, '', url.toString());

      // Scroll to target after render
      setTimeout(() => {
        const targetId = approveId ? `approval-${approveId}` : `input-request-${inputId}`;
        const element = document.getElementById(targetId);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          element.classList.add('highlight-pulse');
          setTimeout(() => element.classList.remove('highlight-pulse'), 2000);
        }
      }, 500);
    }
  }, []);

  // Acquire a screen Wake Lock while streaming to prevent the screen from
  // turning off and triggering socket suspension on mobile devices.
  // This doesn't prevent app-switch suspension, but covers the screen-timeout case.
  useEffect(() => {
    if (isStreaming) {
      if ('wakeLock' in navigator) {
        navigator.wakeLock.request('screen')
          .then(lock => { wakeLockRef.current = lock; })
          .catch(() => { /* not supported or denied — ignore */ });
      }
    } else {
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    }
  }, [isStreaming]);

  // Foreground heartbeat timeout: if we're streaming and haven't received any
  // SSE data for 30s (3 missed heartbeats), the connection is dead — trigger recovery
  useEffect(() => {
    if (!isStreaming) return;
    const checkInterval = setInterval(() => {
      if (lastSseDataRef.current > 0 && Date.now() - lastSseDataRef.current > 30000) {
        // Connection is dead — abort the reader to trigger recovery
        if (readerAbortControllerRef.current) {
          recoveryAbortRef.current = true;
          readerAbortControllerRef.current.abort();
        }
      }
    }, 5000);
    return () => clearInterval(checkInterval);
  }, [isStreaming]);

  // Cmd/Ctrl+F to open search, Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === 'Escape' && searchOpen) {
        e.preventDefault();
        setSearchOpen(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [searchOpen]);

  // Reset bookmark filter on session change
  useEffect(() => {
    setBookmarkFilterActive(false);
  }, [sessionId]);

  const initializedRef = useRef(false);
  useEffect(() => {
    if (initialMessages.length > 0 && !initializedRef.current) {
      initializedRef.current = true;
      setMessages(initialMessages);
    }
  }, [initialMessages]);

  // Sync mode when session data loads
  useEffect(() => {
    if (initialMode) {
      setMode(initialMode);
    }
  }, [initialMode]);

  // Sync hasMore when initial data loads
  useEffect(() => {
    setHasMore(initialHasMore);
  }, [initialHasMore]);

  const loadEarlierMessages = useCallback(async () => {
    // Use ref as atomic lock to prevent double-fetch from rapid clicks
    if (loadingMoreRef.current || !hasMore || messages.length === 0) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      // Use _rowid of the earliest message as cursor
      const earliest = messages[0];
      const earliestRowId = (earliest as Message & { _rowid?: number })._rowid;
      if (!earliestRowId) return;
      const res = await fetch(`/api/chat/sessions/${sessionId}/messages?limit=100&before=${earliestRowId}`);
      if (!res.ok) return;
      const data: MessagesResponse = await res.json();
      setHasMore(data.hasMore ?? false);
      if (data.messages.length > 0) {
        setMessages(prev => [...data.messages, ...prev]);
      }
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [sessionId, messages, hasMore]);

  const stopStreaming = useCallback((force = false) => {
    // If recovery polling is active, stop it and reset UI immediately.
    // This lets the user cancel "Reconnecting..." by clicking the stop button.
    if (recoveryActiveRef.current) {
      // Tell the server to abort first (best-effort), then clean up client state
      fetch('/api/chat/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, force: true }),
      }).catch(() => { /* best-effort */ });
      // Recover any messages that may have been saved before stopping
      recoverMessages().finally(() => {
        stopRecovery();
      });
      stopRequestedRef.current = false;
      setStopRequested(false);
      return;
    }

    // Escalation logic: if a graceful stop was already requested and we're
    // called again (second click on Stop button), escalate to force stop.
    if (!force && stopRequestedRef.current) {
      force = true;
    }

    if (force) {
      // Force stop: abort client reader immediately + hard kill server process
      abortControllerRef.current?.abort();
      abortControllerRef.current = null;
      fetch('/api/chat/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, force: true }),
      }).catch(() => { /* best-effort */ });
      stopRequestedRef.current = false;
      setStopRequested(false);
    } else {
      // Graceful stop: interrupt server (let current tool finish), then abort client reader
      fetch('/api/chat/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
      }).catch(() => { /* best-effort */ });
      // Don't abort client reader immediately — let streaming end naturally after interrupt
      stopRequestedRef.current = true;
      setStopRequested(true);
    }
  }, [sessionId, recoverMessages, stopRecovery]);

  const handlePermissionResponse = useCallback(async (decision: 'allow' | 'allow_session' | 'deny') => {
    if (!pendingPermission) return;

    const body: { permissionRequestId: string; decision: { behavior: 'allow'; updatedPermissions?: unknown[] } | { behavior: 'deny'; message?: string } } = {
      permissionRequestId: pendingPermission.permissionRequestId,
      decision: decision === 'deny'
        ? { behavior: 'deny', message: 'User denied permission' }
        : {
            behavior: 'allow',
            ...(decision === 'allow_session' && pendingPermission.suggestions
              ? { updatedPermissions: pendingPermission.suggestions }
              : {}),
          },
    };

    setPermissionResolved(decision === 'deny' ? 'deny' : 'allow');
    setPendingApprovalSessionId('');

    try {
      const permEndpoint = currentBackend === 'codex' ? '/api/codex/permission' : '/api/chat/permission';
      await fetch(permEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch {
      // Best effort - the stream will handle timeout
    }

    // Clear permission state after a short delay so user sees the feedback
    setTimeout(() => {
      setPendingPermission(null);
      setPermissionResolved(null);
    }, 1000);
  }, [pendingPermission, setPendingApprovalSessionId, currentBackend]);

  const handleInputResponse = useCallback(async (answers: Record<string, string>) => {
    if (!pendingInputRequest) return;

    const submittedId = pendingInputRequest.inputRequestId;
    setInputRequestResolved(true);

    try {
      await fetch('/api/chat/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputRequestId: submittedId,
          answers,
        }),
      });
    } catch {
      // Best effort - the stream will handle timeout
    }

    // Clear input request state after a short delay so user sees the feedback.
    // Guard: only clear if the same request is still pending — during recovery,
    // the poll may have already set a NEWER input request (next question) and
    // we must not clobber it.
    setTimeout(() => {
      setPendingInputRequest(prev => {
        if (prev && prev.inputRequestId !== submittedId) {
          return prev; // A newer input request arrived — don't clear it
        }
        return null;
      });
      setInputRequestResolved(false);
      if (recoveryActiveRef.current) {
        setStatusText('Reconnecting...');
      }
    }, 1000);
  }, [pendingInputRequest]);

  const sendMessage = useCallback(
    async (content: string, files?: FileAttachment[], skillInfo?: { name: string; content: string }, codexSkills?: Array<{ name: string; path: string }>) => {
      if (isStreaming) return;

      // Bump generation: any in-flight recovery polls from the previous stream
      // will see a generation mismatch and bail out, preventing them from
      // clobbering this new stream's messages/state.
      streamGenerationRef.current++;

      // Cancel any ongoing recovery from a previous disconnection
      if (recoveryActiveRef.current) {
        stopRecovery();
      }

      // When a skill is active, inject its content into the API message as a
      // <command-name> block — this matches how Claude Code CLI loads skills
      // via the Skill tool.  The display message stays clean (just user text).
      let apiContent = content;
      if (skillInfo) {
        apiContent = `<command-name>${skillInfo.name}</command-name>\n\n${skillInfo.content}\n\nUser request: ${content}`;
      }

      // Detect /branch command and transform into summary request
      let branchMode = false;
      let branchModelOverride: string | null = null;
      if (content.startsWith('/branch')) {
        branchMode = true;
        pendingBranchRef.current = true;
        // Parse optional model parameter from "User context: haiku" appended by MessageInput
        const userContext = content.match(/User context:\s*([\s\S]+)/)?.[1]?.trim().toLowerCase();
        if (userContext === 'haiku') {
          branchModelOverride = 'claude-haiku-4-5';
        } else if (userContext === 'sonnet' || !userContext) {
          branchModelOverride = 'claude-sonnet-4-5';
        } else {
          // User typed a full model name or something else — use as-is
          branchModelOverride = userContext;
        }
        // API gets the actual summary prompt; display stays clean
        apiContent = BRANCH_SUMMARY_PROMPT;
        // Clean up display content for the user message
        content = branchModelOverride === 'claude-haiku-4-5' ? '/branch haiku' : '/branch';
      }

      // Build display content: embed file metadata as HTML comment for MessageItem to parse
      let displayContent = content;
      if (files && files.length > 0) {
        const fileMeta = files.map(f => ({ id: f.id, name: f.name, type: f.type, size: f.size, data: f.data }));
        displayContent = `<!--files:${JSON.stringify(fileMeta)}-->${content}`;
      }

      // Optimistic: add user message to UI immediately
      const userMessage: Message = {
        id: 'temp-' + Date.now(),
        session_id: sessionId,
        role: 'user',
        content: displayContent,
        created_at: new Date().toISOString(),
        token_usage: null,
      };
      setMessages((prev) => [...prev, userMessage]);
      setIsStreaming(true);
      setStreamingSessionId(sessionId);
      setStreamingContent('');
      setStreamingThinking('');
      accumulatedRef.current = '';
      setToolUses([]);
      setToolResults([]);
      toolUsesRef.current = [];
      toolResultsRef.current = [];
      setStatusText(undefined);

      // Capture the generation for this stream.  The finally block checks this
      // to avoid resetting state if a NEWER sendMessage call has already started.
      const myGeneration = streamGenerationRef.current;

      const controller = new AbortController();
      abortControllerRef.current = controller;

      let accumulated = '';
      let toolCount = 0;

      try {
        const chatEndpoint = currentBackend === 'codex' ? '/api/codex/chat' : '/api/chat';
        const response = await fetch(chatEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            content,
            ...(apiContent !== content ? { prompt: apiContent } : {}),
            mode,
            model: branchMode ? branchModelOverride : currentModel,
            ...(files && files.length > 0 ? { files } : {}),
            ...(currentEffort ? { effort: currentEffort } : {}),
            ...(codexSkills && codexSkills.length > 0 ? { codexSkills } : {}),
            ...(branchMode ? { disable_tools: true, max_turns: 1 } : {}),
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || 'Failed to send message');
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response stream');

        // Create an independent abort controller for the read loop.
        // Aborting this exits consumeSSEStream without touching the backend process.
        const readerAbort = new AbortController();
        readerAbortControllerRef.current = readerAbort;
        lastSseDataRef.current = Date.now();

        // Start heartbeat watchdog: if no SSE data arrives for 30s (3 missed
        // 10s heartbeats), the connection is dead — abort reader → recovery.
        if (heartbeatWatchdogRef.current) clearInterval(heartbeatWatchdogRef.current);
        heartbeatWatchdogRef.current = setInterval(() => {
          if (lastSseDataRef.current > 0 && Date.now() - lastSseDataRef.current > 30_000) {
            // Connection silently died — trigger recovery
            if (heartbeatWatchdogRef.current) {
              clearInterval(heartbeatWatchdogRef.current);
              heartbeatWatchdogRef.current = null;
            }
            recoveryAbortRef.current = true;
            readerAbortControllerRef.current?.abort();
          }
        }, 5_000);

        const result = await consumeSSEStream(reader, {
          onText: (acc) => {
            lastSseDataRef.current = Date.now();
            accumulated = acc;
            accumulatedRef.current = acc;
            setStreamingContent(acc);
          },
          onThinking: (delta) => {
            lastSseDataRef.current = Date.now();
            accumulatedThinkingRef.current += delta;
            setStreamingThinking((prev) => prev + delta);
          },
          onToolUse: (tool) => {
            toolCount++;
            setStreamingToolOutput('');
            setToolUses((prev) => {
              if (prev.some((t) => t.id === tool.id)) return prev;
              const next = [...prev, tool];
              toolUsesRef.current = next;
              return next;
            });
          },
          onToolResult: (res) => {
            lastSseDataRef.current = Date.now();
            setStreamingToolOutput('');
            setToolResults((prev) => {
              // Deduplicate: tool results can arrive from both PostToolUse hook and user message blocks
              if (prev.some((r) => r.tool_use_id === res.tool_use_id)) return prev;
              const next = [...prev, res];
              toolResultsRef.current = next;
              return next;
            });
          },
          onToolOutput: (data) => {
            lastSseDataRef.current = Date.now();
            setStreamingToolOutput((prev) => {
              const next = prev + (prev ? '\n' : '') + data;
              return next.length > 5000 ? next.slice(-5000) : next;
            });
          },
          onToolProgress: (toolName, elapsed) => {
            lastSseDataRef.current = Date.now();
            setStatusText(`Running ${toolName}... (${elapsed}s)`);
          },
          onStatus: (text) => {
            if (text?.startsWith('Connected (')) {
              setStatusText(text);
              setTimeout(() => setStatusText(undefined), 2000);
            } else {
              setStatusText(text);
            }
          },
          onResult: () => {
            // Push notifications are now server-initiated (see push-notifications.ts)
          },
          onPermissionRequest: (permData) => {
            setPendingPermission(permData);
            setPermissionResolved(null);
            setPendingApprovalSessionId(sessionId);
          },
          onInputRequest: (inputData) => {
            setPendingInputRequest(inputData);
            setInputRequestResolved(false);
          },
          onToolTimeout: (toolName, elapsedSeconds) => {
            toolTimeoutRef.current = { toolName, elapsedSeconds };
          },
          onRateLimit: (info) => {
            const key = info.rateLimitType || 'default';
            rateLimitsRef.current.set(key, info);
          },
          onHeartbeat: () => {
            lastSseDataRef.current = Date.now();
          },
          onError: (acc) => {
            accumulated = acc;
            accumulatedRef.current = acc;
            setStreamingContent(acc);
          },
        }, readerAbort.signal);

        accumulated = result.accumulated;

        // Build optimistic assistant message with tool blocks (matching DB JSON format)
        // so that MessageItem.parseToolBlocks() can render tools after streaming ends
        const finalText = accumulated.trim();
        const finalContent = buildMessageContent(finalText, toolUsesRef.current, toolResultsRef.current, accumulatedThinkingRef.current.trim() || undefined)
          || (toolCount > 0 ? '*(Task completed with tool activity but no text response)*' : '');
        if (finalContent) {
          const assistantMessage: Message = {
            id: 'temp-assistant-' + Date.now(),
            session_id: sessionId,
            role: 'assistant',
            content: finalContent,
            created_at: new Date().toISOString(),
            token_usage: result.tokenUsage ? JSON.stringify(result.tokenUsage) : null,
          };
          setMessages((prev) => [...prev, assistantMessage]);

          // Branch flow: if this response was triggered by /branch, use the
          // accumulated text as the summary and create a new session.
          if (pendingBranchRef.current) {
            pendingBranchRef.current = false;
            const summary = accumulated.trim();
            if (summary) {
              try {
                const branchRes = await fetch('/api/chat/sessions', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    title: `${sessionTitle || 'Chat'} (cont.)`,
                    working_directory: workingDirectory,
                    model: currentModel,
                    mode,
                    backend: currentBackend,
                    branch_summary: summary,
                    branch_source_session_id: sessionId,
                  }),
                });
                if (branchRes.ok) {
                  const { session: newSession } = await branchRes.json();
                  window.dispatchEvent(new CustomEvent('session-created'));
                  window.location.href = `/chat/${newSession.id}`;
                  return; // Skip normal finally cleanup — page is navigating away
                }
              } catch (branchErr) {
                console.error('[ChatView] Branch session creation failed:', branchErr);
                // Fall through to normal completion — user still has the summary in chat
              }
            }
          }
        }
      } catch (error) {
        pendingBranchRef.current = false; // Clear branch state on any error
        if (error instanceof DOMException && error.name === 'AbortError') {
          // Tab-resume recovery: we cancelled the reader to unblock the hung read().
          // The backend Claude process is still running — poll DB for the result.
          if (recoveryAbortRef.current) {
            recoveryAbortRef.current = false;
            startRecovery();
            return;
          }
          const timeoutInfo = toolTimeoutRef.current;
          if (timeoutInfo) {
            // Tool execution timed out — save partial content and auto-retry
            if (accumulated.trim() || toolUsesRef.current.length > 0) {
              const partialText = (accumulated.trim() || '') + `\n\n*(tool ${timeoutInfo.toolName} timed out after ${timeoutInfo.elapsedSeconds}s)*`;
              const partialMessage: Message = {
                id: 'temp-assistant-' + Date.now(),
                session_id: sessionId,
                role: 'assistant',
                content: buildMessageContent(partialText.trim(), toolUsesRef.current, toolResultsRef.current) || partialText.trim(),
                created_at: new Date().toISOString(),
                token_usage: null,
              };
              setMessages((prev) => [...prev, partialMessage]);
            }
            // Clean up before auto-retry
            toolTimeoutRef.current = null;
            stopRequestedRef.current = false;
            setStopRequested(false);
            setIsStreaming(false);
            setStreamingSessionId('');
            setStreamingContent('');
            setStreamingThinking('');
            accumulatedRef.current = '';
            setToolUses([]);
            setToolResults([]);
            setStreamingToolOutput('');
            setStatusText(undefined);
            setPendingPermission(null);
            setPermissionResolved(null);
            setPendingApprovalSessionId('');
            abortControllerRef.current = null;
            // Auto-retry: send a follow-up message telling the model to adjust strategy
            setTimeout(() => {
              sendMessageRef.current?.(
                `The previous tool "${timeoutInfo.toolName}" timed out after ${timeoutInfo.elapsedSeconds} seconds. Please try a different approach to accomplish the task. Avoid repeating the same operation that got stuck.`
              );
            }, 500);
            return; // Skip the normal finally cleanup since we did it above
          }
          // User manually stopped generation — add partial content
          if (accumulated.trim() || toolUsesRef.current.length > 0) {
            const partialText = (accumulated.trim() || '') + '\n\n*(generation stopped)*';
            const partialMessage: Message = {
              id: 'temp-assistant-' + Date.now(),
              session_id: sessionId,
              role: 'assistant',
              content: buildMessageContent(partialText.trim(), toolUsesRef.current, toolResultsRef.current) || partialText.trim(),
              created_at: new Date().toISOString(),
              token_usage: null,
            };
            setMessages((prev) => [...prev, partialMessage]);
          }
        } else {
          // Network error (likely mobile tab suspension or connection drop).
          // Don't show error — start recovery polling to fetch the response from DB.
          startRecovery();
        }
      } finally {
        pendingBranchRef.current = false; // Safety reset
        // Always stop the heartbeat watchdog — recovery has its own polling
        if (heartbeatWatchdogRef.current) {
          clearInterval(heartbeatWatchdogRef.current);
          heartbeatWatchdogRef.current = null;
        }
        toolTimeoutRef.current = null;

        // Stale-stream guard: if a newer sendMessage has started (bumped the
        // generation counter), this finally block belongs to an old stream and
        // must NOT reset state — doing so would clobber the new stream's
        // isStreaming, streamingContent, abortController, etc.
        if (streamGenerationRef.current !== myGeneration) {
          // Only clean up refs that are exclusive to this invocation.
          // Do NOT touch shared state or refs the new stream may have set.
          recoveryAbortRef.current = false;
        } else if (recoveryActiveRef.current) {
          // Recovery is active — only clean up internal refs, keep UI state visible
          // so the user sees "Reconnecting..." and any pending permission dialog.
          // stopRecovery() will perform the full state cleanup later.
          abortControllerRef.current = null;
          readerAbortControllerRef.current = null;
          recoveryAbortRef.current = false;
        } else {
          stopRequestedRef.current = false;
          setStopRequested(false);
          setIsStreaming(false);
          setStreamingSessionId('');
          setStreamingContent('');
          setStreamingThinking('');
          accumulatedRef.current = '';
          setToolUses([]);
          setToolResults([]);
          toolUsesRef.current = [];
          toolResultsRef.current = [];
          setStreamingToolOutput('');
          setPendingPermission(null);
          setPermissionResolved(null);
          setPendingInputRequest(null);
          setInputRequestResolved(false);
          setPendingApprovalSessionId('');
          abortControllerRef.current = null;
          readerAbortControllerRef.current = null;
          lastSseDataRef.current = 0;
          recoveryAbortRef.current = false;
          setStatusText(undefined);
          window.dispatchEvent(new CustomEvent('refresh-file-tree'));
          window.dispatchEvent(new CustomEvent('session-updated'));
        }
      }
    },
    [sessionId, isStreaming, setStreamingSessionId, setPendingApprovalSessionId, mode, currentModel, stopRecovery, startRecovery, currentBackend, currentEffort]
  );

  // Keep sendMessageRef in sync so timeout auto-retry can call it
  sendMessageRef.current = sendMessage;

  const handleCommand = useCallback(async (command: string) => {
    switch (command) {
      case '/help': {
        const helpMessage: Message = {
          id: 'cmd-' + Date.now(),
          session_id: sessionId,
          role: 'assistant',
          content: `## Available Commands\n\n### Instant Commands\n- **/help** — Show this help message\n- **/clear** — Clear conversation history\n- **/cost** — Show token usage statistics for this session\n- **/usage** — Show account info and usage\n\n### Prompt Commands (shown as badge, add context then send)\n- **/compact** — Compress conversation context\n- **/doctor** — Diagnose project health\n- **/init** — Initialize CLAUDE.md for project\n- **/review** — Review code quality\n- **/terminal-setup** — Configure terminal settings\n- **/memory** — Edit project memory file\n\n### Custom Skills\nSkills from \`~/.claude/commands/\` and project \`.claude/commands/\` are also available via \`/\`.\n\n**Tips:**\n- Type \`/\` to browse commands and skills\n- Type \`@\` to mention files\n- Use Shift+Enter for new line\n- Select a project folder to enable file operations`,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, helpMessage]);
        break;
      }
      case '/clear':
        setMessages([]);
        // Also clear database messages and reset SDK session
        if (sessionId) {
          fetch(`/api/chat/sessions/${sessionId}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clear_messages: true }),
          }).catch(() => { /* silent */ });
        }
        break;
      case '/cost': {
        // Aggregate token usage from all messages in this session
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheCreation = 0;
        let totalCost = 0;
        let turnCount = 0;

        for (const msg of messages) {
          if (msg.token_usage) {
            try {
              const usage = typeof msg.token_usage === 'string' ? JSON.parse(msg.token_usage) : msg.token_usage;
              totalInput += usage.input_tokens || 0;
              totalOutput += usage.output_tokens || 0;
              totalCacheRead += usage.cache_read_input_tokens || 0;
              totalCacheCreation += usage.cache_creation_input_tokens || 0;
              if (usage.cost_usd) totalCost += usage.cost_usd;
              turnCount++;
            } catch { /* skip */ }
          }
        }

        const totalTokens = totalInput + totalOutput;
        let content: string;

        if (turnCount === 0) {
          content = `## Token Usage\n\nNo token usage data yet. Send a message first.`;
        } else {
          content = `## Token Usage\n\n| Metric | Count |\n|--------|-------|\n| Input tokens | ${totalInput.toLocaleString()} |\n| Output tokens | ${totalOutput.toLocaleString()} |\n| Cache read | ${totalCacheRead.toLocaleString()} |\n| Cache creation | ${totalCacheCreation.toLocaleString()} |\n| **Total tokens** | **${totalTokens.toLocaleString()}** |\n| Turns | ${turnCount} |${totalCost > 0 ? `\n| **Estimated cost** | **$${totalCost.toFixed(4)}** |` : ''}`;
        }

        const costMessage: Message = {
          id: 'cmd-' + Date.now(),
          session_id: sessionId,
          role: 'assistant',
          content,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, costMessage]);
        break;
      }
      case '/usage': {
        let content: string;

        if (currentBackend === 'codex') {
          content = '## Account Usage\n\nLoading Codex usage data...';
          try {
            const response = await fetch('/api/codex/usage');
            const data = await response.json();
            if (!response.ok) {
              content = `## Account Usage\n\nFailed to load Codex usage data.\n\n${data.error || 'Unknown error'}`;
            } else {
              content = formatCodexUsageMarkdown(data);
            }
          } catch (error) {
            content = `## Account Usage\n\nFailed to load Codex usage data.\n\n${error instanceof Error ? error.message : 'Unknown error'}`;
          }
        } else {
          // Claude backend: fetch account info + server-cached rate limits
          let account: ClaudeAccountInfo | null = null;
          let serverRateLimits: RateLimitInfo[] = [];
          try {
            const response = await fetch('/api/claude-usage');
            if (response.ok) {
              const data = await response.json();
              account = data.account || null;
              serverRateLimits = Array.isArray(data.rateLimits) ? data.rateLimits : [];
            }
          } catch { /* proceed without account info */ }

          // Merge: prefer fresh frontend-cached rate limits, fill gaps from server
          const merged = new Map<string, RateLimitInfo>();
          for (const rl of serverRateLimits) {
            merged.set(rl.rateLimitType || 'default', rl);
          }
          // Frontend cache (from current session streaming) overrides server cache
          for (const [key, rl] of rateLimitsRef.current.entries()) {
            merged.set(key, rl);
          }
          const allRateLimits = Array.from(merged.values());

          content = formatClaudeUsageMarkdown(account, allRateLimits);
        }

        const usageMessage: Message = {
          id: 'cmd-' + Date.now(),
          session_id: sessionId,
          role: 'assistant',
          content,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, usageMessage]);
        break;
      }
      default:
        // This shouldn't be reached since non-immediate commands are handled via badge
        sendMessage(command);
    }
  }, [sessionId, sendMessage, messages, currentBackend]);

  return (
    <div className="flex h-full min-h-0 flex-col relative">
      {searchOpen ? (
        <SearchBar
          messages={messages}
          isOpen={searchOpen}
          onClose={() => setSearchOpen(false)}
          onHighlightChange={handleSearchHighlightChange}
        />
      ) : messages.length > 0 && (
        <div className="absolute top-2 right-2 z-10 flex flex-col items-center gap-1">
          {/* View mode toggle */}
          <button
            type="button"
            onClick={cycleViewMode}
            className={`p-1.5 rounded-md backdrop-blur-sm border transition-colors ${
              viewMode !== 'normal'
                ? viewMode === 'verbose'
                  ? 'bg-blue-500/20 border-blue-500/50 text-blue-500'
                  : 'bg-purple-500/20 border-purple-500/50 text-purple-500'
                : 'bg-background/80 border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={`View: ${viewMode} (tap to cycle)`}
          >
            <HugeiconsIcon
              icon={viewMode === 'verbose' ? ViewIcon : viewMode === 'summary' ? DashboardSquare01Icon : ViewOffSlashIcon}
              size={14}
            />
          </button>
          <button
            type="button"
            onClick={() => setBookmarkFilterActive(!bookmarkFilterActive)}
            className={`p-1.5 rounded-md backdrop-blur-sm border transition-colors ${
              bookmarkFilterActive
                ? 'bg-amber-500/20 border-amber-500/50 text-amber-500'
                : 'bg-background/80 border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted'
            }`}
            title={bookmarkFilterActive ? 'Show all messages' : 'Show bookmarked only'}
          >
            <HugeiconsIcon icon={Bookmark02Icon} size={14} fill={bookmarkFilterActive ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            onClick={() => setSearchOpen(true)}
            className="p-1.5 rounded-md bg-background/80 backdrop-blur-sm border border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            title="Search messages (Cmd+F)"
          >
            <SearchIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      {bookmarkFilterActive && displayMessages.length === 0 && (
        <div className="flex items-center justify-center h-32 text-sm text-muted-foreground">
          No bookmarked messages in this session.
        </div>
      )}
      {branchSummary && (
        <BranchSummaryCard
          summary={branchSummary}
          sourceSessionId={branchSourceSessionId}
        />
      )}
      <MessageList
        key={bookmarkFilterActive ? 'bookmarks' : 'all'}
        messages={displayMessages}
        streamingContent={streamingContent}
        thinkingContent={streamingThinking}
        isStreaming={isStreaming}
        toolUses={toolUses}
        toolResults={toolResults}
        streamingToolOutput={streamingToolOutput}
        statusText={statusText}
        pendingPermission={pendingPermission}
        onPermissionResponse={handlePermissionResponse}
        permissionResolved={permissionResolved}
        pendingInputRequest={pendingInputRequest}
        onInputResponse={handleInputResponse}
        inputRequestResolved={inputRequestResolved}
        onForceStop={() => stopStreaming(true)}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={loadEarlierMessages}
        highlightMessageIds={highlightMessageIds}
        activeMessageId={activeMessageId}
        searchQuery={searchQuery}
        viewMode={viewMode}
      />
      {/* Advisor Mode Bar — Claude backend only */}
      {currentBackend === 'claude' && (() => {
        const hasMessages = messages.length > 0;
        const isEditable = !hasMessages; // Only allow changes before first message
        const advisorConflict = !!currentAdvisorModel && currentModel.toLowerCase().includes(currentAdvisorModel.toLowerCase());

        // Has messages + no advisor → hide entirely
        if (hasMessages && !currentAdvisorModel) return null;

        return (
          <div className="mx-auto w-full max-w-3xl px-4 pt-1.5 pb-0.5">
            {currentAdvisorModel ? (
              <div className="flex items-center gap-2 rounded-lg bg-amber-500/10 border border-amber-500/20 px-3 py-2">
                <HugeiconsIcon icon={BrainIcon} className="h-4 w-4 text-amber-500 shrink-0" />
                <span className="text-xs font-medium text-amber-600 dark:text-amber-400 shrink-0">Advisor</span>
                {isEditable ? (
                  <select
                    value={currentAdvisorModel}
                    onChange={(e) => setCurrentAdvisorModel(e.target.value)}
                    className="text-xs font-mono bg-transparent text-amber-500 border border-amber-500/30 rounded px-1.5 py-0.5 cursor-pointer focus:outline-none focus:ring-1 focus:ring-amber-500/50 capitalize"
                  >
                    <option value="opus">Opus</option>
                    <option value="sonnet">Sonnet</option>
                  </select>
                ) : (
                  <span className="text-xs text-amber-500 font-mono shrink-0 capitalize">{currentAdvisorModel}</span>
                )}
                {advisorConflict && (
                  <span className="text-[10px] text-amber-600/80 dark:text-amber-400/80 truncate hidden sm:inline">
                    · Same as main model — consider a new session without Advisor
                  </span>
                )}
                {isEditable && (
                  <button
                    type="button"
                    onClick={() => setCurrentAdvisorModel(null)}
                    className="ml-auto p-1 rounded-md hover:bg-amber-500/20 text-amber-500 transition-colors"
                  >
                    <HugeiconsIcon icon={Cancel01Icon} className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ) : (
              /* OFF state — only visible when no messages (isEditable is guaranteed true here) */
              <button
                type="button"
                onClick={() => setCurrentAdvisorModel('opus')}
                className="flex items-center gap-2 w-full rounded-lg border border-dashed border-border/50 px-3 py-2 text-muted-foreground hover:border-amber-500/40 hover:text-amber-600 dark:hover:text-amber-400 transition-colors group"
              >
                <HugeiconsIcon icon={BrainIcon} className="h-4 w-4 shrink-0 group-hover:text-amber-500 transition-colors" />
                <span className="text-xs">Advisor Mode</span>
                <span className="text-[10px] text-muted-foreground/50 ml-auto hidden sm:inline">
                  Stronger model reviews work
                </span>
              </button>
            )}
          </div>
        );
      })()}
      {/* Memory bar — always visible */}
      <div className="mx-auto w-full max-w-3xl px-4 pt-1 pb-0.5">
        <div className={`flex items-center gap-2 rounded-lg px-3 py-2 ${
          isMemoryActive
            ? 'bg-blue-500/10 border border-blue-500/20'
            : 'border border-dashed border-border/50'
        }`}>
          {/* Toggle: only editable before the session starts; memory is injected once */}
          <button
            type="button"
            onClick={() => {
              if (!isMemoryToggleLocked) {
                setMemoryEnabled(isMemoryActive ? false : true);
              }
            }}
            disabled={isMemoryToggleLocked}
            className={`flex items-center gap-1.5 shrink-0 transition-colors ${
              isMemoryActive
                ? 'text-blue-600 dark:text-blue-400'
                : 'text-muted-foreground'
            } ${isMemoryToggleLocked ? 'opacity-60 cursor-not-allowed' : ''}`}
          >
            <HugeiconsIcon icon={BrainIcon} className="h-4 w-4" />
            <span className="text-xs font-medium">Memory</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
              isMemoryActive
                ? 'bg-blue-500/20 text-blue-600 dark:text-blue-400'
                : 'bg-muted text-muted-foreground'
            }`}>
              {isMemoryActive ? 'ON' : 'OFF'}
            </span>
          </button>

          {isMemoryToggleLocked && (
            <span className="text-[10px] text-muted-foreground hidden sm:inline">
              Locked after the first message
            </span>
          )}

          {/* Summarize Session — always available when there are messages */}
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => setSessionRememberOpen(true)}
              className="ml-auto text-xs font-medium px-2.5 py-1 rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-500/20 active:bg-blue-500/30 transition-colors"
            >
              Summarize
            </button>
          )}
        </div>
      </div>
      {/* Session-level Remember dialog */}
      {sessionRememberOpen && (
        <RememberDialog
          open={sessionRememberOpen}
          onClose={() => setSessionRememberOpen(false)}
          defaultContent=""
          sourceSessionId={sessionId}
          workingDirectory={workingDirectory}
          sessionMode
        />
      )}
      <MessageInput
        onSend={sendMessage}
        onCommand={handleCommand}
        onStop={() => stopStreaming(false)}
        stopRequested={stopRequested}
        disabled={false}
        isStreaming={isStreaming}
        sessionId={sessionId}
        modelName={currentModel}
        onModelChange={setCurrentModel}
        workingDirectory={workingDirectory}
        mode={mode}
        onModeChange={handleModeChange}
        backend={currentBackend}
        onBackendChange={setCurrentBackend}
        effort={currentEffort}
        onEffortChange={setCurrentEffort}
      />
    </div>
  );
}
