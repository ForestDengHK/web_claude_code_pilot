'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import type { Message, MessagesResponse, PermissionRequestEvent, FileAttachment } from '@/types';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { SearchBar } from './SearchBar';
import { SearchIcon } from 'lucide-react';
import { usePanel } from '@/hooks/usePanel';
import { consumeSSEStream } from '@/hooks/useSSEStream';

interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultInfo {
  tool_use_id: string;
  content: string;
}

interface ChatViewProps {
  sessionId: string;
  initialMessages?: Message[];
  initialHasMore?: boolean;
  modelName?: string;
  initialMode?: string;
}

export function ChatView({ sessionId, initialMessages = [], initialHasMore = false, modelName, initialMode }: ChatViewProps) {
  const { setStreamingSessionId, workingDirectory, setWorkingDirectory, setPanelOpen, setPendingApprovalSessionId } = usePanel();
  const [messages, setMessages] = useState<Message[]>(initialMessages);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loadingMore, setLoadingMore] = useState(false);
  const loadingMoreRef = useRef(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolUses, setToolUses] = useState<ToolUseInfo[]>([]);
  const [toolResults, setToolResults] = useState<ToolResultInfo[]>([]);
  const [statusText, setStatusText] = useState<string | undefined>();
  const [mode, setMode] = useState(initialMode || 'code');
  const [currentModel, setCurrentModelRaw] = useState(modelName || '');
  const [pendingPermission, setPendingPermission] = useState<PermissionRequestEvent | null>(null);
  const [permissionResolved, setPermissionResolved] = useState<'allow' | 'deny' | null>(null);
  const [streamingToolOutput, setStreamingToolOutput] = useState('');
  const toolTimeoutRef = useRef<{ toolName: string; elapsedSeconds: number } | null>(null);

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
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

  // Ref to keep accumulated streaming content in sync regardless of React batching
  const accumulatedRef = useRef('');
  // Ref for sendMessage to allow self-referencing in timeout auto-retry without circular deps
  const sendMessageRef = useRef<(content: string, files?: FileAttachment[], skillPrompt?: string) => Promise<void>>(undefined);
  // Wake Lock sentinel — keeps the screen on during streaming to prevent socket death on screen-off
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  // Independent AbortController for the SSE read loop only (not the backend Claude process).
  // Aborting this does NOT kill Claude — it just exits consumeSSEStream so recovery can start.
  const readerAbortControllerRef = useRef<AbortController | null>(null);
  // Flag: this abort was triggered by tab-resume recovery, not user stop — route to startRecovery()
  const recoveryAbortRef = useRef(false);
  // Timestamp of last SSE data received — used to detect hung reader on tab resume
  const lastSseDataRef = useRef<number>(0);

  // Fetch messages from DB and check if the backend has finished
  const recoverMessages = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/chat/sessions/${sessionId}/messages?limit=100`);
      if (!res.ok) return false;
      const data: MessagesResponse = await res.json();
      setMessages(data.messages);
      setHasMore(data.hasMore ?? false);
      // Backend is done if the last message is from the assistant
      const lastMsg = data.messages[data.messages.length - 1];
      return lastMsg?.role === 'assistant';
    } catch {
      return false;
    }
  }, [sessionId]);

  const stopRecovery = useCallback(() => {
    if (recoveryTimerRef.current) {
      clearInterval(recoveryTimerRef.current);
      recoveryTimerRef.current = null;
    }
    recoveryActiveRef.current = false;
    setStatusText(undefined);
    window.dispatchEvent(new CustomEvent('refresh-file-tree'));
  }, []);

  const startRecovery = useCallback(() => {
    recoveryActiveRef.current = true;
    setStatusText('Reconnecting...');
    let attempts = 0;
    const maxAttempts = 20; // 20 * 3s = 60s

    const poll = async () => {
      attempts++;
      const done = await recoverMessages();
      if (done || attempts >= maxAttempts) {
        stopRecovery();
        if (!done) {
          // Last attempt — fetch whatever we have
          recoverMessages();
        }
      }
    };

    // Immediate first poll
    poll();
    recoveryTimerRef.current = setInterval(poll, 3000);
  }, [recoverMessages, stopRecovery]);

  // Re-sync streaming content when the window regains visibility (browser tab switch)
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        // Re-sync streaming buffer so UI shows whatever we've accumulated so far
        if (accumulatedRef.current) {
          setStreamingContent(accumulatedRef.current);
        }
        // If recovery polling is already active, nudge it immediately
        if (recoveryActiveRef.current) {
          recoverMessages().then(done => {
            if (done) stopRecovery();
          });
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

  // Cleanup recovery timer on unmount
  useEffect(() => {
    return () => {
      if (recoveryTimerRef.current) {
        clearInterval(recoveryTimerRef.current);
      }
    };
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

  const stopStreaming = useCallback(() => {
    // Abort the client-side reader immediately
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    // Also tell the server to abort the Claude process so it doesn't keep running
    fetch('/api/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
    }).catch(() => { /* best-effort */ });
  }, [sessionId]);

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
      await fetch('/api/chat/permission', {
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
  }, [pendingPermission, setPendingApprovalSessionId]);

  const sendMessage = useCallback(
    async (content: string, files?: FileAttachment[], skillPrompt?: string) => {
      if (isStreaming) return;

      // Cancel any ongoing recovery from a previous disconnection
      if (recoveryActiveRef.current) {
        stopRecovery();
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
      accumulatedRef.current = '';
      setToolUses([]);
      setToolResults([]);
      setStatusText(undefined);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      let accumulated = '';
      let toolCount = 0;

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: sessionId,
            content,
            mode,
            model: currentModel,
            ...(files && files.length > 0 ? { files } : {}),
            ...(skillPrompt ? { skillPrompt } : {}),
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

        const result = await consumeSSEStream(reader, {
          onText: (acc) => {
            lastSseDataRef.current = Date.now();
            accumulated = acc;
            accumulatedRef.current = acc;
            setStreamingContent(acc);
          },
          onToolUse: (tool) => {
            toolCount++;
            setStreamingToolOutput('');
            setToolUses((prev) => {
              if (prev.some((t) => t.id === tool.id)) return prev;
              return [...prev, tool];
            });
          },
          onToolResult: (res) => {
            lastSseDataRef.current = Date.now();
            setStreamingToolOutput('');
            setToolResults((prev) => [...prev, res]);
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
          onResult: () => { /* token usage captured by consumeSSEStream */ },
          onPermissionRequest: (permData) => {
            setPendingPermission(permData);
            setPermissionResolved(null);
            setPendingApprovalSessionId(sessionId);
          },
          onToolTimeout: (toolName, elapsedSeconds) => {
            toolTimeoutRef.current = { toolName, elapsedSeconds };
          },
          onError: (acc) => {
            accumulated = acc;
            accumulatedRef.current = acc;
            setStreamingContent(acc);
          },
        }, readerAbort.signal);

        accumulated = result.accumulated;

        // Add the assistant message to the list
        const finalContent = accumulated.trim()
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
        }
      } catch (error) {
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
            if (accumulated.trim()) {
              const partialMessage: Message = {
                id: 'temp-assistant-' + Date.now(),
                session_id: sessionId,
                role: 'assistant',
                content: accumulated.trim() + `\n\n*(tool ${timeoutInfo.toolName} timed out after ${timeoutInfo.elapsedSeconds}s)*`,
                created_at: new Date().toISOString(),
                token_usage: null,
              };
              setMessages((prev) => [...prev, partialMessage]);
            }
            // Clean up before auto-retry
            toolTimeoutRef.current = null;
            setIsStreaming(false);
            setStreamingSessionId('');
            setStreamingContent('');
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
          if (accumulated.trim()) {
            const partialMessage: Message = {
              id: 'temp-assistant-' + Date.now(),
              session_id: sessionId,
              role: 'assistant',
              content: accumulated.trim() + '\n\n*(generation stopped)*',
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
        toolTimeoutRef.current = null;
        setIsStreaming(false);
        setStreamingSessionId('');
        setStreamingContent('');
        accumulatedRef.current = '';
        setToolUses([]);
        setToolResults([]);
        setStreamingToolOutput('');
        setPendingPermission(null);
        setPermissionResolved(null);
        setPendingApprovalSessionId('');
        abortControllerRef.current = null;
        readerAbortControllerRef.current = null;
        lastSseDataRef.current = 0;
        recoveryAbortRef.current = false;
        // Don't clear statusText or fire refresh if recovery is active — recovery handles that
        if (!recoveryActiveRef.current) {
          setStatusText(undefined);
          window.dispatchEvent(new CustomEvent('refresh-file-tree'));
        }
      }
    },
    [sessionId, isStreaming, setStreamingSessionId, setPendingApprovalSessionId, mode, currentModel, stopRecovery, startRecovery]
  );

  // Keep sendMessageRef in sync so timeout auto-retry can call it
  sendMessageRef.current = sendMessage;

  const handleCommand = useCallback((command: string) => {
    switch (command) {
      case '/help': {
        const helpMessage: Message = {
          id: 'cmd-' + Date.now(),
          session_id: sessionId,
          role: 'assistant',
          content: `## Available Commands\n\n### Instant Commands\n- **/help** — Show this help message\n- **/clear** — Clear conversation history\n- **/cost** — Show token usage statistics\n\n### Prompt Commands (shown as badge, add context then send)\n- **/compact** — Compress conversation context\n- **/doctor** — Diagnose project health\n- **/init** — Initialize CLAUDE.md for project\n- **/review** — Review code quality\n- **/terminal-setup** — Configure terminal settings\n- **/memory** — Edit project memory file\n\n### Custom Skills\nSkills from \`~/.claude/commands/\` and project \`.claude/commands/\` are also available via \`/\`.\n\n**Tips:**\n- Type \`/\` to browse commands and skills\n- Type \`@\` to mention files\n- Use Shift+Enter for new line\n- Select a project folder to enable file operations`,
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
      default:
        // This shouldn't be reached since non-immediate commands are handled via badge
        sendMessage(command);
    }
  }, [sessionId, sendMessage]);

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
        <button
          type="button"
          onClick={() => setSearchOpen(true)}
          className="absolute top-2 right-2 z-10 p-1.5 rounded-md bg-background/80 backdrop-blur-sm border border-border/50 text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Search messages (Cmd+F)"
        >
          <SearchIcon className="h-3.5 w-3.5" />
        </button>
      )}
      <MessageList
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        toolUses={toolUses}
        toolResults={toolResults}
        streamingToolOutput={streamingToolOutput}
        statusText={statusText}
        pendingPermission={pendingPermission}
        onPermissionResponse={handlePermissionResponse}
        permissionResolved={permissionResolved}
        onForceStop={stopStreaming}
        hasMore={hasMore}
        loadingMore={loadingMore}
        onLoadMore={loadEarlierMessages}
        highlightMessageIds={highlightMessageIds}
        activeMessageId={activeMessageId}
        searchQuery={searchQuery}
      />
      <MessageInput
        onSend={sendMessage}
        onCommand={handleCommand}
        onStop={stopStreaming}
        disabled={false}
        isStreaming={isStreaming}
        sessionId={sessionId}
        modelName={currentModel}
        onModelChange={setCurrentModel}
        workingDirectory={workingDirectory}
        mode={mode}
        onModeChange={handleModeChange}
      />
    </div>
  );
}
