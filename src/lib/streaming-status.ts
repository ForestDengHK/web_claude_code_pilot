interface ToolInfo {
  name: string;
  input: unknown;
}

/**
 * Generate a human-readable one-liner describing what a tool is doing.
 * Used by both StreamingMessage (inline display) and the multi-session sidebar.
 */
export function getRunningCommandSummary(
  runningTools: ToolInfo[],
  allToolUses: ToolInfo[],
): string | undefined {
  if (runningTools.length === 0) {
    if (allToolUses.length > 0) return 'Generating response...';
    return undefined;
  }
  const tool = runningTools[runningTools.length - 1];
  const input = tool.input as Record<string, unknown>;
  if (tool.name === 'Bash' && input.command) {
    const cmd = String(input.command);
    return cmd.length > 80 ? cmd.slice(0, 80) + '...' : cmd;
  }
  if (input.file_path) return `${tool.name}: ${String(input.file_path)}`;
  if (input.path) return `${tool.name}: ${String(input.path)}`;
  return `Running ${tool.name}...`;
}

/**
 * Format a tool's input for display in the permission dialog. Picks the most
 * meaningful field, falling back to a JSON dump. Tolerates a missing input —
 * the Channels permission_request payload can lack a structured toolInput.
 */
export function formatToolInput(input: Record<string, unknown> | undefined | null): string {
  if (!input || typeof input !== 'object') return '';
  if (input.command) return String(input.command);
  if (input.file_path) return String(input.file_path);
  if (input.path) return String(input.path);
  return JSON.stringify(input, null, 2);
}
