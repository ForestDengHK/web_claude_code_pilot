# Multi-Session Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance the sidebar to show real-time status of all streaming sessions with completion toast notifications, enabling parallel task management.

**Architecture:** Extend PanelContext with a `streamingSessions` Map that tracks all active sessions. ChatView registers/updates/removes entries. AppShell polls the status API for background sessions. ChatListPanel reads the Map to render status lines. Sonner toast fires when a background session completes.

**Tech Stack:** React context (existing PanelContext), sonner (already installed), status API (existing `/api/chat/sessions/[id]/status`)

---

### Task 1: Add StreamingSessionInfo to PanelContext

**Files:**
- Modify: `src/hooks/usePanel.ts`

- [ ] **Step 1: Add StreamingSessionInfo type and extend PanelContextValue**

```typescript
// Add after DiffTarget interface in src/hooks/usePanel.ts

export interface StreamingSessionInfo {
  sessionId: string;
  sessionTitle: string;
  status: 'streaming' | 'waiting_permission' | 'waiting_input';
  statusText: string;
  startedAt: number;
}

// Add to PanelContextValue interface, after existing diffTarget fields:
  streamingSessions: Map<string, StreamingSessionInfo>;
  addStreamingSession: (info: StreamingSessionInfo) => void;
  updateStreamingSession: (sessionId: string, updates: Partial<Omit<StreamingSessionInfo, 'sessionId'>>) => void;
  removeStreamingSession: (sessionId: string) => void;
```

