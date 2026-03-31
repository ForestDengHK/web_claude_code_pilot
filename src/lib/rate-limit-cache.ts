/**
 * Server-side cache for the latest Claude rate limit info.
 *
 * Rate limit events are emitted by the SDK during streaming. We store them
 * here so the /api/claude-usage endpoint can return them even when no stream
 * is active. Each rate limit type (five_hour, seven_day, etc.) is stored
 * separately since the SDK sends them as individual events.
 *
 * Staleness handling:
 * - Entries whose resetsAt has passed are discarded (the window already reset,
 *   so the old utilization number is meaningless).
 * - A capturedAt timestamp is included so the frontend can show "as of X ago".
 */

export interface CachedRateLimitInfo {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  overageResetsAt?: number;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  surpassedThreshold?: number;
  capturedAt: number; // ms timestamp when this was captured
}

const globalKey = '__rateLimitCache__' as const;

function getCache(): Map<string, CachedRateLimitInfo> {
  if (!(globalThis as Record<string, unknown>)[globalKey]) {
    (globalThis as Record<string, unknown>)[globalKey] = new Map<string, CachedRateLimitInfo>();
  }
  return (globalThis as Record<string, unknown>)[globalKey] as Map<string, CachedRateLimitInfo>;
}

/**
 * Store a rate limit event. Keyed by rateLimitType so we can track
 * multiple windows (five_hour, seven_day, overage, etc.) simultaneously.
 */
export function cacheRateLimit(info: Record<string, unknown>): void {
  const key = (info.rateLimitType as string) || 'default';
  getCache().set(key, {
    status: (info.status as CachedRateLimitInfo['status']) || 'allowed',
    resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined,
    rateLimitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
    utilization: typeof info.utilization === 'number' ? info.utilization : undefined,
    overageStatus: info.overageStatus as CachedRateLimitInfo['overageStatus'],
    overageResetsAt: typeof info.overageResetsAt === 'number' ? info.overageResetsAt : undefined,
    overageDisabledReason: typeof info.overageDisabledReason === 'string' ? info.overageDisabledReason : undefined,
    isUsingOverage: typeof info.isUsingOverage === 'boolean' ? info.isUsingOverage : undefined,
    surpassedThreshold: typeof info.surpassedThreshold === 'number' ? info.surpassedThreshold : undefined,
    capturedAt: Date.now(),
  });
}

/**
 * Get all cached rate limits, filtering out stale entries:
 * 1. Entries whose resetsAt has already passed (window reset → data meaningless)
 * 2. Entries older than maxAge as a safety net
 */
export function getCachedRateLimits(maxAgeMs = 2 * 60 * 60 * 1000): CachedRateLimitInfo[] {
  const cache = getCache();
  const nowMs = Date.now();
  const nowSec = nowMs / 1000;
  const results: CachedRateLimitInfo[] = [];

  for (const [key, info] of cache.entries()) {
    // If resetsAt is in the past, the rate-limit window has reset —
    // the old utilization % is no longer valid.
    if (info.resetsAt && info.resetsAt < nowSec) {
      cache.delete(key);
      continue;
    }
    // Safety net: discard anything older than maxAge (default 2h)
    if (nowMs - info.capturedAt > maxAgeMs) {
      cache.delete(key);
      continue;
    }
    results.push(info);
  }

  return results;
}
