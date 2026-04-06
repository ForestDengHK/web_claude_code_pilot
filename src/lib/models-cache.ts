/**
 * Shared model cache — lives in lib/ so the same singleton is used
 * by both /api/models (reader) and /api/providers/.../activate (writer).
 *
 * Next.js App Router may bundle each route.ts into a separate chunk;
 * module-level variables inside route files are NOT guaranteed to share
 * the same instance.  Extracting the cache into lib/ avoids this pitfall.
 *
 * As an extra safety net the cache also tracks which provider ID it was
 * populated from.  Even if clearModelsCache() runs in a different module
 * instance (Turbopack dev), the GET handler will detect the mismatch and
 * bypass the stale cache.
 */

import { MODELS_CACHE_TTL as CACHE_TTL } from '@/lib/config';

export interface CachedModel {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

let cachedModels: CachedModel[] | null = null;
let cachedAt = 0;
let cachedProviderId: string | null = null;

/**
 * Return cached models if still fresh AND matching the given provider.
 * Pass `activeProviderId` (or null for default/env provider) so the cache
 * auto-invalidates when the active provider changes.
 */
export function getCachedModels(activeProviderId?: string | null): CachedModel[] | null {
  if (
    cachedModels &&
    Date.now() - cachedAt < CACHE_TTL &&
    cachedProviderId === (activeProviderId ?? null)
  ) {
    return cachedModels;
  }
  return null;
}

/** Store a fresh model list in the cache, tagged with the provider it came from. */
export function setCachedModels(models: CachedModel[], activeProviderId?: string | null): void {
  cachedModels = models;
  cachedAt = Date.now();
  cachedProviderId = activeProviderId ?? null;
}

/** Clear the cached model list (e.g. after switching providers). */
export function clearModelsCache(): void {
  cachedModels = null;
  cachedAt = 0;
  cachedProviderId = null;
}