- [ ] **Step 2: Verify TypeScript compiles (expect errors in AppShell — context provider doesn't supply new fields yet)**

Run: `npx tsc --noEmit 2>&1 | grep -c "AppShell\|usePanel" | head -5`
Expected: Errors about missing properties in context value

- [ ] **Step 3: Commit**

```bash
git add src/hooks/usePanel.ts
git commit -m "feat(multi-session): add StreamingSessionInfo type to PanelContext"
```

---

### Task 2: Implement Map state and CRUD in AppShell

**Files:**
- Modify: `src/components/layout/AppShell.tsx`

- [ ] **Step 1: Add streamingSessions state and CRUD callbacks**

After the existing `pendingApprovalSessionId` state (line 165), add:

```typescript
  // --- Multi-session streaming state ---
  const [streamingSessions, setStreamingSessions] = useState<Map<string, StreamingSessionInfo>>(
    () => new Map()
  );

  const addStreamingSession = useCallback((info: StreamingSessionInfo) => {
    setStreamingSessions(prev => {
      const next = new Map(prev);
      next.set(info.sessionId, info);
      return next;
    });
  }, []);

  const updateStreamingSession = useCallback((sid: string, updates: Partial<Omit<StreamingSessionInfo, 'sessionId'>>) => {
    setStreamingSessions(prev => {
      const existing = prev.get(sid);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(sid, { ...existing, ...updates });
      return next;
    });
  }, []);

  const removeStreamingSession = useCallback((sid: string) => {
    setStreamingSessions(prev => {
      if (!prev.has(sid)) return prev;
      const next = new Map(prev);
      next.delete(sid);
      return next;
    });
  }, []);
```

- [ ] **Step 2: Add import for StreamingSessionInfo**

Update the import at the top of AppShell.tsx:

```typescript
import { PanelContext, type PanelContent, type PreviewViewMode, type DiffTarget, type StreamingSessionInfo } from "@/hooks/usePanel";
```

- [ ] **Step 3: Wire into panelContextValue**

Add to the `panelContextValue` useMemo object (after `setDiffTarget`):

```typescript
      streamingSessions,
      addStreamingSession,
      updateStreamingSession,
      removeStreamingSession,
```

And add `streamingSessions` to the dependency array of the useMemo.

- [ ] **Step 4: Verify TypeScript compiles cleanly**

Run: `npx tsc --noEmit 2>&1 | grep "src/components/layout/AppShell\|src/hooks/usePanel"`
Expected: No errors from these files

- [ ] **Step 5: Commit**

```bash
git add src/hooks/usePanel.ts src/components/layout/AppShell.tsx
git commit -m "feat(multi-session): implement streamingSessions Map state in AppShell"
```

---

### Task 3: Extract getRunningCommandSummary to shared utility

**Files:**
- Create: `src/lib/streaming-status.ts`
- Modify: `src/components/chat/StreamingMessage.tsx`

- [ ] **Step 1: Create shared utility**

Create `src/lib/streaming-status.ts`:

```typescript
interface ToolInfo {
  name: string;
  input: unknown;
}

/**
 * Generate a human-readable one-liner describing what a tool is doing.
 * Used by both StreamingMessage (inline display) and the multi-session sidebar.
 */
export function getRunningCommandSummary(
  runningTools: ToolInfo[],
  allToolUses: ToolInfo[],
): string | undefined {
  if (runningTools.length === 0) {
    if (allToolUses.length > 0) return 'Generating response...';
    return undefined;
  }
  const tool = runningTools[runningTools.length - 1];
  const input = tool.input as Record<string, unknown>;
  if (tool.name === 'Bash' && input.command) {
    const cmd = String(input.command);
    return cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
  }
  if (input.file_path) return `${tool.name}: ${String(input.file_path)}`;
  if (input.path) return `${tool.name}: ${String(input.path)}`;
  return `Running ${tool.name}...`;
}
```

- [ ] **Step 2: Use shared utility in StreamingMessage**

In `src/components/chat/StreamingMessage.tsx`, add import:

```typescript
import { getRunningCommandSummary as getCommandSummary } from '@/lib/streaming-status';
```

Replace the local `getRunningCommandSummary` function (lines 360-375) with:

```typescript
  const getRunningCommandSummary = (): string | undefined => {
    return getCommandSummary(runningTools, toolUses);
  };
```

- [ ] **Step 3: Verify TypeScript compiles and no behavior change**

Run: `npx tsc --noEmit 2>&1 | grep "streaming-status\|StreamingMessage"`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/streaming-status.ts src/components/chat/StreamingMessage.tsx
git commit -m "refactor: extract getRunningCommandSummary to shared utility"
```

---

### Task 4: ChatView registers streaming lifecycle with context

**Files:**
- Modify: `src/components/chat/ChatView.tsx`

- [ ] **Step 1: Import new context methods**

Update the usePanel destructure (around line 95):

```typescript
  const { setStreamingSessionId, workingDirectory, setWorkingDirectory, setPanelOpen, setPendingApprovalSessionId, sessionTitle, addStreamingSession, updateStreamingSession, removeStreamingSession } = usePanel();
```

Also add import:

```typescript
import { getRunningCommandSummary } from '@/lib/streaming-status';
```

- [ ] **Step 2: Register session when streaming starts**

In `sendMessage()`, find the line `setStreamingSessionId(sessionId);` (around line 871). Right after it, add:

```typescript
      addStreamingSession({
        sessionId,
        sessionTitle: sessionTitle || 'New Chat',
        status: 'streaming',
        statusText: 'Thinking...',
        startedAt: Date.now(),
      });
```

- [ ] **Step 3: Update status on tool_use events**

In the SSE event handler, find where `setToolUses` is called for new tool_use events. After the tool is added to state, also update the streaming session status. Find the `onToolUse` callback and add after it updates toolUsesRef:

```typescript
        // Update streaming session status for sidebar
        const summary = getRunningCommandSummary(
          [{ name: toolUse.name, input: toolUse.input }],
          [...toolUsesRef.current, { id: toolUse.id, name: toolUse.name, input: toolUse.input }],
        );
        if (summary) {
          updateStreamingSession(sessionId, { statusText: summary });
        }
```

- [ ] **Step 4: Update status on permission request**

Find where `setPendingPermission` is called (in the SSE `permission_request` handler). After it, add:

```typescript
        updateStreamingSession(sessionId, {
          status: 'waiting_permission',
          statusText: 'Waiting for approval',
        });
```

And when permission is resolved (after `setPermissionResolved`), add:

```typescript
        updateStreamingSession(sessionId, {
          status: 'streaming',
          statusText: 'Resuming...',
        });
```

- [ ] **Step 5: Remove session when streaming ends**

Find all places where `setStreamingSessionId('')` is called (lines ~335, ~1101, ~1167). After each one, add:

```typescript
        removeStreamingSession(sessionId);
```

- [ ] **Step 6: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "ChatView"`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/components/chat/ChatView.tsx
git commit -m "feat(multi-session): register streaming lifecycle in context"
```

---

### Task 5: Enhance ChatListPanel with status line

**Files:**
- Modify: `src/components/layout/ChatListPanel.tsx`

- [ ] **Step 1: Read streamingSessions from context**

Update the usePanel destructure (around line 121):

```typescript
  const { streamingSessionId, pendingApprovalSessionId, streamingSessions } = usePanel();
```

- [ ] **Step 2: Add state for "just completed" sessions**

After the usePanel line, add:

```typescript
  // Track recently completed sessions for fade-out "Done" indicator
  const [recentlyCompleted, setRecentlyCompleted] = useState<Set<string>>(new Set());
  const prevStreamingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const currentIds = new Set(streamingSessions.keys());
    const prevIds = prevStreamingRef.current;

    // Sessions that were streaming but no longer are → just completed
    for (const id of prevIds) {
      if (!currentIds.has(id)) {
        setRecentlyCompleted(prev => new Set(prev).add(id));
        // Remove after 5 seconds
        setTimeout(() => {
          setRecentlyCompleted(prev => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
        }, 5000);
      }
    }
    prevStreamingRef.current = currentIds;
  }, [streamingSessions]);
