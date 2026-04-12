// src/lib/organize-engine.ts
/**
 * Organize Engine — two-stage orchestrator for session analysis.
 *
 * Stage 1: Rule engine (fast, metadata-only)
 * Stage 2: AI deep analysis via Claude Agent SDK (for sessions not classified by rules)
 *
 * Manages SSE streaming, DB checkpointing, and in-memory buffer for recovery.
 */

import crypto from 'crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ChatSession } from '@/types';
import type {
  OrganizeConfig,
  OrganizeSuggestion,
  OrganizeSSEEvent,
} from '@/types/organize';
import {
  getAllSessions,
  getSessionMessageCount,
  getSessionHeadTailMessages,
  createOrganizeTask,
  updateOrganizeTaskResults,
  updateOrganizeTaskStatus,
} from '@/lib/db';
import { classifyByRules } from '@/lib/organize-rules';
import {
  initOrganizeBuffer,
  updateOrganizePhase,
  pushOrganizeSuggestion,
  clearOrganizeBuffer,
} from '@/lib/organize-buffer-registry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OrganizeCallbacks {
  onEvent: (event: OrganizeSSEEvent) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract readable text from a message's content field.
 * Messages store content as JSON-encoded arrays of content blocks.
 */
function extractMessageText(content: string): string {
  try {
    const blocks = JSON.parse(content);
    if (Array.isArray(blocks)) {
      return blocks
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('\n')
        .slice(0, 500);
    }
  } catch {
    // content is plain text, not JSON
  }
  return (content || '').slice(0, 500);
}

/**
 * Build the AI prompt for analyzing a single session.
 */
function buildAnalysisPrompt(
  session: ChatSession,
  messageCount: number,
  messages: Array<{ role: string; content: string; created_at: string }>,
  totalMessageCount: number,
  config: OrganizeConfig,
): string {
  const messageSummary = messages
    .map((m) => {
      const text = extractMessageText(m.content);
      return `[${m.role}] ${text}`;
    })
    .join('\n---\n');

  const samplingNote =
    totalMessageCount > messages.length
      ? `\n(Showing ${messages.length} of ${totalMessageCount} messages — head + tail sample)\n`
      : '';

  return `You are analyzing a chat session to decide whether it should be deleted, renamed, or kept as-is.

Session metadata:
- Title: "${session.title}"
- Project: "${session.project_name || '(none)'}"
- Created: ${session.created_at}
- Last updated: ${session.updated_at}
- Message count: ${messageCount}
- Backend: ${session.backend}
${samplingNote}
Sampled messages:
${messageSummary}

Based on the session content, decide one of:
1. "delete" — session is no longer useful (test/debug sessions, one-off questions fully resolved, empty exploration)
2. "rename" — session has value but the title is vague, generic, or doesn't reflect the actual content
3. "keep" — session title is already descriptive and the content is worth keeping

Respond with ONLY a JSON object (no markdown, no explanation outside JSON):
{
  "action": "delete" | "rename" | "keep",
  "reason": "brief explanation (1 sentence)",
  "suggestedTitle": "new title if action is rename, otherwise omit"
}

Title constraints when suggesting a rename:
- Maximum ${config.titleMaxLength} Chinese characters (or equivalent length in other languages)
- Do NOT prefix with the project name
- Match the language used in the session messages
- Be specific and descriptive`;
}

/**
 * Analyze a single session using the Claude Agent SDK.
 * Returns a suggestion, or a 'keep' fallback on error.
 */
