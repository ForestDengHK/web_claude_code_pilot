const globalKey = '__codexPendingReviews__' as const;

function getMap(): Map<string, Promise<unknown>> {
  if (!(globalThis as Record<string, unknown>)[globalKey]) {
    (globalThis as Record<string, unknown>)[globalKey] = new Map<string, Promise<unknown>>();
  }

  return (globalThis as Record<string, unknown>)[globalKey] as Map<string, Promise<unknown>>;
}

export function getOrCreatePendingCodexReview<T>(
  sessionId: string,
  factory: () => Promise<T>,
): Promise<T> {
  const map = getMap();
  const existing = map.get(sessionId);
  if (existing) {
    return existing as Promise<T>;
  }

  const pending = factory().finally(() => {
    if (map.get(sessionId) === pending) {
      map.delete(sessionId);
    }
  });

  map.set(sessionId, pending as Promise<unknown>);
  return pending;
}
