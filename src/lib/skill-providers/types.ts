import type { ComponentType, ReactNode } from 'react';

/**
 * Minimal common shape across backends. Backend-specific fields
 * (e.g. Codex brandColor, scope) live inside each provider's
 * ListComponent and are not part of this unified type.
 */
export interface UnifiedSkill {
  /** Stable within a provider (e.g. Codex path, Claude name). */
  id: string;
  name: string;
  description: string;
  enabled: boolean;
}

export interface SkillCapabilities {
  read: boolean;
  /** Phase 2 (not implemented yet). */
  enableToggle: boolean;
  /** Phase 3 (not implemented yet). */
  edit: boolean;
  /** Phase 3 (not implemented yet). */
  create: boolean;
}

export interface SkillProvider {
  id: string;
  label: string;
  icon?: ReactNode;
  capabilities: SkillCapabilities;
  /**
   * Probe — resolves to `true` when the provider can be used.
   * Must never throw; implementations should catch all errors internally.
   * Callers (see filter.ts) coerce throws to `false` as a safety net.
   */
  isAvailable: () => Promise<boolean>;
  /** Owns its own fetching, rendering, and error handling. */
  ListComponent: ComponentType;
}
