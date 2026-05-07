/**
 * Core streaming client for the Codex App Server integration.
 *
 * Mirrors `streamClaude()` — returns a `ReadableStream<string>` of SSE-formatted
 * lines. Internally communicates with a `codex app-server` subprocess via JSON-RPC
 * over stdio, translating Codex events into the same SSE event format the frontend
 * already understands.
 */

import type {
  SSEEvent,
  FileAttachment,
  PermissionRequestEvent,
  CodexReviewFinding,
} from '@/types';
import {
  formatJsonRpcRequest,
  formatJsonRpcResponse,
  getLastRequestId,
  type JsonRpcMessage,
} from '@/lib/codex-jsonrpc';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { CodexProcessManager, type CodexProcess } from '@/lib/codex-process-manager';
import { registerPendingCodexApproval } from '@/lib/codex-approval-registry';
import { updateCodexThreadId, getSession, getProjectAdditionalDirectories } from '@/lib/db';
import { sendPushNotification } from './push-notifications';
import type { AskForApproval } from '@/types/codex/AskForApproval';
import type { SandboxMode } from '@/types/codex/v2/SandboxMode';
import type { SandboxPolicy } from '@/types/codex/v2/SandboxPolicy';
import type { SandboxWorkspaceWrite } from '@/types/codex/v2/SandboxWorkspaceWrite';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Skill reference resolved by the frontend from `$skill-name` in user input. */
export interface CodexSkillRef {
  name: string;
  path: string;
}

export interface CodexStreamOptions {
  prompt: string;
  sessionId: string;
  codexThreadId?: string;
  model?: string;
  workingDirectory?: string;
  abortController?: AbortController;
  files?: FileAttachment[];
  contextBridgePrompt?: string;
  /** Reasoning effort override (e.g. "low", "medium", "high", "xhigh"). */
  effort?: string;
  /** Reasoning summary style: "auto", "concise", "detailed", "none". */
  summary?: string;
  /** Codex skills resolved from `$skill-name` references in the prompt. */
  skills?: CodexSkillRef[];
  /** Mirrors the existing shield toggle UI; true maps to approvalPolicy "never". */
  skipPermissions?: boolean;
  /**
   * Explicit approval_policy from the UI's working-mode dropdown. Wins over
   * the configured / thread-level values (unless shield is on, which forces
   * 'never'). Omit to preserve the legacy "inherit from Codex config" path.
   */
  approvalPolicy?: AskForApproval;
  /**
   * When set, calls `thread/goal/set` against the active thread before
   * starting the turn. The objective is the bare goal text (no `/goal`
   * prefix). Requires `[features].goals = true` in `~/.codex/config.toml`
   * and the `experimentalApi` capability declared at initialize time.
   */
  goalObjective?: string;
}

export interface CodexReviewResult {
  review: string;
  reviewThreadId: string;
  delivery: 'inline' | 'detached';
  findings: CodexReviewFinding[];
  overallCorrectness?: string;
  overallExplanation?: string;
  overallConfidenceScore?: number;
}

/** Codex goal lifecycle state. Mirrors `thread/goal/get` response. */
export interface CodexGoal {
  threadId: string;
  objective: string;
  status: 'active' | 'paused' | 'budget_limited' | 'complete';
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt?: number;
  updatedAt?: number;
}

// Codex app-server UserInput union (v2 protocol)
type CodexUserInput =
  | { type: 'text'; text: string; text_elements?: unknown[] }
  | { type: 'skill'; name: string; path: string }
  | { type: 'localImage'; path: string };

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)$/i;