async function analyzeSessionWithAI(
  session: ChatSession,
  messageCount: number,
  config: OrganizeConfig,
  abortSignal?: AbortSignal,
): Promise<OrganizeSuggestion> {
  // Codex backend not supported for organize analysis
  if (config.backend === 'codex') {
    return {
      sessionId: session.id,
      sessionTitle: session.title,
      projectName: session.project_name,
      messageCount,
      lastUpdated: session.updated_at,
      action: 'keep',
      reason: 'Codex backend not yet supported for organize analysis',
      confidence: 'ai',
      analyzed: true,
    };
  }

  try {
    // Get sampled messages (head + tail)
    const { messages, totalCount } = getSessionHeadTailMessages(
      session.id,
      config.headPairs,
      config.tailPairs,
    );

    const prompt = buildAnalysisPrompt(session, messageCount, messages, totalCount, config);

    const abortController = new AbortController();

    // Forward external abort signal
    if (abortSignal) {
      if (abortSignal.aborted) {
        abortController.abort();
      } else {
        abortSignal.addEventListener('abort', () => abortController.abort(), { once: true });
      }
    }

    const queryOptions: Options = {
      abortController,
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    };
    if (config.model) queryOptions.model = config.model;
    queryOptions.effort = 'low';

    let responseText = '';
    const conversation = query({ prompt, options: queryOptions });
    for await (const message of conversation) {
      if (message.type === 'assistant') {
        responseText = extractMessageText(JSON.stringify(message.message.content));
      }
    }

    // Parse AI response
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('AI response did not contain valid JSON');
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      action: 'delete' | 'rename' | 'keep';
      reason: string;
      suggestedTitle?: string;
    };

    // Validate action
    if (!['delete', 'rename', 'keep'].includes(parsed.action)) {
      throw new Error(`Invalid action from AI: ${parsed.action}`);
    }

    return {
      sessionId: session.id,
      sessionTitle: session.title,
      projectName: session.project_name,
      messageCount,
      lastUpdated: session.updated_at,
      action: parsed.action,
      reason: parsed.reason || 'AI analysis',
      suggestedTitle: parsed.suggestedTitle,
      confidence: 'ai',
      analyzed: true,
    };
  } catch (error) {
    // On AI failure, return 'keep' with error info — don't stop the whole analysis
    const errMsg = error instanceof Error ? error.message : String(error);
    return {
      sessionId: session.id,
      sessionTitle: session.title,
      projectName: session.project_name,
      messageCount,
      lastUpdated: session.updated_at,
      action: 'keep',
      reason: `AI analysis failed: ${errMsg}`,
      confidence: 'ai',
      analyzed: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the full organize analysis: rule engine → AI deep analysis.
 * Streams progress via callbacks, checkpoints to DB, and updates in-memory buffer.
 *
 * @returns The task ID
 */
export async function runOrganizeAnalysis(
  config: OrganizeConfig,
  callbacks: OrganizeCallbacks,
  abortSignal?: AbortSignal,
): Promise<string> {
  const taskId = crypto.randomUUID();

  // Create task in DB
  createOrganizeTask(taskId, JSON.stringify(config));

  const allSuggestions: OrganizeSuggestion[] = [];

  try {
    // Get all sessions, filtered by scope if project-specific
    let sessions: ChatSession[] = getAllSessions();
    if (config.scope !== 'all') {
      sessions = sessions.filter((s) => s.project_name === config.scope);
    }

    const totalSessions = sessions.length;

    // Initialize in-memory buffer
    initOrganizeBuffer(taskId, totalSessions);

    // -----------------------------------------------------------------------
    // Stage 1: Rule engine
    // -----------------------------------------------------------------------
    const needsAI: Array<{ session: ChatSession; messageCount: number }> = [];

    for (let i = 0; i < sessions.length; i++) {
      if (abortSignal?.aborted) break;

      const session = sessions[i];
      const messageCount = getSessionMessageCount(session.id);
      const ruleSuggestion = classifyByRules(session, messageCount, config);

      if (ruleSuggestion) {
        allSuggestions.push(ruleSuggestion);
        pushOrganizeSuggestion(taskId, ruleSuggestion);
        callbacks.onEvent({ type: 'suggestion', data: ruleSuggestion });
      } else {
        needsAI.push({ session, messageCount });
      }

      callbacks.onEvent({
        type: 'progress',
        phase: 'rules',
        completed: i + 1,
        total: totalSessions,
      });
    }

    // Checkpoint rule results to DB
    updateOrganizeTaskResults(taskId, JSON.stringify(allSuggestions));

    // -----------------------------------------------------------------------
    // Stage 2: AI deep analysis
    // -----------------------------------------------------------------------
    if (needsAI.length > 0 && !abortSignal?.aborted) {
      updateOrganizePhase(taskId, 'ai', needsAI.length);

      for (let i = 0; i < needsAI.length; i++) {
        if (abortSignal?.aborted) break;

        const { session, messageCount } = needsAI[i];
        const suggestion = await analyzeSessionWithAI(
          session,
          messageCount,
          config,
          abortSignal,
        );

        allSuggestions.push(suggestion);
        pushOrganizeSuggestion(taskId, suggestion);
        callbacks.onEvent({ type: 'suggestion', data: suggestion });

        callbacks.onEvent({
          type: 'progress',
          phase: 'ai',
          completed: i + 1,
          total: needsAI.length,
        });

        // Checkpoint after each AI result
        updateOrganizeTaskResults(taskId, JSON.stringify(allSuggestions));
      }
    }

    // -----------------------------------------------------------------------
    // Done
    // -----------------------------------------------------------------------
    const summary = {
      delete: allSuggestions.filter((s) => s.action === 'delete').length,
      rename: allSuggestions.filter((s) => s.action === 'rename').length,
      keep: allSuggestions.filter((s) => s.action === 'keep').length,
    };

    updateOrganizeTaskStatus(taskId, 'done');
    updateOrganizeTaskResults(taskId, JSON.stringify(allSuggestions));
    callbacks.onEvent({ type: 'done', summary });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    updateOrganizeTaskStatus(taskId, 'error');
    callbacks.onEvent({ type: 'error', message: errMsg });
  } finally {
    clearOrganizeBuffer(taskId);
  }

  return taskId;
}
