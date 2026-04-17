import type { SkillProvider } from './types';

/**
 * Probes each provider's `isAvailable()` in parallel and returns
 * the subset that reported true. Throws from `isAvailable` are
 * treated as unavailable — the function itself never throws.
 * Input order is preserved.
 */
export async function resolveAvailableProviders(
  providers: readonly SkillProvider[],
): Promise<SkillProvider[]> {
  const flags = await Promise.all(
    providers.map(async (p) => {
      try {
        return await p.isAvailable();
      } catch {
        return false;
      }
    }),
  );
  return providers.filter((_, i) => flags[i]);
}
