/**
 * Pure helper functions for git pull result parsing.
 * Extracted from the API route to be independently testable.
 */

/**
 * Parses stdout from `git pull --ff-only` to determine the outcome.
 * Returns 'up-to-date' if the repo was already current, 'pulled' otherwise.
 */
export function parseGitPullOutput(stdout: string): 'pulled' | 'up-to-date' {
  return stdout.trim().startsWith('Already up to date') ? 'up-to-date' : 'pulled';
}

/**
 * Produces a human-readable error message from git pull stderr.
 * Special-cases the fast-forward failure to give an actionable message.
 */
export function classifyGitPullError(stderr: string): string {
  if (stderr.includes('Not possible to fast-forward')) {
    return 'Branch has diverged — manual merge required';
  }
  const firstLine = stderr.split('\n').find(l => l.trim()) ?? '';
  if (!firstLine) return 'Pull failed';
  return firstLine.replace(/^(fatal|error): /, '');
}
