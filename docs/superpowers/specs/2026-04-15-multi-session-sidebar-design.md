# Multi-Session Sidebar Design

## Goal

Enhance the existing sidebar to show real-time status of all streaming sessions, enabling parallel task management with quick switching and completion notifications. No layout changes — single chat view stays as-is.

## Context

- Backend already supports concurrent streaming (abort-registry, streaming-buffer per sessionId)
- Sidebar (ChatListPanel) already shows green pulse for one streaming session
- Status API (`GET /api/chat/sessions/{id}/status`) returns `isProcessing`, `statusText`, and streaming content
- User accesses primarily from mobile via Tailscale — screen space is limited

## Design

### 1. State Tracking

Replace `streamingSessionId: string` with a richer structure in PanelContext:

```typescript
interface StreamingSessionInfo {
  sessionId: string;
  status: 'streaming' | 'waiting_permission' | 'waiting_input';
  statusText: string;     // e.g. "Reading src/lib/db.ts", "Running npm test"
  startedAt: number;      // Date.now() timestamp
}
```

PanelContext additions:
- `streamingSessions: Map<string, StreamingSessionInfo>` — all active sessions
- `addStreamingSession(info: StreamingSessionInfo): void`
- `updateStreamingSession(sessionId: string, updates: Partial<StreamingSessionInfo>): void`
- `removeStreamingSession(sessionId: string): void`

Backward compatibility: keep `streamingSessionId` as a derived value pointing to the currently-viewed streaming session. Existing code that reads `streamingSessionId` (e.g. sidebar pulse indicator) continues to work during migration.

### 2. Sidebar Enhancement

Each session entry in ChatListPanel gains a status line below the title:

**Streaming:**
```
🟢 Git功能对比+移动端Diff修复
   Reading src/components/chat...     ← replaces timestamp
```

**Waiting for approval:**
```
🟠 Git功能对比+移动端Diff修复
   Waiting for approval               ← orange pulse
```

**Just completed (5s fade-out):**
```
✓ Git功能对比+移动端Diff修复
   Done                               ← green text, fades to timestamp
```

**Normal (no change):**
```
  Git功能对比+移动端Diff修复      1d
```

Rules:
- Status line truncates with ellipsis on overflow
- Status line updates come from the streaming session Map
- Only sessions in `streamingSessions` Map get status treatment
- Existing grouping, sorting, search, collapse behavior unchanged

### 3. Toast Notifications

When a streaming session completes:
- If the completed session is NOT the currently viewed session → show toast
- If it IS the current session → no toast (user can see it directly)

Toast format (using existing sonner library):
```
✓ {sessionTitle} 已完成     [查看]
```

Behavior:
- Auto-dismiss after 5 seconds
- Click toast or "查看" button → navigate to that session
- Multiple completions stack (sonner handles this natively)
- No sound, no desktop notifications

### 4. Background Status Polling

AppShell manages a poller that monitors non-active streaming sessions:

**When to poll:**
- `streamingSessions.size > 0` AND at least one session is not the current page's session
- Poll interval: 3 seconds
- Stop polling when no background streaming sessions remain

**What to poll:**
- `GET /api/chat/sessions/{id}/status` for each background streaming session
- Extract `statusText` from response to update sidebar display
- When `isProcessing: false` → remove from Map, trigger toast

**What NOT to poll:**
- The currently viewed session (it has its own SSE connection)
- Sessions not in the `streamingSessions` Map

### 5. ChatView Integration

ChatView registers streaming lifecycle with context:

- `sendMessage()` start → `addStreamingSession({ sessionId, status: 'streaming', statusText: 'Thinking...', startedAt: Date.now() })`
- SSE `tool_use` event → `updateStreamingSession(sessionId, { statusText: 'Reading src/...' })`
- SSE `permission_request` → `updateStreamingSession(sessionId, { status: 'waiting_permission', statusText: 'Waiting for approval' })`
- Stream complete → `removeStreamingSession(sessionId)`

The status text generation reuses existing `getRunningCommandSummary()` logic from StreamingMessage.tsx — extract it to a shared utility.

## Files to Modify

| File | Change |
|------|--------|
| `src/hooks/usePanel.ts` | Add `StreamingSessionInfo` type, `streamingSessions` Map + CRUD methods |
| `src/components/layout/AppShell.tsx` | Initialize Map state, provide context, add background poller |
| `src/components/layout/ChatListPanel.tsx` | Read `streamingSessions`, render status line per session |
| `src/components/chat/ChatView.tsx` | Register/update/remove streaming session in context |
| `src/lib/tool-display.ts` or new `src/lib/streaming-status.ts` | Extract `getRunningCommandSummary()` to shared utility |

## Files NOT Modified

- Backend APIs — no changes needed
- Database schema — no new columns
- StreamingMessage.tsx — internal display unchanged
- MessageList.tsx — no changes

## Out of Scope

- Split/multi-panel chat view
- WebSocket for real-time push
- Sound or desktop notifications
- Cross-tab synchronization
- Progress bars or percentage indicators