```

- [ ] **Step 3: Replace single-session streaming check with multi-session**

In the session rendering loop (around line 755-758), replace:

```typescript
                            const isSessionStreaming =
                              streamingSessionId === session.id;
                            const needsApproval =
                              pendingApprovalSessionId === session.id;
```

With:

```typescript
                            const streamingInfo = streamingSessions.get(session.id);
                            const isSessionStreaming = !!streamingInfo;
                            const needsApproval = streamingInfo?.status === 'waiting_permission'
                              || streamingInfo?.status === 'waiting_input'
                              || pendingApprovalSessionId === session.id;
                            const justCompleted = recentlyCompleted.has(session.id);
```

- [ ] **Step 4: Add status line below title**

Find the session title span (around line 793-795):

```tsx
                                  <div className="flex-1 min-w-0">
                                    <span className="line-clamp-1 text-[12px] font-medium leading-tight break-all">
                                      {session.title}
                                    </span>
                                  </div>
```

Replace with:

```tsx
                                  <div className="flex-1 min-w-0">
                                    <span className="line-clamp-1 text-[12px] font-medium leading-tight break-all">
                                      {session.title}
                                    </span>
                                    {isSessionStreaming && streamingInfo && (
                                      <span className="line-clamp-1 text-[10px] text-muted-foreground/60 leading-tight">
                                        {streamingInfo.statusText}
                                      </span>
                                    )}
                                    {justCompleted && !isSessionStreaming && (
                                      <span className="text-[10px] text-green-500 leading-tight animate-pulse">
                                        ✓ Done
                                      </span>
                                    )}
                                  </div>
```

- [ ] **Step 5: Hide timestamp when streaming (status text replaces it)**

Find the timestamp span (around line 797-801):

```tsx
                                  <div className="flex items-center gap-1 shrink-0">
                                    <span className="text-[10px] text-muted-foreground/40">
                                      {formatRelativeTime(session.updated_at)}
                                    </span>
                                  </div>
```

Replace with:

```tsx
                                  {!isSessionStreaming && !justCompleted && (
                                    <div className="flex items-center gap-1 shrink-0">
                                      <span className="text-[10px] text-muted-foreground/40">
                                        {formatRelativeTime(session.updated_at)}
                                      </span>
                                    </div>
                                  )}
```

- [ ] **Step 6: Add useRef import if not present**

Check the existing imports. If `useRef` is not imported, add it to the React import line.

- [ ] **Step 7: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "ChatListPanel"`
Expected: No errors

- [ ] **Step 8: Commit**

```bash
git add src/components/layout/ChatListPanel.tsx
git commit -m "feat(multi-session): show streaming status line in sidebar"
```

---

### Task 6: Background status polling in AppShell

**Files:**
- Modify: `src/components/layout/AppShell.tsx`

- [ ] **Step 1: Add polling effect**

