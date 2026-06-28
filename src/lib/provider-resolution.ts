import { getProvider, getActiveProvider } from '@/lib/db';
import type { ApiProvider } from '@/types';

/** Lane key used for the official / no-third-party-provider path. */
export const DEFAULT_PROVIDER_KEY = 'default';

/**
 * Resolve the provider for one chat turn.
 * - explicit id (per-turn pick) → that provider
 * - otherwise → the globally active provider (back-compat)
 * - unknown/none → null provider, DEFAULT_PROVIDER_KEY
 */
export function resolveProvider(
  explicitId: string | undefined | null,
): { provider: ApiProvider | null; key: string } {
  let provider: ApiProvider | null = null;
  if (explicitId) provider = getProvider(explicitId) ?? null;
  if (!provider && !explicitId) provider = getActiveProvider() ?? null;
  return { provider, key: provider?.id ?? DEFAULT_PROVIDER_KEY };
}
