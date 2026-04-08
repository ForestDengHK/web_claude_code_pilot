import type { TerminalProvider } from './provider.js';

export class ProviderRegistry {
  private readonly providers = new Map<string, TerminalProvider>();

  register(provider: TerminalProvider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider '${provider.id}' already registered`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: string): TerminalProvider | undefined {
    return this.providers.get(id);
  }

  list(): TerminalProvider[] {
    return Array.from(this.providers.values());
  }
}

/** Singleton registry — used by the WS server and the /api/terminal/config route. */
export const providerRegistry = new ProviderRegistry();