function isImageAttachment(file: FileAttachment): boolean {
  if (file.type?.startsWith('image/')) return true;
  // Path refs carry the original filename; sniff by extension.
  if (file.type === 'text/x-file-ref' && file.name && IMAGE_EXT_RE.test(file.name)) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatSSE(event: SSEEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function generateApprovalId(): string {
  return `codex-approval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function sendJsonRpcRequest<T extends Record<string, unknown>>(
  codexProcess: CodexProcess,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 30_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = formatJsonRpcRequest(method, params);
    const requestId = getLastRequestId();

    const timeout = setTimeout(() => {
      codexProcess.offMessage(handler);
      reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    const handler = (msg: JsonRpcMessage) => {
      if (msg.type !== 'response' || msg.id !== requestId) return;

      clearTimeout(timeout);
      codexProcess.offMessage(handler);

      if (msg.error) {
        reject(new Error(`${method} failed: ${msg.error.message}`));
        return;
      }

      resolve((msg.result ?? {}) as T);
    };

    codexProcess.onMessage(handler);
    codexProcess.send(request);
  });
}

async function readConfiguredApprovalPolicy(
  codexProcess: CodexProcess,
  cwd?: string,
): Promise<{
  approvalPolicy: AskForApproval | null;
  sandboxMode: SandboxMode | null;
  sandboxWorkspaceWrite: SandboxWorkspaceWrite | null;
}> {
  const result = await sendJsonRpcRequest<{
    config?: {
      approval_policy?: AskForApproval | null;
      sandbox_mode?: SandboxMode | null;
      sandbox_workspace_write?: SandboxWorkspaceWrite | null;
    };
  }>(
    codexProcess,
    'config/read',
    {
      includeLayers: false,
      ...(cwd ? { cwd } : {}),
    },
  );

  return {
    approvalPolicy: result.config?.approval_policy ?? null,
    sandboxMode: result.config?.sandbox_mode ?? null,
    sandboxWorkspaceWrite: result.config?.sandbox_workspace_write ?? null,
  };
}

export function resolveDesiredApprovalPolicy(
  skipPermissions: boolean,
  configuredApprovalPolicy: AskForApproval | null,
  currentThreadApprovalPolicy?: AskForApproval | null,
  /**
   * Explicit UI selection from the Codex mode dropdown. Wins over config/
   * thread values so the user's active choice isn't silently overridden by a
   * `~/.codex/config.toml` setting. Shield still takes precedence over this.
   */
  explicitApprovalPolicy?: AskForApproval,
): AskForApproval | undefined {
  if (skipPermissions) {
    return 'never';
  }

  // Honor the UI's active selection first. We still guard against 'never'
  // leaking through here — `never` is the shield's exclusive territory.
  if (explicitApprovalPolicy && explicitApprovalPolicy !== 'never') {
    return explicitApprovalPolicy;
  }

  if (configuredApprovalPolicy && configuredApprovalPolicy !== 'never') {
    return configuredApprovalPolicy;
  }

  if (currentThreadApprovalPolicy && currentThreadApprovalPolicy !== 'never') {
    return currentThreadApprovalPolicy;
  }

  // Shield OFF means "stay interactive". `untrusted` is stricter than
  // `on-request` and consistently asks before mutating shell commands.
  return 'untrusted';
}

function sandboxPolicyToMode(sandboxPolicy?: SandboxPolicy | null): SandboxMode | null {
  switch (sandboxPolicy?.type) {
    case 'dangerFullAccess':
      return 'danger-full-access';
    case 'workspaceWrite':
      return 'workspace-write';
    case 'readOnly':
      return 'read-only';
    default:
      return null;
  }
}

export function resolveDesiredSandboxMode(
  skipPermissions: boolean,
  configuredSandboxMode: SandboxMode | null,
  currentThreadSandboxMode?: SandboxMode | null,
): SandboxMode | undefined {
  if (skipPermissions) {
    return configuredSandboxMode ?? currentThreadSandboxMode ?? undefined;
  }

  if (configuredSandboxMode && configuredSandboxMode !== 'danger-full-access') {
    return configuredSandboxMode;
  }

  if (currentThreadSandboxMode && currentThreadSandboxMode !== 'danger-full-access') {
    return currentThreadSandboxMode;
  }

  // Shield OFF should never silently inherit full-access execution.
  return 'workspace-write';
}

export function buildSandboxPolicy(
  sandboxMode: SandboxMode | undefined,
  workingDirectory?: string,
  sandboxWorkspaceWrite?: SandboxWorkspaceWrite | null,
): SandboxPolicy | undefined {
  if (!sandboxMode) return undefined;

  if (sandboxMode === 'danger-full-access') {
    return { type: 'dangerFullAccess' };
  }

  if (sandboxMode === 'read-only') {
    return {
      type: 'readOnly',
      access: { type: 'fullAccess' },
    };
  }

  if (!workingDirectory) return undefined;

  const writableRoots = Array.from(new Set([
    workingDirectory,
    ...(sandboxWorkspaceWrite?.writable_roots ?? []),
  ]));

  return {
    type: 'workspaceWrite',
    writableRoots,
    readOnlyAccess: { type: 'fullAccess' },
    networkAccess: sandboxWorkspaceWrite?.network_access ?? false,
    excludeTmpdirEnvVar: sandboxWorkspaceWrite?.exclude_tmpdir_env_var ?? false,
    excludeSlashTmp: sandboxWorkspaceWrite?.exclude_slash_tmp ?? false,
  };
}

/**
 * Build UserInput[] from prompt, optional context bridge prompt, file refs,
 * and Codex skill references.
 *
 * Skill refs (`$skill-name`) are extracted and sent as structured
 * `{ type: 'skill', name, path }` items so the Codex app-server loads
 * the skill's SKILL.md content into the agent's context.
 */
function buildUserInputs(
  prompt: string,
  contextBridgePrompt?: string,
  files?: FileAttachment[],
  skills?: CodexSkillRef[],
): CodexUserInput[] {
  const inputs: CodexUserInput[] = [];

  // Context bridge prompt first (provides Claude conversation context)
  if (contextBridgePrompt) {
    inputs.push({ type: 'text', text: contextBridgePrompt });
  }

  // Codex skill references — emitted before the text prompt so the
  // app-server injects skill instructions into context first.
  if (skills && skills.length > 0) {
    for (const skill of skills) {
      inputs.push({ type: 'skill', name: skill.name, path: skill.path });
    }
  }

  // File references
  if (files && files.length > 0) {
    const PATH_REF_TYPES = new Set(['text/x-directory-ref', 'text/x-file-ref']);
    const references: string[] = [];

    for (const file of files) {
      // Images go in as native localImage inputs so the model actually
      // perceives them as images (not just a path string in a prompt).
      if (isImageAttachment(file) && file.filePath) {
        inputs.push({ type: 'localImage', path: file.filePath });
        continue;
      }

      if (PATH_REF_TYPES.has(file.type)) {
        const originalPath = file.filePath || '';
        if (file.type === 'text/x-directory-ref') {
          references.push(`Directory: ${originalPath}`);
        } else {
          references.push(`File: ${originalPath}`);
        }
      } else if (file.filePath) {
        references.push(`File: ${file.filePath} (${file.name})`);
      }
    }

    if (references.length > 0) {
      inputs.push({
        type: 'text',
        text: `The user has attached the following files/directories for context:\n\n${references.join('\n')}`,
      });
    }
  }

  // Main user prompt
  inputs.push({ type: 'text', text: prompt });

  return inputs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readTokenSnapshot(raw: Record<string, unknown>): CodexTokenSnapshot {
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    inputTokens: num(raw.inputTokens),
    outputTokens: num(raw.outputTokens),
    cachedInputTokens: num(raw.cachedInputTokens),
    reasoningOutputTokens: num(raw.reasoningOutputTokens),
    totalTokens: num(raw.totalTokens),
  };
}

function extractTurnId(value: unknown): string | null {
  if (!isRecord(value)) return null;

  const nestedTurn = isRecord(value.turn) ? value.turn : null;
  if (nestedTurn && typeof nestedTurn.id === 'string') {
    return nestedTurn.id;
  }

  if (typeof value.turnId === 'string') {
    return value.turnId;
  }

  return typeof value.id === 'string' ? value.id : null;
}

function normalizeReviewFinding(value: unknown): CodexReviewFinding | null {
  if (!isRecord(value)) return null;

  const title = typeof value.title === 'string' ? value.title : null;
  const body = typeof value.body === 'string' ? value.body : null;
  const confidenceScore = typeof value.confidence_score === 'number' ? value.confidence_score : null;
  const priority = typeof value.priority === 'number' ? value.priority : null;
  const location = isRecord(value.code_location) ? value.code_location : null;
  const absoluteFilePath = location && typeof location.absolute_file_path === 'string'
    ? location.absolute_file_path
    : null;
  const lineRange = location && isRecord(location.line_range) ? location.line_range : null;
  const start = lineRange && typeof lineRange.start === 'number' ? lineRange.start : null;
  const end = lineRange && typeof lineRange.end === 'number' ? lineRange.end : null;

  if (
    title === null ||
    body === null ||
    confidenceScore === null ||
    priority === null ||
    absoluteFilePath === null ||
    start === null ||
    end === null
  ) {
    return null;
  }

  return {
    title,
    body,
    confidence_score: confidenceScore,
    priority,
    code_location: {
      absolute_file_path: absoluteFilePath,
      line_range: { start, end },
    },
  };
}

function extractStructuredReviewOutput(reviewOutput: Record<string, unknown>): Omit<CodexReviewResult, 'reviewThreadId' | 'delivery' | 'review'> {
  const findings = Array.isArray(reviewOutput.findings)
    ? reviewOutput.findings.map(normalizeReviewFinding).filter((finding): finding is CodexReviewFinding => finding !== null)
    : [];

  const overallCorrectness = typeof reviewOutput.overall_correctness === 'string'
    ? reviewOutput.overall_correctness
    : undefined;
  const overallExplanation = typeof reviewOutput.overall_explanation === 'string'
    ? reviewOutput.overall_explanation
    : undefined;
  const overallConfidenceScore = typeof reviewOutput.overall_confidence_score === 'number'
    ? reviewOutput.overall_confidence_score
    : undefined;

  return {
    findings,
    ...(overallCorrectness ? { overallCorrectness } : {}),
    ...(overallExplanation ? { overallExplanation } : {}),
    ...(overallConfidenceScore !== undefined ? { overallConfidenceScore } : {}),
  };
}

function formatReviewOutput(reviewOutput: Record<string, unknown>): string {
  const sections: string[] = [];
  const structuredOutput = extractStructuredReviewOutput(reviewOutput);
  const findings = structuredOutput.findings;

  if (findings.length === 0) {
    sections.push('No findings.');
  } else {
    sections.push('## Findings');
    for (const finding of findings) {
      const title = finding.title || 'Finding';
      const body = finding.body || '';
      const priority = `P${finding.priority}`;
      const confidence = typeof finding.confidence_score === 'number'
        ? `Confidence: ${finding.confidence_score.toFixed(2)}`
        : null;
      const absolutePath = finding.code_location.absolute_file_path;
      const startLine = finding.code_location.line_range.start;
      const endLine = finding.code_location.line_range.end;
      const lineSuffix = startLine === null
        ? ''
        : endLine && endLine !== startLine
          ? `:${startLine}-${endLine}`
          : `:${startLine}`;

      sections.push(`### ${title}`);
      if (body) sections.push(body);
      if (absolutePath) sections.push(`Location: \`${absolutePath}${lineSuffix}\``);

      const meta = [priority, confidence].filter(Boolean).join(' | ');
      if (meta) sections.push(meta);
    }
  }

  const overallCorrectness = structuredOutput.overallCorrectness ?? null;
  const overallExplanation = structuredOutput.overallExplanation ?? null;
  const overallConfidence = typeof structuredOutput.overallConfidenceScore === 'number'
    ? structuredOutput.overallConfidenceScore.toFixed(2)
    : null;

  if (overallCorrectness || overallExplanation || overallConfidence) {
    sections.push('## Overall');
    if (overallCorrectness) sections.push(`Correctness: ${overallCorrectness}`);
    if (overallExplanation) sections.push(overallExplanation);
    if (overallConfidence) sections.push(`Confidence: ${overallConfidence}`);
  }

  return sections.join('\n\n').trim();
}

function extractReviewTextFromItem(item: Record<string, unknown>): string | null {
  const itemType = item.type;
  if (itemType !== 'exitedReviewMode' && itemType !== 'ExitedReviewMode') {
    return null;
  }

  if (typeof item.review === 'string' && item.review.trim()) {
    return item.review;
  }

  if (isRecord(item.review_output)) {
    return formatReviewOutput(item.review_output);
  }

  return null;
}

