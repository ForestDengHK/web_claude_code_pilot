/**
 * In-process MCP server exposing a `spawn_subagents` tool.
 *
 * The tool spawns N parallel forks of the current SDK session. Each fork
 * inherits the full conversation history (system prompt, prior tool calls,
 * decisions made) via the SDK's `forkSession: true` option, runs its
 * assigned prompt to completion, then returns the aggregated text to the
 * main agent as a tool result.
 *
 * This is CodePilot's headless-mode workaround for the
 * `CLAUDE_CODE_FORK_SUBAGENT=1` env-var feature, which the Claude Code
 * binary disables when `isInteractive === false` (i.e. all SDK callers).
 */

import { createSdkMcpServer, tool, query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

export interface SpawnSubagentsConfig {
  /**
   * Subset of the parent's SDK options that forks should inherit so
   * they run in the same workspace, against the same model/provider.
   */
  baseOptions: Pick<
    Options,
    'cwd' | 'model' | 'env' | 'pathToClaudeCodeExecutable' | 'settingSources' | 'plugins'
  >;
  /**
   * AbortController shared with the parent stream. When the parent is
   * aborted, all in-flight forks abort too.
   */
  abortController?: AbortController;
  /**
   * Per-fork max turns. Bounds runaway tool loops in any single fork.
   * Default: 15.
   */
  defaultMaxTurns?: number;
}

export interface SpawnSubagentsHandle {
  /** Pass this to `query({ options: { mcpServers: { ...this } } })`. */
  mcpServer: McpSdkServerConfigWithInstance;
  /**
   * Mutable reference. The caller MUST set `sessionRef.current` to the
   * parent SDK session_id as soon as the SDK init message arrives,
   * otherwise the tool will refuse to run (it has nothing to fork from).
   */
  sessionRef: { current: string | null };
}

/**
 * Tools considered safe to run in a forked subagent without surfacing
 * permission prompts to the user. Read-only and search-only tools.
 */
const READONLY_TOOL_PRESET = [
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'WebFetch',
  'WebSearch',
] as const;

const SPAWN_TOOL_DESCRIPTION = [
  'Spawn N subagents in parallel. Each subagent INHERITS THE FULL CONVERSATION CONTEXT of the current session (system prompt, files already read, prior analysis, decisions made), runs its assigned prompt to completion, and returns its final answer.',
  '',
  'WHEN TO USE',
  '- The user asks you to evaluate / explore / compare multiple independent alternatives.',
  '- You want to fan out and investigate several angles of a problem in parallel.',
  '- Each subtask benefits from the context already built up in this conversation (e.g. you have already read 1000 lines of code and want each subagent to reason about that code from a different angle).',
  '',
  'WHEN NOT TO USE',
  '- A subtask does not need the current context — use the regular Task tool, which spawns a fresh agent and is faster/cheaper.',
  '- Subtasks need to coordinate or share intermediate state — they cannot, each fork is isolated.',
  '- The work is sequential or has hard dependencies between steps.',
  '',
  'CONTRACT',
  '- Each prompt must be self-contained and ask for a concrete deliverable (a recommendation, a list, a draft, a review).',
  '- Up to 8 subagents per call. They run concurrently; total wall-clock ≈ slowest fork.',
  '- Returns markdown with one ## section per subagent, in input order.',
  '- Forks are READ-ONLY: they may use Read/Glob/Grep/NotebookRead/WebFetch/WebSearch but cannot Edit, Write, or run Bash. If you need a fork that modifies files, use the regular Task tool instead.',
].join('\n');

export function createSpawnSubagentsMcp(config: SpawnSubagentsConfig): SpawnSubagentsHandle {
  const sessionRef: { current: string | null } = { current: null };

  const spawnTool = tool(
    'spawn_subagents',
    SPAWN_TOOL_DESCRIPTION,
    {
      prompts: z
        .array(z.string().min(1))
        .min(1)
        .max(8)
        .describe(
          'Array of self-contained prompts; one subagent will be spawned per prompt. Maximum 8 subagents per call.'
        ),
    },
    async (args) => {
      const parentId = sessionRef.current;
      if (!parentId) {
        return {
          content: [
            {
              type: 'text',
              text: 'ERROR: cannot spawn subagents — parent SDK session_id has not been captured yet. The main session has not finished initialising. Try again on the next turn.',
            },
          ],
          isError: true,
        };
      }

      const forkTools: string[] = [...READONLY_TOOL_PRESET];
      const maxTurns = config.defaultMaxTurns ?? 15;

      const startTotal = Date.now();
      const results = await Promise.all(
        args.prompts.map(async (prompt, idx) => {
          const start = Date.now();
          let result: string | null = null;
          let resultSubtype: string | null = null;
          let errorMessage: string | null = null;

          try {
            for await (const msg of query({
              prompt,
              options: {
                ...config.baseOptions,
                resume: parentId,
                forkSession: true,
                maxTurns,
                tools: forkTools,
                // Forks have no UI to answer permission prompts. Bypass them;
                // safety is enforced by restricting `tools` to a read-only
                // preset above (no Edit/Write/Bash).
                permissionMode: 'bypassPermissions',
                abortController: config.abortController,
                // Don't leave fork session JSONL files lying around. The
                // fork's purpose is to compute a result and return it; its
                // transcript is not user-visible in CodePilot's chat list.
                persistSession: false,
                includePartialMessages: false,
              },
            })) {
              if (msg.type === 'result') {
                resultSubtype = msg.subtype;
                // `result` text is only present on the success branch of
                // SDKResultMessage; narrow the union before reading it.
                if (msg.subtype === 'success') {
                  result = msg.result;
                }
              }
            }
          } catch (err) {
            errorMessage = err instanceof Error ? err.message : String(err);
          }

          return {
            idx,
            elapsedMs: Date.now() - start,
            ok: !errorMessage && resultSubtype === 'success' && !!result && result.length > 0,
            result,
            subtype: resultSubtype,
            error: errorMessage,
          };
        })
      );

      const totalMs = Date.now() - startTotal;

      // Format aggregated markdown.
      const lines: string[] = [];
      lines.push(
        `# Subagent results (${args.prompts.length} parallel forks, total wall-clock ${(totalMs / 1000).toFixed(1)}s)`
      );

      for (const r of results) {
        const num = r.idx + 1;
        const elapsed = `${(r.elapsedMs / 1000).toFixed(1)}s`;
        if (r.error) {
          lines.push(`\n---\n\n## Subagent ${num} — failed (${elapsed})\n\n${r.error}`);
          continue;
        }
        if (!r.ok) {
          lines.push(
            `\n---\n\n## Subagent ${num} — incomplete (${elapsed}, subtype=${r.subtype ?? 'unknown'})\n\n${r.result || '(no text returned)'}`
          );
          continue;
        }
        lines.push(`\n---\n\n## Subagent ${num} (${elapsed})\n\n${r.result}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
    {
      // Don't gate behind ToolSearch — the model should see this tool in the
      // initial tool list so it can pick it up from natural-language fan-out
      // intents without an extra search round-trip.
      alwaysLoad: true,
    }
  );

  const mcpServer = createSdkMcpServer({
    name: 'codepilot-subagents',
    version: '1.0.0',
    tools: [spawnTool],
  });

  return { mcpServer, sessionRef };
}

/**
 * System-prompt fragment that teaches the main agent about spawn_subagents.
 *
 * Appended to the existing systemPrompt via the SDK's preset-append mode so
 * the rest of Claude Code's default prompt (skills, cwd awareness, etc.)
 * stays intact.
 */
export const SPAWN_SUBAGENTS_PROMPT_FRAGMENT = `

# Parallel context-inheriting subagents — \`mcp__codepilot-subagents__spawn_subagents\`

This tool spawns N parallel subagents which inherit the full conversation history of this session (every file you have read, every decision made, the system prompt — all of it). Each fork runs its prompt to completion and returns its final text. The tool returns a single aggregated markdown result.

## When to use it — STRONG TRIGGERS

If the user's request matches any of these patterns, you SHOULD prefer \`spawn_subagents\` over doing the work serially yourself:

- "evaluate / compare / explore N alternatives" — e.g. "compare three caching strategies"
- "in parallel" / "simultaneously" / "at the same time"
- Chinese: "并行" / "同时" / "三个角度" / "几个方向" / "对比 A 和 B 和 C"
- "from N angles / perspectives / aspects"
- Any prompt that lists 2+ independent things to analyse, design, or critique

When you call the tool, pass one prompt per alternative in the \`prompts\` array. Don't apologise; don't ask permission; don't first do one of the analyses inline. Just call the tool. Once it returns, write a short synthesis on top of the aggregated results.

## When NOT to use it

- The subtask doesn't need the current conversation's context — use the regular Task tool (fresh agent, cheaper, faster startup).
- The subtasks must coordinate or share intermediate state — forks are isolated.
- Sequential / dependent steps where step 2 needs step 1's output.
- Single-deliverable tasks (no fan-out needed).

## Cost note

Forks share the parent's prompt cache, so the per-fork token cost is much lower than a fresh agent. Wall-clock ≈ slowest fork, not sum.
`;
