import type { ApiProvider } from '@/types';

/**
 * Inject an API provider's auth/base_url/extra_env into a spawn environment.
 * Single source of truth shared by T2 (claude-client.ts) and T1 (session-manager.ts).
 * No-op when `provider` is null or has no api_key (caller keeps its default auth).
 */
export function applyProviderEnv(
  env: Record<string, string>,
  provider: ApiProvider | null,
): Record<string, string> {
  if (!provider || !provider.api_key) return env;

  // Clear all existing ANTHROPIC_* vars to prevent conflicts with the provider's config.
  for (const key of Object.keys(env)) {
    if (key.startsWith('ANTHROPIC_')) delete env[key];
  }

  // Set both token variants; extra_env can clear the unwanted one with an empty string.
  env.ANTHROPIC_AUTH_TOKEN = provider.api_key;
  env.ANTHROPIC_API_KEY = provider.api_key;
  if (provider.base_url) env.ANTHROPIC_BASE_URL = provider.base_url;

  try {
    const extraEnv = JSON.parse(provider.extra_env || '{}');
    for (const [key, value] of Object.entries(extraEnv)) {
      if (typeof value === 'string') {
        if (value === '') delete env[key];
        else env[key] = value;
      }
    }
  } catch {
    // ignore malformed extra_env
  }
  return env;
}