After the `streamingSessions` CRUD callbacks, add:

```typescript
  // --- Background polling for non-active streaming sessions ---
  useEffect(() => {
    if (streamingSessions.size === 0) return;

    // Only poll sessions that are NOT the currently viewed session
    const backgroundSessions = Array.from(streamingSessions.keys()).filter(
      sid => sid !== sessionId
    );
    if (backgroundSessions.length === 0) return;

    const poll = async () => {
      for (const sid of backgroundSessions) {
        try {
          const res = await fetch(`/api/chat/sessions/${sid}/status`);
          if (!res.ok) continue;
          const data = await res.json();

          if (!data.isProcessing) {
            // Session completed in background
            removeStreamingSession(sid);
          } else if (data.pendingPermission) {
            updateStreamingSession(sid, {
              status: 'waiting_permission',
              statusText: 'Waiting for approval',
            });
          } else if (data.pendingInputRequest) {
            updateStreamingSession(sid, {
              status: 'waiting_input',
              statusText: 'Waiting for input',
            });
          } else if (data.streamingContent?.statusText) {
            updateStreamingSession(sid, {
              statusText: data.streamingContent.statusText,
            });
          }
        } catch {
          // Network error — skip this cycle
        }
      }
    };

    // Poll immediately, then every 3 seconds
    poll();
    const intervalId = setInterval(poll, 3000);
    return () => clearInterval(intervalId);
  }, [streamingSessions, sessionId, removeStreamingSession, updateStreamingSession]);
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "AppShell"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/AppShell.tsx
git commit -m "feat(multi-session): add background status polling for non-active sessions"
```

---

### Task 7: Toast notifications on background completion

**Files:**
- Modify: `src/components/layout/AppShell.tsx`

- [ ] **Step 1: Add toast import and completion detection**

Add import at the top of AppShell.tsx:

```typescript
import { toast } from "sonner";
```

Add a ref to track previous streaming sessions (for completion detection). Place after the `streamingSessions` state:

```typescript
  const prevStreamingSessionsRef = useRef<Map<string, StreamingSessionInfo>>(new Map());
```

Add import for `useRef` if not already imported. Add `useRouter` for navigation:

```typescript
import { usePathname, useRouter } from "next/navigation";
```

Then add the effect, after the polling effect:

```typescript
  // --- Toast notification when background session completes ---
  const router = useRouter();

  useEffect(() => {
    const prev = prevStreamingSessionsRef.current;
    const current = streamingSessions;

    for (const [sid, info] of prev) {
      if (!current.has(sid) && sid !== sessionId) {
        // This session was streaming but is now gone, and it's not the active session
        toast.success(`${info.sessionTitle} 已完成`, {
          action: {
            label: '查看',
            onClick: () => router.push(`/chat/${sid}`),
          },
          duration: 5000,
        });
      }
    }

    prevStreamingSessionsRef.current = new Map(current);
  }, [streamingSessions, sessionId, router]);
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit 2>&1 | grep "AppShell"`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/components/layout/AppShell.tsx
git commit -m "feat(multi-session): toast notification on background session completion"
```

---

### Task 8: Integration test — manual verification

- [ ] **Step 1: Start dev server and open two sessions**

1. Open CodePilot at `http://localhost:4000`
2. Start a message in Session A (e.g. "list files in src/")
3. While Session A is streaming, navigate to Session B
4. Verify: Session A shows green pulse + status text in sidebar
5. Verify: When Session A finishes, toast appears with "查看" button
6. Verify: Clicking toast navigates to Session A
7. Verify: Status line fades to "✓ Done" then back to timestamp after 5s

- [ ] **Step 2: Test mobile (390px width)**

1. Resize browser to 390px width
2. Open sidebar — verify status lines visible and not truncated badly
3. Start streaming in one session, switch to another via sidebar
4. Verify toast appears at bottom-center on completion

- [ ] **Step 3: Test edge cases**

1. Start streaming, navigate away to Settings page, come back — sidebar should still show status
2. Start two sessions streaming simultaneously — both should show status
3. Refresh page mid-stream — streaming session should recover via existing recovery mechanism

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(multi-session): integration test fixes"
```