function extractAgentMessageTextFromItem(item: Record<string, unknown>): string | null {
  const itemType = item.type;
  if (
    itemType !== 'agentMessage' &&
    itemType !== 'AgentMessage' &&
    itemType !== 'message' &&
    itemType !== 'Message'
  ) {
    return null;
  }

  if (!Array.isArray(item.content)) {
    return null;
  }

  const parts = item.content
    .map((part) => {
      if (!isRecord(part)) return '';
      if (part.type === 'Text' && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter((part) => part.length > 0);

  return parts.length > 0 ? parts.join('') : null;
}

function normalizeReviewResult(review: string): { review: string } | { error: string } {
  const normalizedReview = review.trim();
  if (!normalizedReview) {
    return { error: 'Reviewer failed to output a response.' };
  }

  if (/review was interrupted/i.test(normalizedReview)) {
    return { error: 'Codex review was interrupted' };
  }

  if (/failed to output a response/i.test(normalizedReview)) {
    return { error: 'Reviewer failed to output a response.' };
  }

  return { review: normalizedReview };
}

// ---------------------------------------------------------------------------
// Main streaming function
// ---------------------------------------------------------------------------

/**
 * Synthetic stream for `/goal` and `/goal clear` sub-commands. Skips the
 * model turn entirely — just calls the relevant `thread/goal/*` JSON-RPC
 * method and emits the result as SSE: a status event so the badge updates,
 * a text block with the human-readable response, then result/done. The
 * route's existing tee+persist captures it as a regular assistant message.
 */
export function streamCodexGoalAction(options: {
  sessionId: string;
  codexThreadId: string | undefined;
  action: 'status' | 'clear';
}): ReadableStream<string> {
  const { sessionId, codexThreadId, action } = options;
  return new ReadableStream<string>({
    async start(controller) {
      const closeWith = (text: string, isError = false) => {
        controller.enqueue(formatSSE({
          type: isError ? 'error' : 'text',
          data: text,
        }));
        controller.enqueue(formatSSE({
          type: 'result',
          data: JSON.stringify({ subtype: isError ? 'error' : 'success' }),
        }));
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      };

      if (!codexThreadId) {
        closeWith(action === 'clear'
          ? 'No goal to clear — this chat has no Codex thread yet. Type `/goal <objective>` to start one.'
          : 'No active goal yet. Type `/goal <objective>` to start one.');
        return;
      }

      try {
        const proc = await CodexProcessManager.getOrCreate(sessionId);
        const method = action === 'clear' ? 'thread/goal/clear' : 'thread/goal/get';
        const result = await sendJsonRpcRequest<{ goal: CodexGoal | null }>(
          proc,
          method,
          { threadId: codexThreadId },
          15_000,
        );

        // Push a status event so the chat badge reflects the new state
        // immediately (clear → null, status → current goal).
        controller.enqueue(formatSSE({
          type: 'status',
          data: JSON.stringify({
            kind: 'goal',
            goal: action === 'clear' ? null : (result.goal ?? null),
          }),
        }));

        // Format the human-readable response.
        if (action === 'clear') {
          if (result.goal) {
            closeWith(`Goal cleared.\n\n_Previous objective: ${result.goal.objective}_`);
          } else {
            closeWith('No goal was set on this thread.');
          }
        } else {
          // status query
          if (!result.goal) {
            closeWith('No active goal on this thread.\n\nStart one with `/goal <objective>`.');
          } else {
            const g = result.goal;
            const minutes = Math.floor(g.timeUsedSeconds / 60);
            const seconds = g.timeUsedSeconds % 60;
            const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
            const tokensStr = g.tokenBudget != null
              ? `${g.tokensUsed.toLocaleString()} / ${g.tokenBudget.toLocaleString()}`
              : g.tokensUsed.toLocaleString();
            closeWith(
              `**Goal: ${g.status}**\n\n` +
              `**Objective:** ${g.objective}\n\n` +
              `**Tokens used:** ${tokensStr}\n` +
              `**Time used:** ${timeStr}`
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown error';
        closeWith(
          `Goal command failed: ${message}\n\n_If this says "goals feature is disabled," ` +
          `add \`[features]\\ngoals = true\` to ~/.codex/config.toml._`,
          true,
        );
      }
    },
  });
}

/**
 * Query the current `/goal` state for a thread. Returns null if no goal,
 * the goals feature is disabled in Codex config, or the thread isn't loaded.
 *
 * Used by `/api/codex/goal` so the chat header badge restores on page reload
 * (the in-memory `activeGoal` state is otherwise lost between SSE streams).
 */
export async function queryCodexGoal(
  sessionId: string,
  threadId: string,
): Promise<CodexGoal | null> {
  try {
    const proc = await CodexProcessManager.getOrCreate(sessionId);
    const result = await sendJsonRpcRequest<{ goal: CodexGoal | null }>(
      proc,
      'thread/goal/get',
      { threadId },
      10_000,
    );
    return result.goal ?? null;
  } catch {
    // feature disabled, capability missing, thread not loaded, or process
    // not initialized — surface as "no goal" rather than an error.
    return null;
  }
}

export function streamCodex(options: CodexStreamOptions): ReadableStream<string> {
  const {
    prompt,
    sessionId,
    codexThreadId,
    model,
    workingDirectory,
    abortController,
    files,
    contextBridgePrompt,
    effort,
    summary,
    skills,
    skipPermissions = false,
    approvalPolicy: explicitApprovalPolicy,
    goalObjective,
  } = options;
  const requestedEffort = effort || 'high';
  const isMiniModel = model ? /mini/i.test(model) : false;
  const resolvedEffort = isMiniModel && requestedEffort === 'xhigh' ? 'high' : requestedEffort;

  let heartbeatInterval: ReturnType<typeof setInterval>;

  return new ReadableStream<string>({
    async start(controller) {
      let codexProcess: CodexProcess | null = null;
      let messageHandler: ((msg: JsonRpcMessage) => void) | null = null;
      let goalEventHandler: ((msg: JsonRpcMessage) => void) | null = null;
      let exitHandler: ((error?: Error) => void) | null = null;
      let abortListener: (() => void) | null = null;

      // Multi-turn goal mode: when a goal is active on the thread, Codex
      // auto-fires continuation turns (the article's "runtime continuation")
      // until status hits `complete` (or user clears it). We keep the SSE
      // stream open across those turns so the chat captures every continuation.
      // turnState lives in this outer scope so the goal handler (which fires
      // between turns) can read whether a turn is currently running.
      const turnState = { activeTurnId: null as string | null };
      let goalIsActive = false;
      let tryResolveOuter: (() => void) | null = null;

      // Heartbeat: send periodic keepalive so the client can detect dead connections
      heartbeatInterval = setInterval(() => {
        try {
          controller.enqueue(formatSSE({ type: 'heartbeat', data: '' }));
        } catch {
          clearInterval(heartbeatInterval);
        }
      }, 10_000);

      try {
        // 1. Get or spawn the app-server process
        codexProcess = await CodexProcessManager.getOrCreate(sessionId);

        let configuredApprovalPolicy: AskForApproval | null = null;
        let configuredSandboxMode: SandboxMode | null = null;
        let configuredSandboxWorkspaceWrite: SandboxWorkspaceWrite | null = null;
        try {
          const configuredExecution = await readConfiguredApprovalPolicy(
            codexProcess,
            workingDirectory,
          );
          configuredApprovalPolicy = configuredExecution.approvalPolicy;
          configuredSandboxMode = configuredExecution.sandboxMode;
          configuredSandboxWorkspaceWrite = configuredExecution.sandboxWorkspaceWrite;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown config/read error';
          console.warn(`[codex-client] config/read failed, falling back to safe execution defaults: ${message}`);
        }

        // Determine the thread ID to use
        let threadId = codexProcess.threadId || codexThreadId || null;
        const isNewThread = !threadId;
        const isResumedThread = !!threadId && !codexProcess.threadId;
        let currentApprovalPolicy: AskForApproval | null = null;
        let currentSandboxMode: SandboxMode | null = null;

        // 2. Thread lifecycle: start or resume
        if (isNewThread) {
          // Start a new thread
          const desiredApprovalPolicy = resolveDesiredApprovalPolicy(
            skipPermissions,
            configuredApprovalPolicy,
            undefined,
            explicitApprovalPolicy,
          );
          const desiredSandboxMode = resolveDesiredSandboxMode(
            skipPermissions,
            configuredSandboxMode,
          );
          const startedThread = await startThread(
            codexProcess,
            sessionId,
            model,
            workingDirectory,
            effort,
            desiredApprovalPolicy,
            desiredSandboxMode,
          );
          threadId = startedThread.threadId;
          currentApprovalPolicy = startedThread.approvalPolicy;
          currentSandboxMode = startedThread.sandboxMode;
        } else if (isResumedThread && threadId) {
          // Resume an existing thread on a new process
          const desiredApprovalPolicy = resolveDesiredApprovalPolicy(
            skipPermissions,
            configuredApprovalPolicy,
            undefined,
            explicitApprovalPolicy,
          );
          const desiredSandboxMode = resolveDesiredSandboxMode(
            skipPermissions,
            configuredSandboxMode,
          );
          const resumedThread = await resumeThread(
            codexProcess,
            threadId,
            desiredApprovalPolicy,
            desiredSandboxMode,
            workingDirectory,
            model,
          );
          codexProcess.threadId = threadId;
          currentApprovalPolicy = resumedThread.approvalPolicy;
          currentSandboxMode = resumedThread.sandboxMode;
        }

        if (!threadId) {
          throw new Error('Failed to obtain Codex thread ID');
        }

        // Subscribe to goal lifecycle notifications BEFORE goal/set so we
        // don't race the initial `thread/goal/updated`. The handler updates
        // `goalIsActive` and forwards each goal state to the client (so the
        // UI can render a "Goal: active/complete/paused" badge).
        goalEventHandler = (msg: JsonRpcMessage) => {
          if (msg.type !== 'notification') return;
          if (msg.method === 'thread/goal/updated') {
            const params = msg.params as { goal?: { status?: string } } | undefined;
            const goal = params?.goal;
            if (goal && typeof goal.status === 'string') {
              goalIsActive = goal.status === 'active';
              try {
                controller.enqueue(formatSSE({
                  type: 'status',
                  data: JSON.stringify({ kind: 'goal', goal }),
                }));
              } catch {
                // controller closed — ignore
              }
              if (!goalIsActive && tryResolveOuter) tryResolveOuter();
            }
          } else if (msg.method === 'thread/goal/cleared') {
            goalIsActive = false;
            try {
              controller.enqueue(formatSSE({
                type: 'status',
                data: JSON.stringify({ kind: 'goal', goal: null }),
              }));
            } catch {
              // controller closed — ignore
            }
            if (tryResolveOuter) tryResolveOuter();
          }
        };
        codexProcess.onMessage(goalEventHandler);

        // Probe existing goal state on the thread (a resumed thread may
        // already have an active goal, or `goalObjective` may have been set
        // by a previous request). Failing here is fine — most likely the
        // [features].goals flag is off, in which case the rest of the flow
        // continues normally without goal tracking.
        try {
          const existing = await sendJsonRpcRequest<{
            goal?: { status?: string } | null;
          }>(codexProcess, 'thread/goal/get', { threadId });
          if (existing.goal && typeof existing.goal.status === 'string') {
            goalIsActive = existing.goal.status === 'active';
            controller.enqueue(formatSSE({
              type: 'status',
              data: JSON.stringify({ kind: 'goal', goal: existing.goal }),
            }));
          }
        } catch {
          // goals feature disabled or unavailable — silent skip
        }

        // Set / replace the persisted goal before the turn fires. Codex's
        // goal subsystem then tracks the turn against this objective and
        // emits `thread/goal/updated` notifications on state changes.
        if (goalObjective && goalObjective.trim()) {
          try {
            await sendJsonRpcRequest(codexProcess, 'thread/goal/set', {
              threadId,
              objective: goalObjective.trim(),
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'unknown error';
            // Surface the failure via SSE so the user sees why the goal
            // didn't activate (most common: `[features].goals = true` missing).
            controller.enqueue(formatSSE({
              type: 'error',
              data: `Codex /goal failed: ${message}. Add "[features]\\ngoals = true" to ~/.codex/config.toml.`,
            }));
          }
        }

        const desiredApprovalPolicy = resolveDesiredApprovalPolicy(
          skipPermissions,
          configuredApprovalPolicy,
          currentApprovalPolicy,
          explicitApprovalPolicy,
        );
        const desiredSandboxMode = resolveDesiredSandboxMode(
          skipPermissions,
          configuredSandboxMode,
          currentSandboxMode,
        );
        const desiredSandboxPolicy = buildSandboxPolicy(
          desiredSandboxMode,
          workingDirectory,
          desiredSandboxMode === 'workspace-write' && configuredSandboxMode === 'workspace-write'
            ? configuredSandboxWorkspaceWrite
            : null,
        );

        // Project-level additional directories (set via Project Settings UI):
        // for workspace-write sandbox these need to be writable so Codex can
        // read AND write into linked projects, matching the Claude side.
        // read-only / danger-full-access modes don't need this — both already
        // grant full read access (and danger mode bypasses sandbox entirely).
        if (desiredSandboxPolicy?.type === 'workspaceWrite') {
          const projectAddlDirs = getProjectAdditionalDirectories(workingDirectory);
          if (projectAddlDirs.length > 0) {
            desiredSandboxPolicy.writableRoots = Array.from(new Set([
              ...desiredSandboxPolicy.writableRoots,
              ...projectAddlDirs,
            ]));
          }
        }

        // 3. Build user inputs
        const userInputs = buildUserInputs(prompt, contextBridgePrompt, files, skills);

        // 4. Set up abort handling
        if (abortController) {
          abortListener = () => {
            CodexProcessManager.interrupt(sessionId);
          };

          if (abortController.signal.aborted) {
            abortListener();
          } else {
            abortController.signal.addEventListener('abort', abortListener, { once: true });
          }
        }

        // 5. Send turn/start and listen for events
        await new Promise<void>((resolve, reject) => {
          if (!codexProcess || !threadId) {
            reject(new Error('No Codex process or thread ID'));
            return;
          }

          // Send turn/start
          const turnStartParams: Record<string, unknown> = {
            threadId,
            input: userInputs,
          };
          if (workingDirectory) turnStartParams.cwd = workingDirectory;
          turnStartParams.approvalPolicy = desiredApprovalPolicy;
          if (desiredSandboxPolicy) turnStartParams.sandboxPolicy = desiredSandboxPolicy;
          if (model) turnStartParams.model = model;
          // Always send reasoning effort to override ~/.codex/config.toml global default.
          // Schema field name is "effort" (NOT "modelReasoningEffort" — that was wrong).
          turnStartParams.effort = resolvedEffort;
          // Reasoning summary: mini only supports 'detailed'; others default to 'concise'
          {
            const isMini = model && /mini/i.test(model);
            turnStartParams.summary = isMini ? 'detailed' : (summary || 'concise');
          }

          const turnStartRequest = formatJsonRpcRequest('turn/start', turnStartParams);
          const turnStartRequestId = getLastRequestId();

          // Track whether the new codex/event/* protocol is active for this turn.
          // When active, skip old item/reasoning/summaryTextDelta to avoid duplicate thinking.
          // Per-turn flag (not module-level) so switching models works correctly.
          // tokenUsage tracks per-turn delta: Codex 0.125 emits cumulative totals via
          // `thread/tokenUsage/updated`; baseline captures pre-turn snapshot from
          // (firstEvent.total - firstEvent.last) and we diff at turn/completed.
          const turnCtx: CodexTurnCtx = {
            useNewReasoningProtocol: false,
            tokenUsage: { baseline: null, latest: null, contextWindow: null },
            turnStartedAt: Date.now(),
          };
          // turnState.activeTurnId lives in the outer scope so goalEventHandler
          // can read it between turns. Read/write through the shared object.
          const rememberTurnId = (nextTurnId: string | null) => {
            if (!nextTurnId || !codexProcess) return;
            turnState.activeTurnId = nextTurnId;
            codexProcess.currentTurnId = nextTurnId;
            CodexProcessManager.flushPendingInterrupt(codexProcess);
          };

          const clearActiveTurn = () => {
            if (!codexProcess) return;
            if (!turnState.activeTurnId || codexProcess.currentTurnId === turnState.activeTurnId) {
              codexProcess.currentTurnId = null;
            }
            codexProcess.interruptRequested = false;
            turnState.activeTurnId = null;
          };

          // Resolve only when no turn is running AND no goal is active. In
          // single-turn (legacy) mode goalIsActive stays false, so this fires
          // immediately after turn/completed — same behavior as before.
          // In goal mode it gates close on goal status flipping to terminal.
          const tryResolve = () => {
            if (!goalIsActive && !turnState.activeTurnId) {
              resolve();
            }
          };
          tryResolveOuter = tryResolve;

          exitHandler = (error?: Error) => {
            clearActiveTurn();
            reject(new Error(error?.message || 'Codex app-server exited during an active turn'));
          };

          // Message handler for all events during this turn
          messageHandler = (msg: JsonRpcMessage) => {
            try {
              if (msg.type === 'response' && msg.id === turnStartRequestId) {
                if (msg.error) {
                  clearActiveTurn();
                  reject(new Error(msg.error.message || 'turn/start failed'));
                  return;
                }
                rememberTurnId(extractTurnId(msg.result));
                return;
              }

              handleCodexMessage(
                msg,
                controller,
                codexProcess!,
                sessionId,
                threadId!,
                tryResolve,
                reject,
                model,
                resolvedEffort,
                abortController?.signal,
                turnCtx,
                {
                  onTurnStarted: rememberTurnId,
                  onTurnFinished: clearActiveTurn,
                },
              );
            } catch (err) {
              clearActiveTurn();
              reject(err);
            }
          };

          if (exitHandler) {
            codexProcess.onExit(exitHandler);
          }
          codexProcess.onMessage(messageHandler);
          codexProcess.send(turnStartRequest);
        });

        // Turn completed successfully
        clearInterval(heartbeatInterval);
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      } catch (error) {
        clearInterval(heartbeatInterval);
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        controller.enqueue(formatSSE({ type: 'error', data: errorMessage }));
        controller.enqueue(formatSSE({ type: 'done', data: '' }));
        controller.close();
      } finally {
        // Clean up message handlers
        if (codexProcess && messageHandler) {
          codexProcess.offMessage(messageHandler);
        }
        if (codexProcess && goalEventHandler) {
          codexProcess.offMessage(goalEventHandler);
        }
        if (codexProcess && exitHandler) {
          codexProcess.offExit(exitHandler);
        }
        if (abortController && abortListener) {
          abortController.signal.removeEventListener('abort', abortListener);
        }
        tryResolveOuter = null;
      }
    },

    cancel() {
      clearInterval(heartbeatInterval);
      abortController?.abort();
    },
  });
}

// ---------------------------------------------------------------------------
// Thread lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Start a new Codex thread. Accepts either a direct `thread/start` response
 * containing `thread.id` or the older `thread/started` notification fallback.
 */
function startThread(
  codexProcess: CodexProcess,
  sessionId: string,
  model?: string,
  cwd?: string,
  effort?: string,
  approvalPolicy?: AskForApproval,
  sandboxMode?: SandboxMode,
  options?: {
    persistThreadId?: boolean;
  },
): Promise<{ threadId: string; approvalPolicy: AskForApproval | null; sandboxMode: SandboxMode | null }> {
  const persistThreadId = options?.persistThreadId ?? true;

  return new Promise<{ threadId: string; approvalPolicy: AskForApproval | null; sandboxMode: SandboxMode | null }>((resolve, reject) => {
    const request = formatJsonRpcRequest('thread/start', {
      ...(model ? { model } : {}),
      ...(cwd ? { cwd } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
      ...(sandboxMode ? { sandbox: sandboxMode } : {}),
      ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
      experimentalRawEvents: false,
      persistExtendedHistory: false,
    });
    const requestId = getLastRequestId();

    let responseResult: {
      thread?: { id?: string };
      approvalPolicy?: AskForApproval | null;
      sandbox?: SandboxPolicy | null;
    } | null = null;
    let threadIdFromNotification: string | null = null;

    const timeout = setTimeout(() => {
      codexProcess.offMessage(handler);
      reject(new Error('thread/start timed out after 30s'));
    }, 30_000);

    const finalize = () => {
      const threadId = responseResult?.thread?.id ?? threadIdFromNotification;
      if (!responseResult || !threadId) {
        return;
      }

      clearTimeout(timeout);
      codexProcess.offMessage(handler);
      codexProcess.threadId = threadId;
      if (persistThreadId) {
        updateCodexThreadId(sessionId, threadId);
      }

      resolve({
        threadId,
        approvalPolicy: responseResult.approvalPolicy ?? null,
        sandboxMode: sandboxPolicyToMode(responseResult.sandbox),
      });
    };

    const handler = (msg: JsonRpcMessage) => {
      if (msg.type === 'notification' && msg.method === 'thread/started' && isRecord(msg.params)) {
        const thread = isRecord(msg.params.thread) ? msg.params.thread : null;
        if (typeof thread?.id === 'string') {
          threadIdFromNotification = thread.id;
          finalize();
        }
        return;
      }

      if (msg.type !== 'response' || msg.id !== requestId) {
        return;
      }

      if (msg.error) {
        clearTimeout(timeout);
        codexProcess.offMessage(handler);
        reject(new Error(`thread/start failed: ${msg.error.message}`));
        return;
      }

      responseResult = (msg.result ?? {}) as {
        thread?: { id?: string };
        approvalPolicy?: AskForApproval | null;
        sandbox?: SandboxPolicy | null;
      };

      if (!responseResult.thread?.id && !threadIdFromNotification) {
        clearTimeout(timeout);
        codexProcess.offMessage(handler);
        reject(new Error('thread/start response missing thread.id'));
        return;
      }

      finalize();
    };

    codexProcess.onMessage(handler);
    codexProcess.send(request);
  });
}

/**
 * Resume an existing thread on a (possibly new) process.
 * Sends `thread/resume` and waits for the response.
 */
function resumeThread(
  codexProcess: CodexProcess,
  threadId: string,
  approvalPolicy?: AskForApproval,
  sandboxMode?: SandboxMode,
  cwd?: string,
  model?: string,
): Promise<{ approvalPolicy: AskForApproval | null; sandboxMode: SandboxMode | null }> {
  return sendJsonRpcRequest<{
    approvalPolicy?: AskForApproval | null;
    sandbox?: SandboxPolicy | null;
  }>(codexProcess, 'thread/resume', {
    threadId,
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(sandboxMode ? { sandbox: sandboxMode } : {}),
    ...(cwd ? { cwd } : {}),
    ...(model ? { model } : {}),
    persistExtendedHistory: false,
  }).then((result) => ({
    approvalPolicy: result.approvalPolicy ?? null,
    sandboxMode: sandboxPolicyToMode(result.sandbox),
  }));
}

export async function runCodexReview({
  sessionId,
  workingDirectory,
  model,
  onProgress,
}: {
  sessionId: string;
  workingDirectory?: string;
  model?: string;
  /** Called with intermediate progress updates as the review runs. */
  onProgress?: (update: { thinkingPreview?: string; statusText?: string; event?: string }) => void;
}): Promise<CodexReviewResult> {
  const reviewProcessSessionId = `${sessionId}:codex-review`;
  const codexProcess = await CodexProcessManager.getOrCreate(reviewProcessSessionId);

  try {
    let threadId = codexProcess.threadId;
    if (!threadId) {
      const startedThread = await startThread(
        codexProcess,
        reviewProcessSessionId,
        model,
        workingDirectory,
        undefined,
        undefined,
        undefined,
        { persistThreadId: false },
      );
      threadId = startedThread.threadId;
    }

    if (!threadId) {
      throw new Error('Failed to obtain Codex review thread ID');
    }

    return await new Promise<CodexReviewResult>((resolve, reject) => {
      const delivery = 'inline' as const;
      let reviewThreadId = threadId!;
      let sawReviewResult = false;
      let terminalReviewError: string | null = null;
      let structuredReviewResult: Omit<CodexReviewResult, 'reviewThreadId' | 'delivery' | 'review'> = {
        findings: [],
      };

      // progressHandler is defined later but referenced in cleanup — use a
      // local variable that we overwrite once the handler is created.
      let progressHandler: ((msg: JsonRpcMessage) => void) | null = null;

      const timeout = setTimeout(() => {
        codexProcess.offMessage(handler);
        if (progressHandler) codexProcess.offMessage(progressHandler);
        reject(new Error('review/start timed out after 10m'));
      }, 600_000);

      const cleanup = () => {
        clearTimeout(timeout);
        codexProcess.offMessage(handler);
        if (progressHandler) codexProcess.offMessage(progressHandler);
      };

      const finalize = (review: string) => {
        const result = normalizeReviewResult(review);
        if ('error' in result) {
          fail(result.error);
          return;
        }

        sawReviewResult = true;
        cleanup();
        resolve({
          review: result.review,
          reviewThreadId,
          delivery,
          findings: structuredReviewResult.findings,
          overallCorrectness: structuredReviewResult.overallCorrectness,
          overallExplanation: structuredReviewResult.overallExplanation,
          overallConfidenceScore: structuredReviewResult.overallConfidenceScore,
        });
      };

      const fail = (message: string) => {
        cleanup();
        reject(new Error(message));
      };

      const handler = (msg: JsonRpcMessage) => {
        if (msg.type === 'response' && msg.id === requestId) {
          if (msg.error) {
            fail(msg.error.message);
            return;
          }

          const result = msg.result as { reviewThreadId?: string } | undefined;
          if (result?.reviewThreadId) {
            reviewThreadId = result.reviewThreadId;
          }
          return;
        }

        if (msg.type !== 'notification') return;

        if (msg.method === 'event_msg' && isRecord(msg.params)) {
          if (msg.params.type === 'token_count' && isRecord(msg.params.rate_limits)) {
            const rateLimits = msg.params.rate_limits;
            const primary = isRecord(rateLimits.primary) ? rateLimits.primary : null;
            const credits = isRecord(rateLimits.credits) ? rateLimits.credits : null;
            const primaryUsedPercent = typeof primary?.used_percent === 'number'
              ? primary.used_percent
              : null;
            const hasCredits = typeof credits?.has_credits === 'boolean'
              ? credits.has_credits
              : null;

            if ((primaryUsedPercent !== null && primaryUsedPercent >= 100) || hasCredits === false) {
              terminalReviewError = 'Codex review is currently unavailable because the active Codex account has exhausted its rate limit or credits.';
            }
          }

          if (msg.params.type === 'turn_aborted') {
            const reason = typeof msg.params.reason === 'string' ? msg.params.reason : null;
            fail(
              reason === 'replaced'
                ? 'Codex review was replaced by another request'
                : 'Codex review was interrupted',
            );
            return;
          }

          if (msg.params.type === 'exited_review_mode') {
            if (isRecord(msg.params.review_output)) {
              structuredReviewResult = extractStructuredReviewOutput(msg.params.review_output);
              finalize(formatReviewOutput(msg.params.review_output));
              return;
            }

            if (typeof msg.params.review === 'string' && msg.params.review.trim()) {
              finalize(msg.params.review);
              return;
            }

            return;
          }

          if (msg.params.type === 'task_complete' && !sawReviewResult) {
            fail(terminalReviewError || 'Codex review completed without returning any findings.');
            return;
          }
        }

        if (msg.method === 'item/completed') {
          const item = isRecord(msg.params.item) ? msg.params.item : null;
          if (!item) return;

          if (isRecord(item.review_output)) {
            structuredReviewResult = extractStructuredReviewOutput(item.review_output);
          }

          const reviewText = extractReviewTextFromItem(item);
          if (reviewText) {
            finalize(reviewText);
          }
          return;
        }

        if (msg.method === 'turn/completed' && isRecord(msg.params.turn)) {
          const turn = msg.params.turn;
          const status = turn.status;
          if (status === 'failed') {
            const turnError = isRecord(turn.error) ? turn.error : null;
            const message = typeof turnError?.message === 'string'
              ? turnError.message
              : 'Codex review failed';
            const details = typeof turnError?.additionalDetails === 'string'
              ? turnError.additionalDetails
              : null;
            fail(details ? `${message}: ${details}` : message);
            return;
          }

          if (status === 'interrupted') {
            fail('Codex review was interrupted');
          }
        }
      };

      // ---- Progress handler: captures intermediate events for the UI ----
      let thinkingBuffer = '';
      let agentMessageBuffer = '';

      progressHandler = onProgress ? (msg: JsonRpcMessage) => {
        if (msg.type !== 'notification') return;

        switch (msg.method) {
          // Primary reasoning (gpt-5.4+)
          case 'codex/event/reasoning_content_delta': {
            const inner = isRecord(msg.params.msg) ? msg.params.msg : msg.params;
            const delta = typeof inner.delta === 'string' ? inner.delta : '';
            if (delta) {
              thinkingBuffer += delta;
              onProgress({ thinkingPreview: thinkingBuffer.slice(-500) });
            }
            break;
          }
          // Reasoning summary (older models)
          case 'item/reasoning/summaryTextDelta': {
            const delta = typeof msg.params.delta === 'string' ? msg.params.delta : '';
            if (delta) {
              thinkingBuffer += delta;
              onProgress({ thinkingPreview: thinkingBuffer.slice(-500) });
            }
            break;
          }
          // Agent reasoning snippet
          case 'codex/event/agent_reasoning_delta': {
            const inner = isRecord(msg.params.msg) ? msg.params.msg : msg.params;
            const delta = typeof inner.delta === 'string' ? inner.delta : '';
            if (delta) {
              const snippet = delta.replace(/\n/g, ' ').trim();
              if (snippet) onProgress({ statusText: snippet });
            }
            break;
          }
          // Agent message text (the review being written)
          case 'item/agentMessage/delta': {
            const delta = typeof msg.params.delta === 'string' ? msg.params.delta : '';
            if (delta) {
              agentMessageBuffer += delta;
              onProgress({ statusText: agentMessageBuffer.slice(-300).replace(/\n/g, ' ').trim() });
            }
            break;
          }
          // Tool use started
          case 'item/started':
          case 'codex/event/item_started': {
            const item = msg.method === 'item/started'
              ? (isRecord(msg.params.item) ? msg.params.item : null)
              : (isRecord(msg.params.msg) && isRecord((msg.params.msg as Record<string, unknown>).item)
                  ? (msg.params.msg as Record<string, unknown>).item as Record<string, unknown>
                  : null);
            if (!item) break;
            const type = item.type as string;
            if (type === 'commandExecution' || type === 'CommandExecution') {
              onProgress({ event: `Running: ${(item.command as string) || 'command'}` });
            } else if (type === 'fileChange' || type === 'FileChange') {
              onProgress({ event: 'Editing file...' });
            }
            break;
          }
        }
      } : null;

      const request = formatJsonRpcRequest('review/start', {
        threadId,
        target: { type: 'uncommittedChanges' },
        delivery,
      });
      const requestId = getLastRequestId();

      codexProcess.onMessage(handler);
      if (progressHandler) codexProcess.onMessage(progressHandler);
      codexProcess.send(request);
    });
  } finally {
    await CodexProcessManager.kill(reviewProcessSessionId);
  }
}

export async function runCodexOneShot({
  prompt,
  workingDirectory,
  model,
  effort,
}: {
  prompt: string;
  workingDirectory?: string;
  model?: string;
  effort?: string;
}): Promise<string> {
  const tempSessionId = `__codex_oneshot__:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const codexProcess = await CodexProcessManager.getOrCreate(tempSessionId);

  try {
    const startedThread = await startThread(
      codexProcess,
      tempSessionId,
      model,
      workingDirectory,
      effort,
      'never',
      'read-only',
      { persistThreadId: false },
    );

    const threadId = startedThread.threadId;
    const cwd = workingDirectory || process.cwd();

    return await new Promise<string>((resolve, reject) => {
      let text = '';
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Codex one-shot request timed out after 2m'));
      }, 120_000);

      const cleanup = () => {
        clearTimeout(timeout);
        codexProcess.offMessage(handler);
      };

      const finish = () => {
        cleanup();
        resolve(text.trim());
      };

      const fail = (message: string) => {
        cleanup();
        reject(new Error(message));
      };

      const handler = (msg: JsonRpcMessage) => {
        if (msg.type === 'response' && msg.id === requestId) {
          if (msg.error) {
            fail(msg.error.message || 'Codex one-shot turn failed');
          }
          return;
        }

        if (msg.type !== 'notification') return;

        if (msg.method === 'item/agentMessage/delta') {
          const delta = typeof msg.params.delta === 'string' ? msg.params.delta : '';
          if (delta) text += delta;
          return;
        }

        if (msg.method === 'item/completed') {
          const item = isRecord(msg.params.item) ? msg.params.item : null;
          if (!item) return;
          const fullText = extractAgentMessageTextFromItem(item);
          if (fullText && !text.trim()) {
            text = fullText;
          }
          return;
        }

        if (msg.method === 'turn/completed') {
          const turn = isRecord(msg.params.turn) ? msg.params.turn : null;
          const turnError = turn && isRecord(turn.error) ? turn.error : null;
          if (typeof turnError?.message === 'string' && turnError.message) {
            fail(turnError.message);
            return;
          }
          finish();
          return;
        }

        if (msg.method === 'error') {
          const error = isRecord(msg.params.error) ? msg.params.error : null;
          const willRetry = msg.params.willRetry === true;
          if (!willRetry) {
            fail(typeof error?.message === 'string' ? error.message : 'Codex one-shot request failed');
          }
        }
      };

      const request = formatJsonRpcRequest('turn/start', {
        threadId,
        cwd,
        input: buildUserInputs(prompt),
        approvalPolicy: 'never',
        sandboxPolicy: {
          type: 'readOnly',
          access: { type: 'fullAccess' },
        },
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        summary: 'none',
      });
      const requestId = getLastRequestId();

      codexProcess.onMessage(handler);
      codexProcess.send(request);
    });
  } finally {
    await CodexProcessManager.kill(tempSessionId);
  }
}

// ---------------------------------------------------------------------------
// Event handling
// ---------------------------------------------------------------------------

interface CodexTokenSnapshot {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

interface CodexTurnTokenUsage {
  baseline: CodexTokenSnapshot | null;
  latest: CodexTokenSnapshot | null;
  contextWindow: number | null;
}

interface CodexTurnCtx {
  useNewReasoningProtocol: boolean;
  tokenUsage: CodexTurnTokenUsage;
  /** Timestamp captured at turn/started; used to detect images written during this turn. */
  turnStartedAt: number;
}

function defaultCodexTurnCtx(): CodexTurnCtx {
  return {
    useNewReasoningProtocol: false,
    tokenUsage: { baseline: null, latest: null, contextWindow: null },
    turnStartedAt: 0,
  };
}

/**
 * Scan Codex's `generated_images/<threadId>/` directory for files written
 * during this turn. The built-in `image_gen` tool writes here but does not
 * surface generated paths through the JSON-RPC stream — only via the
 * session rollout file. Polling at turn end is the simplest reliable way
 * to relay them to the chat UI.
 */
function findGeneratedImagesForTurn(threadId: string, turnStartedAt: number): string[] {
  if (!threadId || !turnStartedAt) return [];
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const dir = path.join(codexHome, 'generated_images', threadId);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out: Array<{ path: string; mtime: number }> = [];
  for (const name of entries) {
    if (!/\.(png|jpe?g|webp|gif)$/i.test(name)) continue;
    const full = path.join(dir, name);
    try {
      const stat = fs.statSync(full);
      // Allow a 2s grace window to catch files whose mtime is slightly
      // before turn/started due to clock jitter or batched writes.
      if (stat.mtimeMs >= turnStartedAt - 2000) {
        out.push({ path: full, mtime: stat.mtimeMs });
      }
    } catch {
      // ignore
    }
  }
  out.sort((a, b) => a.mtime - b.mtime);
  return out.map((x) => x.path);
}

/**
 * Handle a single JSON-RPC message from the Codex app-server.
 * Translates to SSE events and enqueues them on the controller.
 */
function handleCodexMessage(
  msg: JsonRpcMessage,
  controller: ReadableStreamDefaultController<string>,
  codexProcess: CodexProcess,
  sessionId: string,
  threadId: string,
  onTurnComplete: () => void,
  onError: (err: Error) => void,
  model?: string,
  effort?: string,
  abortSignal?: AbortSignal,
  turnCtx: CodexTurnCtx = defaultCodexTurnCtx(),
  turnLifecycle: {
    onTurnStarted?: (turnId: string | null) => void;
    onTurnFinished?: () => void;
  } = {},
): void {
  // --- Notifications (server push) ---
  if (msg.type === 'notification') {
    switch (msg.method) {
      case 'turn/started': {
        turnLifecycle.onTurnStarted?.(extractTurnId(msg.params));
        break;
      }

      // Codex 0.125 reports token usage via this notification (cumulative
      // totals + per-event delta). We snapshot baseline on the first event of
      // the turn so turn/completed can compute the per-turn delta.
      case 'thread/tokenUsage/updated': {
        const params = msg.params as Record<string, unknown> | undefined;
        const tokenUsage = isRecord(params?.tokenUsage) ? params!.tokenUsage : null;
        const total = isRecord(tokenUsage?.total) ? tokenUsage!.total : null;
        const last = isRecord(tokenUsage?.last) ? tokenUsage!.last : null;
        if (!total) break;

        const totalSnap = readTokenSnapshot(total);
        const ctx = turnCtx.tokenUsage;
        if (ctx.baseline === null && last) {
          const lastSnap = readTokenSnapshot(last);
          ctx.baseline = {
            inputTokens: totalSnap.inputTokens - lastSnap.inputTokens,
            outputTokens: totalSnap.outputTokens - lastSnap.outputTokens,
            cachedInputTokens: totalSnap.cachedInputTokens - lastSnap.cachedInputTokens,
            reasoningOutputTokens: totalSnap.reasoningOutputTokens - lastSnap.reasoningOutputTokens,
            totalTokens: totalSnap.totalTokens - lastSnap.totalTokens,
          };
        }
        ctx.latest = totalSnap;
        if (typeof tokenUsage?.modelContextWindow === 'number') {
          ctx.contextWindow = tokenUsage.modelContextWindow;
        }
        break;
      }

      // Text delta from agent message
      case 'item/agentMessage/delta': {
        const delta = msg.params.delta as string;
        if (delta) {
          controller.enqueue(formatSSE({ type: 'text', data: delta }));
        }
        break;
      }

      // Plan delta — render as regular text
      case 'item/plan/delta': {
        const delta = msg.params.delta as string;
        if (delta) {
          controller.enqueue(formatSSE({ type: 'text', data: delta }));
        }
        break;
      }

      // Raw reasoning delta — show as status so the user sees thinking progress
      case 'item/reasoning/textDelta': {
        const delta = msg.params.delta as string;
        if (delta) {
          // Extract a brief snippet for the status bar (last ~60 chars)
          const snippet = delta.replace(/\n/g, ' ').trim();
          if (snippet) {
            controller.enqueue(formatSSE({
              type: 'status',
              data: JSON.stringify({ notification: true, message: `Thinking: ${snippet.slice(0, 80)}${snippet.length > 80 ? '…' : ''}` }),
            }));
          }
        }
        break;
      }

      // Reasoning summary — stream as thinking block, separate from response
      // Skip if new codex/event/reasoning_content_delta is active (avoids duplicates)
      case 'item/reasoning/summaryTextDelta': {
        if (turnCtx.useNewReasoningProtocol) break;
        const delta = msg.params.delta as string;
        if (delta) {
          controller.enqueue(formatSSE({ type: 'thinking', data: delta }));
        }
        break;
      }

      // Reasoning summary part added — signal thinking phase completed
      case 'item/reasoning/summaryPartAdded': {
        // No-op: the summary text has already been streamed via summaryTextDelta
        break;
      }

      // Item started — could be commandExecution or fileChange
      case 'item/started': {
        const item = msg.params.item as Record<string, unknown>;
        if (!item) break;

        if (item.type === 'commandExecution') {
          controller.enqueue(formatSSE({
            type: 'tool_use',
            data: JSON.stringify({
              id: item.id,
              name: 'command',
              input: {
                command: item.command,
                cwd: item.cwd,
              },
            }),
          }));
        } else if (item.type === 'fileChange') {
          controller.enqueue(formatSSE({
            type: 'tool_use',
            data: JSON.stringify({
              id: item.id,
              name: 'file_edit',
              input: {
                changes: item.changes,
              },
            }),
          }));
        }
        break;
      }

      // Command execution output delta
      case 'item/commandExecution/outputDelta': {
        const delta = msg.params.delta as string;
        if (delta) {
          controller.enqueue(formatSSE({ type: 'tool_output', data: delta }));
        }
        break;
      }

      // File change output delta
      case 'item/fileChange/outputDelta': {
        const delta = msg.params.delta as string;
        if (delta) {
          controller.enqueue(formatSSE({ type: 'tool_output', data: delta }));
        }
        break;
      }

      // Item completed — could be commandExecution or fileChange
      case 'item/completed': {
        const item = msg.params.item as Record<string, unknown>;
        if (!item) break;

        if (item.type === 'commandExecution') {
          controller.enqueue(formatSSE({
            type: 'tool_result',
            data: JSON.stringify({
              tool_use_id: item.id,
              content: item.aggregatedOutput || '',
              is_error: (item.exitCode as number) !== 0,
              exit_code: item.exitCode,
              duration_ms: item.durationMs,
            }),
          }));
        } else if (item.type === 'fileChange') {
          controller.enqueue(formatSSE({
            type: 'tool_result',
            data: JSON.stringify({
              tool_use_id: item.id,
              content: JSON.stringify(item.changes || []),
              is_error: item.status === 'failed',
            }),
          }));
        } else if (item.type === 'imageView' && typeof item.path === 'string') {
          controller.enqueue(formatSSE({
            type: 'image',
            data: JSON.stringify({ path: item.path }),
          }));
        }
        break;
      }

      // Turn completed — extract usage and signal done
      case 'turn/completed': {
        const turn = msg.params.turn as Record<string, unknown> | undefined;
        const turnStatus = typeof turn?.status === 'string' ? turn.status : null;
        const turnError = turn?.error as { message?: string } | null;
        const turnFailed = turnStatus === 'failed';
        const turnInterrupted = turnStatus === 'interrupted';
        const resultPayload: Record<string, unknown> = {
          subtype: turnInterrupted ? 'interrupted' : (turnError || turnFailed ? 'error' : 'success'),
        };

        if (turnError || turnFailed) {
          resultPayload.is_error = true;
          resultPayload.errors = [turnError?.message || 'Codex turn failed'];
        }

        // Codex 0.125+ reports usage via thread/tokenUsage/updated; older
        // versions populated turn.usage. Fall back gracefully.
        const usage = turn?.usage as Record<string, unknown> | undefined;
        const ctx = turnCtx.tokenUsage;
        const computedDelta = ctx.baseline && ctx.latest ? {
          input_tokens: Math.max(0, ctx.latest.inputTokens - ctx.baseline.inputTokens),
          output_tokens: Math.max(0, ctx.latest.outputTokens - ctx.baseline.outputTokens),
          cache_read_input_tokens: Math.max(0, ctx.latest.cachedInputTokens - ctx.baseline.cachedInputTokens),
          reasoning_output_tokens: Math.max(0, ctx.latest.reasoningOutputTokens - ctx.baseline.reasoningOutputTokens),
        } : null;

        if (computedDelta || usage || model || effort) {
          resultPayload.usage = {
            input_tokens: computedDelta?.input_tokens ?? usage?.input_tokens ?? 0,
            output_tokens: computedDelta?.output_tokens ?? usage?.output_tokens ?? 0,
            cache_read_input_tokens: computedDelta?.cache_read_input_tokens ?? usage?.cached_input_tokens ?? 0,
            cache_creation_input_tokens: 0,
            reasoning_output_tokens: computedDelta?.reasoning_output_tokens ?? usage?.reasoning_output_tokens ?? 0,
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(ctx.contextWindow ? { contextWindow: ctx.contextWindow } : {}),
          };
        }

        // Detect any images Codex's built-in image_gen tool produced this turn.
        // Emit them before `result` so the frontend appends them as content blocks.
        if (turnCtx.turnStartedAt && !turnFailed && !turnInterrupted) {
          const generated = findGeneratedImagesForTurn(threadId, turnCtx.turnStartedAt);
          for (const imgPath of generated) {
            controller.enqueue(formatSSE({
              type: 'image',
              data: JSON.stringify({ path: imgPath }),
            }));
          }
        }

        controller.enqueue(formatSSE({
          type: 'result',
          data: JSON.stringify(resultPayload),
        }));

        turnLifecycle.onTurnFinished?.();

        // If the turn had an error, route to the error path so the outer
        // catch block handles cleanup correctly (no false-success 'done').
        if (turnError || turnFailed) {
          onError(new Error(turnError?.message || 'Turn completed with error'));
        } else {
          onTurnComplete();
        }
        break;
      }

      // Error notification
      case 'error': {
        const error = msg.params.error as { message?: string } | undefined;
        const willRetry = msg.params.willRetry as boolean;
        const errorMsg = error?.message || 'Unknown Codex error';

        if (!willRetry) {
          turnLifecycle.onTurnFinished?.();
          controller.enqueue(formatSSE({
            type: 'error',
            data: errorMsg,
          }));
          onError(new Error(errorMsg));
        } else {
          // Transient error — log as status, Codex will retry
          controller.enqueue(formatSSE({
            type: 'status',
            data: JSON.stringify({ message: `Codex error (retrying): ${errorMsg}` }),
          }));
        }
        break;
      }

      // ---------------------------------------------------------------
      // New codex/event/* protocol (gpt-5.4+, supplementary to item/*)
      // These carry richer data and are the primary source for reasoning
      // content on newer models. The payload is in msg.params.msg.
      // ---------------------------------------------------------------

      // Reasoning content delta — stream as thinking block (primary source on 5.4+)
      case 'codex/event/reasoning_content_delta': {
        turnCtx.useNewReasoningProtocol = true; // Flag to skip old summaryTextDelta duplicates
        const inner = msg.params.msg as Record<string, unknown> | undefined;
        const delta = inner?.delta as string;
        if (delta) {
          controller.enqueue(formatSSE({ type: 'thinking', data: delta }));
        }
        break;
      }

      // Agent reasoning delta — show as status snippet
      case 'codex/event/agent_reasoning_delta': {
        const inner = msg.params.msg as Record<string, unknown> | undefined;
        const delta = inner?.delta as string;
        if (delta) {
          const snippet = delta.replace(/\n/g, ' ').trim();
          if (snippet) {
            controller.enqueue(formatSSE({
              type: 'status',
              data: JSON.stringify({ notification: true, message: `Thinking: ${snippet.slice(0, 80)}${snippet.length > 80 ? '…' : ''}` }),
            }));
          }
        }
        break;
      }

      // Agent reasoning complete — full reasoning text (no-op, already streamed via deltas)
      case 'codex/event/agent_reasoning':
      // Section break between reasoning blocks
      case 'codex/event/agent_reasoning_section_break':
        break;

      // Item lifecycle events (v2) — map to tool_use/tool_result like old item/* events
      case 'codex/event/item_started': {
        const inner = msg.params.msg as Record<string, unknown> | undefined;
        const item = inner?.item as Record<string, unknown> | undefined;
        if (!item) break;

        if (item.type === 'CommandExecution' || item.type === 'commandExecution') {
          controller.enqueue(formatSSE({
            type: 'tool_use',
            data: JSON.stringify({
              id: item.id,
              name: 'command',
              input: { command: item.command, cwd: item.cwd },
            }),
          }));
        } else if (item.type === 'FileChange' || item.type === 'fileChange') {
          controller.enqueue(formatSSE({
            type: 'tool_use',
            data: JSON.stringify({
              id: item.id,
              name: 'file_edit',
              input: { changes: item.changes },
            }),
          }));
        } else if (item.type === 'WebSearch' || item.type === 'webSearch') {
          controller.enqueue(formatSSE({
            type: 'status',
            data: JSON.stringify({ message: 'Searching the web...' }),
          }));
        }
        break;
      }

      case 'codex/event/item_completed': {
        const inner = msg.params.msg as Record<string, unknown> | undefined;
        const item = inner?.item as Record<string, unknown> | undefined;
        if (!item) break;

        if (item.type === 'CommandExecution' || item.type === 'commandExecution') {
          controller.enqueue(formatSSE({
            type: 'tool_result',
            data: JSON.stringify({
              tool_use_id: item.id,
              content: item.aggregatedOutput || item.output || '',
              is_error: (item.exitCode as number) !== 0,
              exit_code: item.exitCode,
            }),
          }));
        } else if (item.type === 'FileChange' || item.type === 'fileChange') {
          controller.enqueue(formatSSE({
            type: 'tool_result',
            data: JSON.stringify({
              tool_use_id: item.id,
              content: JSON.stringify(item.changes || []),
              is_error: item.status === 'failed',
            }),
          }));
        } else if ((item.type === 'ImageView' || item.type === 'imageView') && typeof item.path === 'string') {
          controller.enqueue(formatSSE({
            type: 'image',
            data: JSON.stringify({ path: item.path }),
          }));
        }
        // WebSearch completion — no specific tool_result needed
        break;
      }

      // Web search lifecycle events — show as status
      case 'codex/event/web_search_begin': {
        controller.enqueue(formatSSE({
          type: 'status',
          data: JSON.stringify({ message: 'Searching the web...' }),
        }));
        break;
      }

      case 'codex/event/web_search_end': {
        const inner = msg.params.msg as Record<string, unknown> | undefined;
        const query = inner?.query as string;
        if (query) {
          controller.enqueue(formatSSE({
            type: 'status',
            data: JSON.stringify({ message: `Web search: ${query.slice(0, 80)}` }),
          }));
        }
        break;
      }

      default:
        // Unknown notification — ignore silently
        break;
    }
    return;
  }

  // --- Server requests (approval flow) ---
  if (msg.type === 'request') {
    if (
      msg.method === 'item/commandExecution/requestApproval' ||
      msg.method === 'item/fileChange/requestApproval'
    ) {
      handleApprovalRequest(msg, controller, codexProcess, sessionId, threadId, abortSignal);
    }
    return;
  }

  // --- Responses to our requests (usually ignored, handled by specific listeners) ---
  // No action needed for generic responses
}

/**
 * Handle an approval request from the Codex app-server.
 * Non-blocking: registers in the approval registry and sends back the
 * JSON-RPC response asynchronously when the user decides.
 */
function handleApprovalRequest(
  msg: JsonRpcMessage & { type: 'request' },
  controller: ReadableStreamDefaultController<string>,
  codexProcess: CodexProcess,
  sessionId: string,
  threadId: string,
  abortSignal?: AbortSignal,
): void {
  const approvalId = generateApprovalId();
  const isCommand = msg.method === 'item/commandExecution/requestApproval';
  const params = msg.params;

  // Build the permission request event for the UI
  const permEvent: PermissionRequestEvent = {
    permissionRequestId: approvalId,
    toolName: isCommand ? 'command' : 'file_edit',
    toolInput: isCommand
      ? {
          command: params.command ?? params.commandActions,
          cwd: params.cwd,
        }
      : {
          grantRoot: params.grantRoot,
          itemId: params.itemId,
        },
    decisionReason: params.reason as string | undefined,
    toolUseId: (params.itemId as string) || '',
  };

  // Send the permission_request SSE event to the client
  controller.enqueue(formatSSE({
    type: 'permission_request',
    data: JSON.stringify(permEvent),
  }));

  // Register in approval registry and handle response asynchronously
  // This does NOT block the message handler
  const approvalInfo = {
    type: (isCommand ? 'command' : 'file_change') as 'command' | 'file_change',
    callId: (params.itemId as string) || '',
    turnId: (params.turnId as string) || '',
    command: isCommand ? (params.command as string[] | undefined) : undefined,
    cwd: isCommand ? (params.cwd as string | undefined) : undefined,
    reason: (params.reason as string) || null,
    jsonRpcId: msg.id,
    changes: !isCommand ? { grantRoot: params.grantRoot } as Record<string, unknown> : undefined,
  };

  // Push notification for codex approval request
  const sessionForPush = getSession(sessionId);
  sendPushNotification({
    type: 'permission_request',
    sessionId,
    sessionTitle: sessionForPush?.title || 'CodePilot',
    message: `${approvalInfo.type}: ${approvalInfo.reason || 'Approval needed'}`,
    requestId: approvalId,
  }).catch(() => {});

  registerPendingCodexApproval(approvalId, sessionId, approvalInfo, abortSignal, permEvent)
    .then((decision) => {
      // Send JSON-RPC response back to the app-server with the user's decision
      codexProcess.send(
        formatJsonRpcResponse(msg.id, { decision }),
      );
    })
    .catch(() => {
      // On error (e.g. timeout), cancel the approval
      codexProcess.send(
        formatJsonRpcResponse(msg.id, { decision: 'cancel' }),
      );
    });
}
