import * as path from 'path';

const MAX_INPUT_LENGTH = 32_000;
const MAX_PATH_LENGTH = 1024;
const SESSION_ID_PATTERN = /^[0-9a-f-]{32,64}$/i;
const VALID_MODES = ['plan', 'code', 'ask'] as const;

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\x00/, reason: 'null byte' },
  { pattern: /\.\.[/\\]/, reason: 'path traversal (../)' },
  { pattern: /\$\(/, reason: 'command substitution $()' },
  { pattern: /`[^`]*`/, reason: 'backtick command substitution' },
  { pattern: /;\s*(rm|cat|curl|wget|chmod|chown|mv|cp|dd|mkfs|shutdown|reboot)\b/, reason: 'chained dangerous command' },
  { pattern: /\|\s*(bash|sh|zsh)\b/, reason: 'pipe to shell' },
  { pattern: />\s*\//, reason: 'redirect to absolute path' },
];

/**
 * Validate and normalize a working directory path.
 * Must be absolute, no traversal, no shell metacharacters, no null bytes, under MAX_PATH_LENGTH.
 * Returns normalized path or null if invalid.
 */
export function validateWorkingDirectory(rawPath: string): string | null {
  if (!rawPath || rawPath.length > MAX_PATH_LENGTH) {
    return null;
  }

  // Check for null bytes
  if (rawPath.includes('\x00')) {
    return null;
  }

  // Must be absolute
  if (!path.isAbsolute(rawPath)) {
    return null;
  }

  // Check for path traversal
  if (/\.\.[/\\]/.test(rawPath) || rawPath.endsWith('..')) {
    return null;
  }

  // Check for shell metacharacters
  if (/[;|&`$><()"'{}!#]/.test(rawPath)) {
    return null;
  }

  return path.normalize(rawPath);
}

/**
 * Validate a session ID matches the expected hex/UUID format.
 */
export function validateSessionId(id: string): boolean {
  return SESSION_ID_PATTERN.test(id);
}

/**
 * Check if input text contains dangerous patterns.
 */
export function isDangerousInput(text: string): { dangerous: boolean; reason?: string } {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(text)) {
      return { dangerous: true, reason };
    }
  }
  return { dangerous: false };
}

/**
 * Sanitize input text by stripping control characters (except \n and \t)
 * and truncating to MAX_INPUT_LENGTH.
 */
export function sanitizeInput(text: string): { text: string; truncated: boolean } {
  // Strip control characters except \n (0x0a) and \t (0x09)
  // eslint-disable-next-line no-control-regex
  const cleaned = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  const truncated = cleaned.length > MAX_INPUT_LENGTH;
  const result = truncated ? cleaned.slice(0, MAX_INPUT_LENGTH) : cleaned;

  return { text: result, truncated };
}

/**
 * Type guard to validate a mode string.
 */
export function validateMode(mode: string): mode is 'plan' | 'code' | 'ask' {
  return (VALID_MODES as readonly string[]).includes(mode);
}
