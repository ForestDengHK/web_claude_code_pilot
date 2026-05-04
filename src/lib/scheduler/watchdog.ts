export type WatchdogResult<T> =
  | { kind: 'finished'; value: T }
  | { kind: 'timed_out' }
  | { kind: 'errored'; error: Error };

export async function runWithWallClock<T>(
  wallClockSeconds: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<WatchdogResult<T>> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;

  const timeoutPromise = new Promise<WatchdogResult<T>>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve({ kind: 'timed_out' });
    }, wallClockSeconds * 1000);
  });

  const innerPromise: Promise<WatchdogResult<T>> = (async () => {
    try {
      const value = await fn(controller.signal);
      return { kind: 'finished', value } as const;
    } catch (err) {
      if (timedOut) return { kind: 'timed_out' } as const;
      const error = err instanceof Error ? err : new Error(String(err));
      return { kind: 'errored', error } as const;
    }
  })();

  const result = await Promise.race([timeoutPromise, innerPromise]);
  if (timer) clearTimeout(timer);
  return result;
}
