/**
 * Server-side registry for Codex code reviews.
 *
 * Deduplicates concurrent review requests for the same session and caches
 * completed results so they survive mobile HTTP disconnections — when iOS
 * suspends a tab the fetch drops, but the server-side review keeps running.
 * The client can poll GET /api/codex/review/status to retrieve the result.
 */

const globalKey = '__codexPendingReviews__' as const;

/** How long completed/failed results stay cached (10 minutes). */
const RESULT_TTL_MS = 10 * 60 * 1000;

/** Max progress events kept in the ring buffer. */
const MAX_PROGRESS_EVENTS = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewProgress {
  /** Latest reasoning/thinking text preview (last ~500 chars). */
  thinkingPreview: string;
  /** Latest high-level status (e.g. "Reading src/foo.ts..."). */
  statusText: string;
  /** Ring buffer of notable events (tool uses, file reads, etc.). */
  events: string[];
}

interface ReviewEntry {
  promise: Promise<unknown>;
  status: 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  startedAt: number;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  progress: ReviewProgress;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function getMap(): Map<string, ReviewEntry> {
  if (!(globalThis as Record<string, unknown>)[globalKey]) {
    (globalThis as Record<string, unknown>)[globalKey] = new Map<string, ReviewEntry>();
  }
  return (globalThis as Record<string, unknown>)[globalKey] as Map<string, ReviewEntry>;
}

/**
 * Start a new review or join an in-flight one.  Completed results are cached
 * for {@link RESULT_TTL_MS} so that reconnecting clients can retrieve them.
 */
export function getOrCreatePendingCodexReview<T>(
  sessionId: string,
  factory: () => Promise<T>,
): Promise<T> {
  const map = getMap();
  const existing = map.get(sessionId);

  if (existing) {
    // Completed — return cached result immediately
    if (existing.status === 'completed') {
      return Promise.resolve(existing.result as T);
    }
    // Still running — join the same promise
    if (existing.status === 'running') {
      return existing.promise as Promise<T>;
    }
    // Failed — clear stale entry and fall through to start fresh
    clearReviewEntry(sessionId);
  }

  const entry: ReviewEntry = {
    promise: null!,
    status: 'running',
    startedAt: Date.now(),
    progress: { thinkingPreview: '', statusText: '', events: [] },
  };

  const promise = factory()
    .then((result) => {
      entry.status = 'completed';
      entry.result = result;
      scheduleCleanup(sessionId, entry);
      return result;
    })
    .catch((err) => {
      entry.status = 'failed';
      entry.error = err instanceof Error ? err.message : String(err);
      scheduleCleanup(sessionId, entry);
      throw err;
    });

  entry.promise = promise as Promise<unknown>;
  map.set(sessionId, entry);
  return promise;
}

/**
 * Return the current review status for a session.
 * Used by the status polling endpoint.
 */
export function getCodexReviewStatus(sessionId: string): {
  status: 'idle' | 'running' | 'completed' | 'failed';
  result?: unknown;
  error?: string;
  startedAt?: number;
  progress?: ReviewProgress;
} {
  const entry = getMap().get(sessionId);
  if (!entry) return { status: 'idle' };
  return {
    status: entry.status,
    ...(entry.status === 'completed' ? { result: entry.result } : {}),
    ...(entry.status === 'failed' ? { error: entry.error } : {}),
    ...(entry.status === 'running' ? { progress: entry.progress } : {}),
    startedAt: entry.startedAt,
  };
}

/**
 * Update progress for an active review.  Called from `runCodexReview()` as
 * intermediate Codex events arrive.
 */
export function updateReviewProgress(
  sessionId: string,
  update: { thinkingPreview?: string; statusText?: string; event?: string },
): void {
  const entry = getMap().get(sessionId);
  if (!entry || entry.status !== 'running') return;

  if (update.thinkingPreview !== undefined) {
    entry.progress.thinkingPreview = update.thinkingPreview;
  }
  if (update.statusText !== undefined) {
    entry.progress.statusText = update.statusText;
  }
  if (update.event) {
    entry.progress.events.push(update.event);
    if (entry.progress.events.length > MAX_PROGRESS_EVENTS) {
      entry.progress.events = entry.progress.events.slice(-MAX_PROGRESS_EVENTS);
    }
  }
}

/**
 * Clear a cached (non-running) review entry.  Used when forcing a re-run.
 */
export function clearReviewEntry(sessionId: string): void {
  const map = getMap();
  const entry = map.get(sessionId);
  if (!entry) return;
  if (entry.status === 'running') return; // don't kill an active review
  if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
  map.delete(sessionId);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function scheduleCleanup(sessionId: string, entry: ReviewEntry): void {
  entry.cleanupTimer = setTimeout(() => {
    const map = getMap();
    if (map.get(sessionId) === entry) {
      map.delete(sessionId);
    }
  }, RESULT_TTL_MS);
}
