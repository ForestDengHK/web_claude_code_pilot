'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { HugeiconsIcon } from "@hugeicons/react";
import { StarIcon, StarOffIcon, Clock01Icon, Folder01Icon, FolderOpenIcon } from "@hugeicons/core-free-icons";
import type { Message, SSEEvent, SessionResponse, TokenUsage, PermissionRequestEvent } from '@/types';
import { MessageList } from '@/components/chat/MessageList';
import { MessageInput } from '@/components/chat/MessageInput';
import { usePanel } from '@/hooks/usePanel';

interface ToolUseInfo {
  id: string;
  name: string;
  input: unknown;
}

interface ToolResultInfo {
  tool_use_id: string;
  content: string;
}

interface FavoriteDir {
  path: string;
  name: string;
}

export default function NewChatPage() {
  const router = useRouter();
  const { setWorkingDirectory, setPanelOpen, setPendingApprovalSessionId } = usePanel();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolUses, setToolUses] = useState<ToolUseInfo[]>([]);
  const [toolResults, setToolResults] = useState<ToolResultInfo[]>([]);
  const [statusText, setStatusText] = useState<string | undefined>();
  const [workingDir, setWorkingDir] = useState('');
  const [mode, setMode] = useState('code');
  const [currentModel, setCurrentModel] = useState('sonnet');
  const [pendingPermission, setPendingPermission] = useState<PermissionRequestEvent | null>(null);
  const [permissionResolved, setPermissionResolved] = useState<'allow' | 'deny' | null>(null);
  const [streamingToolOutput, setStreamingToolOutput] = useState('');
  const abortControllerRef = useRef<AbortController | null>(null);

  // Favorites & Recent
  const [favorites, setFavorites] = useState<FavoriteDir[]>([]);
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  // Fetch favorites and recent on mount
  useEffect(() => {
    fetch('/api/favorites')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) {
          setFavorites(data.favorites || []);
          setRecentDirs(data.recent || []);
        }
      })
      .catch(() => {});
  }, []);

  const toggleFavorite = useCallback(async (dirPath: string) => {
    const isFav = favorites.some(f => f.path === dirPath);
    try {
      const res = await fetch('/api/favorites', {
        method: isFav ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath, name: dirPath.split('/').pop() || dirPath }),
      });
      if (res.ok) {
        const data = await res.json();
        setFavorites(data.favorites || []);
      }
    } catch { /* silent */ }
  }, [favorites]);

  const selectDirectory = useCallback(async (dirPath: string) => {
    setWorkingDir(dirPath);
    if (typeof window !== 'undefined') {
      localStorage.setItem('codepilot:last-working-directory', dirPath);
    }
    // Create a session immediately and navigate so the file tree is available
    try {
      const res = await fetch('/api/chat/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ working_directory: dirPath }),
      });
      if (res.ok) {
        const data = await res.json();
        window.dispatchEvent(new CustomEvent('session-created'));
        router.push(`/chat/${data.session.id}`);
      }
    } catch {
      // If session creation fails, keep the old behavior (stay on /chat page)
    }
  }, [router]);

  const stopStreaming = useCallback(() => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
  }, []);

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
      // Best effort
    }

    setTimeout(() => {
      setPendingPermission(null);
      setPermissionResolved(null);
    }, 1000);
  }, [pendingPermission, setPendingApprovalSessionId]);

  const sendFirstMessage = useCallback(
    async (content: string, _files?: unknown, skillInfo?: { name: string; content: string }) => {
      if (isStreaming) return;

      // Require a project directory before sending
      if (!workingDir.trim()) {
        const hint: Message = {
          id: 'hint-' + Date.now(),
          session_id: '',
          role: 'assistant',
          content: '**Please select a project directory first.** Use the folder picker in the toolbar below to choose a working directory before sending a message.',
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages((prev) => [...prev, hint]);
        return;
      }

      // When a skill is active, inject its content into the API message as a
      // <command-name> block (matching Claude Code CLI behavior).
      let apiContent = content;
      if (skillInfo) {
        apiContent = `<command-name>${skillInfo.name}</command-name>\n\n${skillInfo.content}\n\nUser request: ${content}`;
      }

      setIsStreaming(true);
      setStreamingContent('');
      setToolUses([]);
      setToolResults([]);
      setStatusText(undefined);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      let sessionId = '';

      try {
        // Create a new session with working directory
        const createBody: Record<string, string> = {
          title: content.slice(0, 50),
          mode,
          working_directory: workingDir.trim(),
        };

        const createRes = await fetch('/api/chat/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(createBody),
        });

        if (!createRes.ok) {
          const errBody = await createRes.json().catch(() => ({}));
          throw new Error(errBody.error || `Failed to create session (${createRes.status})`);
        }

        const { session }: SessionResponse = await createRes.json();
        sessionId = session.id;

        // Notify ChatListPanel to refresh immediately
        window.dispatchEvent(new CustomEvent('session-created'));

        // Add user message to UI (display clean user text, not the skill-wrapped version)
        const userMessage: Message = {
          id: 'temp-' + Date.now(),
          session_id: session.id,
          role: 'user',
          content,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages([userMessage]);

        // Send the message via streaming API (prompt includes skill wrapper if applicable)
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: session.id,
            content,
            ...(apiContent !== content ? { prompt: apiContent } : {}),
            mode,
            model: currentModel,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = await response.json();
          throw new Error(err.error || 'Failed to send message');
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response stream');

        const decoder = new TextDecoder();
        let accumulated = '';
        let tokenUsage: TokenUsage | null = null;
        let toolCount = 0;
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;

            try {
              const event: SSEEvent = JSON.parse(line.slice(6));

              switch (event.type) {
                case 'text': {
                  accumulated += event.data;
                  setStreamingContent(accumulated);
                  break;
                }
                case 'tool_use': {
                  try {
                    const toolData = JSON.parse(event.data);
                    toolCount++;
                    setStreamingToolOutput('');
                    setToolUses((prev) => {
                      if (prev.some((t) => t.id === toolData.id)) return prev;
                      return [...prev, { id: toolData.id, name: toolData.name, input: toolData.input }];
                    });
                  } catch { /* skip */ }
                  break;
                }
                case 'tool_result': {
                  try {
                    const resultData = JSON.parse(event.data);
                    setStreamingToolOutput('');
                    setToolResults((prev) => [...prev, { tool_use_id: resultData.tool_use_id, content: resultData.content }]);
                  } catch { /* skip */ }
                  break;
                }
                case 'tool_output': {
                  try {
                    const parsed = JSON.parse(event.data);
                    if (parsed._progress) {
                      setStatusText(`Running ${parsed.tool_name}... (${Math.round(parsed.elapsed_time_seconds)}s)`);
                      break;
                    }
                  } catch {
                    // Not JSON — raw stderr output
                  }
                  setStreamingToolOutput((prev) => {
                    const next = prev + (prev ? '\n' : '') + event.data;
                    return next.length > 5000 ? next.slice(-5000) : next;
                  });
                  break;
                }
                case 'status': {
                  try {
                    const statusData = JSON.parse(event.data);
                    if (statusData.session_id) {
                      setStatusText(`Connected (${statusData.model || 'claude'})`);
                      setTimeout(() => setStatusText(undefined), 2000);
                    } else if (statusData.notification) {
                      setStatusText(statusData.message || statusData.title || undefined);
                    } else {
                      setStatusText(event.data || undefined);
                    }
                  } catch {
                    setStatusText(event.data || undefined);
                  }
                  break;
                }
                case 'result': {
                  try {
                    const resultData = JSON.parse(event.data);
                    if (resultData.usage) tokenUsage = resultData.usage;
                  } catch { /* skip */ }
                  setStatusText(undefined);
                  break;
                }
                case 'permission_request': {
                  try {
                    const permData: PermissionRequestEvent = JSON.parse(event.data);
                    setPendingPermission(permData);
                    setPermissionResolved(null);
                    setPendingApprovalSessionId(sessionId);
                  } catch {
                    // skip malformed permission_request data
                  }
                  break;
                }
                case 'error': {
                  accumulated += '\n\n**Error:** ' + event.data;
                  setStreamingContent(accumulated);
                  break;
                }
                case 'done':
                  break;
              }
            } catch {
              // skip
            }
          }
        }

        // Add the completed assistant message
        const finalContent = accumulated.trim()
          || (toolCount > 0 ? '*(Task completed with tool activity but no text response)*' : '');
        if (finalContent) {
          const assistantMessage: Message = {
            id: 'temp-assistant-' + Date.now(),
            session_id: session.id,
            role: 'assistant',
            content: finalContent,
            created_at: new Date().toISOString(),
            token_usage: tokenUsage ? JSON.stringify(tokenUsage) : null,
          };
          setMessages((prev) => [...prev, assistantMessage]);
        }

        // Navigate to the session page after response is complete
        router.push(`/chat/${session.id}`);
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          // User stopped - navigate to session if we have one
          if (sessionId) {
            router.push(`/chat/${sessionId}`);
          }
        } else {
          const errMsg = error instanceof Error ? error.message : 'Unknown error';
          const errorMessage: Message = {
            id: 'temp-error-' + Date.now(),
            session_id: '',
            role: 'assistant',
            content: `**Error:** ${errMsg}`,
            created_at: new Date().toISOString(),
            token_usage: null,
          };
          setMessages((prev) => [...prev, errorMessage]);
        }
      } finally {
        setIsStreaming(false);
        setStreamingContent('');
        setToolUses([]);
        setToolResults([]);
        setStreamingToolOutput('');
        setStatusText(undefined);
        setPendingPermission(null);
        setPermissionResolved(null);
        setPendingApprovalSessionId('');
        abortControllerRef.current = null;
      }
    },
    [isStreaming, router, workingDir, mode, currentModel, setPendingApprovalSessionId]
  );

  const handleCommand = useCallback((command: string) => {
    switch (command) {
      case '/help': {
        const helpMessage: Message = {
          id: 'cmd-' + Date.now(),
          session_id: '',
          role: 'assistant',
          content: `## Available Commands\n\n- **/help** - Show this help message\n- **/clear** - Clear conversation history\n- **/compact** - Compress conversation context\n- **/cost** - Show token usage statistics\n- **/doctor** - Check system health\n- **/init** - Initialize CLAUDE.md\n- **/review** - Start code review\n- **/terminal-setup** - Configure terminal\n\n**Tips:**\n- Type \`@\` to mention files\n- Use Shift+Enter for new line\n- Select a project folder to enable file operations`,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, helpMessage]);
        break;
      }
      case '/clear':
        setMessages([]);
        break;
      case '/cost': {
        const costMessage: Message = {
          id: 'cmd-' + Date.now(),
          session_id: '',
          role: 'assistant',
          content: `## Token Usage\n\nToken usage tracking is available after sending messages. Check the token count displayed at the bottom of each assistant response.`,
          created_at: new Date().toISOString(),
          token_usage: null,
        };
        setMessages(prev => [...prev, costMessage]);
        break;
      }
      default:
        sendFirstMessage(command);
    }
  }, [sendFirstMessage]);

  // Filter recent dirs that are not already in favorites
  const favoritePaths = new Set(favorites.map(f => f.path));
  const filteredRecent = recentDirs.filter(d => !favoritePaths.has(d));

  const showDirectoryPicker = messages.length === 0 && !isStreaming;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showDirectoryPicker ? (
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-8">
          <div className="w-full max-w-md space-y-6">
            {/* Selected directory indicator */}
            {workingDir && (
              <div className="rounded-lg border border-border bg-accent/30 px-4 py-3">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <HugeiconsIcon icon={FolderOpenIcon} className="h-4 w-4 text-blue-500" />
                  <span className="font-medium text-foreground">Selected:</span>
                  <span className="truncate font-mono text-xs">{workingDir}</span>
                </div>
              </div>
            )}

            {/* Favorites section */}
            {favorites.length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <HugeiconsIcon icon={StarIcon} className="h-4 w-4 text-yellow-500" />
                  Favorites
                </div>
                <div className="space-y-1">
                  {favorites.map((fav) => (
                    <div
                      key={fav.path}
                      role="button"
                      tabIndex={0}
                      className={`flex w-full cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors hover:bg-accent min-h-[48px] ${
                        workingDir === fav.path
                          ? 'border-blue-500/50 bg-blue-500/5'
                          : 'border-border'
                      }`}
                      onClick={() => selectDirectory(fav.path)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') selectDirectory(fav.path); }}
                    >
                      <HugeiconsIcon icon={Folder01Icon} className="h-4 w-4 shrink-0 text-blue-500" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-medium">{fav.name}</div>
                        <div className="truncate font-mono text-xs text-muted-foreground">{fav.path}</div>
                      </div>
                      <button
                        className="shrink-0 rounded p-1 text-yellow-500 hover:bg-yellow-500/10 transition-colors"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleFavorite(fav.path);
                        }}
                        title="Remove from favorites"
                      >
                        <HugeiconsIcon icon={StarIcon} className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Recent section */}
            {filteredRecent.length > 0 && (
              <div>
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  <HugeiconsIcon icon={Clock01Icon} className="h-4 w-4" />
                  Recent
                </div>
                <div className="space-y-1">
                  {filteredRecent.map((dirPath) => {
                    const dirName = dirPath.split('/').pop() || dirPath;
                    return (
                      <div
                        key={dirPath}
                        role="button"
                        tabIndex={0}
                        className={`flex w-full cursor-pointer items-center gap-3 rounded-lg border px-4 py-3 text-left text-sm transition-colors hover:bg-accent min-h-[48px] ${
                          workingDir === dirPath
                            ? 'border-blue-500/50 bg-blue-500/5'
                            : 'border-border'
                        }`}
                        onClick={() => selectDirectory(dirPath)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') selectDirectory(dirPath); }}
                      >
                        <HugeiconsIcon icon={Folder01Icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{dirName}</div>
                          <div className="truncate font-mono text-xs text-muted-foreground">{dirPath}</div>
                        </div>
                        <button
                          className="shrink-0 rounded p-1 text-muted-foreground hover:text-yellow-500 hover:bg-yellow-500/10 transition-colors"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFavorite(dirPath);
                          }}
                          title="Add to favorites"
                        >
                          <HugeiconsIcon icon={StarOffIcon} className="h-4 w-4" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {!workingDir && (favorites.length > 0 || filteredRecent.length > 0) && (
              <p className="text-center text-xs text-muted-foreground">
                Select a project directory to start chatting
              </p>
            )}
          </div>
        </div>
      ) : (
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
        />
      )}
      <MessageInput
        onSend={sendFirstMessage}
        onCommand={handleCommand}
        onStop={stopStreaming}
        disabled={false}
        isStreaming={isStreaming}
        modelName={currentModel}
        onModelChange={setCurrentModel}
        workingDirectory={workingDir}
        mode={mode}
        onModeChange={setMode}
      />

    </div>
  );
}
