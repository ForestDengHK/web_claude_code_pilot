import { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, SDKAssistantMessage } from '@anthropic-ai/claude-agent-sdk';
import { getSetting, getActiveProvider } from './db';
import { runCodexOneShot } from './codex-client';
import { findClaudeBinary, getExpandedPath } from './platform';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Prompts — modeled after Hermes Agent's memory/skill extraction guidance
// ---------------------------------------------------------------------------

const MEMORY_OUTPUT_RULES = `Extract **durable facts** worth remembering across future sessions. Each memory entry should be 1-2 sentences.

WHAT TO KEEP:
- User preferences and corrections ("user prefers X", "don't do Y")
- Environment details (OS, tools, ports, services, directory structure)
- Project conventions (tech stack, config patterns, naming conventions)
- Tool quirks and workarounds discovered during this conversation
- Stable facts that will still matter in future sessions

WHAT NOT TO KEEP:
- Task progress or session outcomes ("we finished X")
- Temporary TODO state
- Things easily re-discovered (e.g. "file exists at path X")
- Generic/obvious facts (e.g. "Next.js is a React framework")
- Anything that reads like a commit message

PRIORITY: User preferences and corrections > environment facts > project conventions.
The most valuable memory is one that prevents the user from having to repeat themselves.

OUTPUT FORMAT: One memory per line, starting with "- ". Nothing else — no headers, no explanations.
If nothing is worth remembering, output exactly: "Nothing notable to remember."`;

const SKILL_OUTPUT_RULES = `Produce a **reusable procedure** that could be followed step-by-step in future sessions. Only produce a skill if the source contains a non-trivial workflow (5+ steps, error recovery, or non-obvious commands).

OUTPUT FORMAT — use this exact structure:

---
name: kebab-case-name
description: One-line description of when and why to use this skill (max 120 chars)
---

# Skill Title

## When to Use
Describe the trigger conditions — when should the AI load and follow this skill?

## Procedure
1. Step one with exact commands or actions
2. Step two
3. ...

## Pitfalls
- Known failure modes, common mistakes, things to watch out for

## Verification
How to confirm the procedure succeeded.

RULES:
- Use exact commands, file paths, and code — not vague descriptions
- Include error handling and edge cases discovered during the conversation
- Skip trivial procedures (single command, obvious steps)
- The description field must be concise — it appears in the skills index
- If nothing qualifies as a reusable skill, output exactly: "No reusable skill found."`;

const MEMORY_EXTRACTION_PROMPT = `You are a memory extraction assistant for a coding assistant called CodePilot.

Read the source material below and extract durable facts worth remembering.

${MEMORY_OUTPUT_RULES}

---
`;

const MEMORY_GENERATION_PROMPT = `You are a memory normalization assistant for a coding assistant called CodePilot.

The user wrote draft notes, rough rules, or messy memory candidates. Clean them up into final memory entries without losing important constraints.

${MEMORY_OUTPUT_RULES}

REWRITE RULES:
- Preserve specific constraints, preferences, ports, tools, and architecture details
- Remove repetition, filler, hedging, and conversational phrasing
- Split mixed paragraphs into separate memory lines when needed
- Normalize wording so each line can be injected directly into future context

---
`;

const SKILL_EXTRACTION_PROMPT = `You are a skill extraction assistant for a coding assistant called CodePilot.

Read the source material below and extract a reusable procedure if one is present.

${SKILL_OUTPUT_RULES}

---
`;

const SKILL_GENERATION_PROMPT = `You are a skill normalization assistant for a coding assistant called CodePilot.

The user wrote draft steps, rough rules, or incomplete procedure notes. Rewrite them into a final skill document that matches the canonical format.

${SKILL_OUTPUT_RULES}

REWRITE RULES:
- Preserve exact commands, paths, and technical constraints from the draft
- Reorder and clarify steps when needed, but do not invent missing facts
- Turn informal notes into concise, direct operational instructions
- If the draft is too thin to form a real reusable skill, output exactly: "No reusable skill found."

---
`;

const SESSION_MEMORY_PROMPT = `You are a memory extraction assistant for a coding assistant called CodePilot.

Analyze this entire conversation and extract all **durable facts** worth remembering across future sessions. Each memory entry should be 1-2 sentences.

WHAT TO EXTRACT:
- User preferences revealed during the conversation ("user prefers X", "user hates Y")
- Environment and project facts discovered (architecture, config, ports, services)
- Conventions and patterns established
- Gotchas and workarounds discovered through trial and error
- Tool quirks and non-obvious behaviors

WHAT NOT TO EXTRACT:
- What tasks were completed ("we built feature X")
- Temporary state or progress markers
- Generic facts anyone would know
- Things that are already in the project's CLAUDE.md

PRIORITY: User preferences and corrections > environment facts > project conventions.

OUTPUT FORMAT: One memory per line, starting with "- ". Nothing else — no headers, no explanations.
If nothing is worth remembering, output exactly: "Nothing notable to remember."

---
`;

const SESSION_SKILL_PROMPT = `You are a skill extraction assistant for a coding assistant called CodePilot.

Analyze this entire conversation and identify **reusable procedures** that could be followed step-by-step in future sessions. Only extract non-trivial workflows (5+ steps, error recovery, or non-obvious commands).

You may extract multiple skills if the conversation contains several distinct procedures. Separate them with a blank line.

For each skill, use this exact structure:

---
name: kebab-case-name
description: One-line description (max 120 chars)
---

# Skill Title

## When to Use
Trigger conditions.

## Procedure
1. Exact steps with commands

## Pitfalls
- Known failure modes

## Verification
How to confirm success.

RULES:
- Use exact commands and file paths from the conversation
- Include error handling discovered during the conversation
- Skip trivial single-command procedures
- If nothing qualifies, output exactly: "No reusable skill found."

---
`;

export type SummarizeMode = 'memory' | 'skill' | 'session-memory' | 'session-skill';
export type SummarizeAction = 'extract' | 'generate';
export type SummarizeBackend = 'claude' | 'codex';

// ---------------------------------------------------------------------------
// SDK query helper — reuses the same backend as normal chat
// ---------------------------------------------------------------------------

function buildSdkEnv(): Record<string, string> {
  const sdkEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) sdkEnv[key] = value;
  }
  delete sdkEnv.CLAUDECODE;
  delete sdkEnv.CLAUDE_CODE_ENTRYPOINT;
  if (!sdkEnv.HOME) sdkEnv.HOME = os.homedir();
  if (!sdkEnv.USERPROFILE) sdkEnv.USERPROFILE = os.homedir();
  sdkEnv.PATH = getExpandedPath();

  const activeProvider = getActiveProvider();
  if (activeProvider && activeProvider.api_key) {
    for (const key of Object.keys(sdkEnv)) {
      if (key.startsWith('ANTHROPIC_')) delete sdkEnv[key];
    }
    sdkEnv.ANTHROPIC_AUTH_TOKEN = activeProvider.api_key;
    sdkEnv.ANTHROPIC_API_KEY = activeProvider.api_key;
    if (activeProvider.base_url) {
      sdkEnv.ANTHROPIC_BASE_URL = activeProvider.base_url;
    }
    try {
      const extraEnv = JSON.parse(activeProvider.extra_env || '{}');
      for (const [key, value] of Object.entries(extraEnv)) {
        if (typeof value === 'string') {
          if (value === '') delete sdkEnv[key];
          else sdkEnv[key] = value;
        }
      }
    } catch { /* ignore */ }
  } else {
    const appToken = getSetting('anthropic_auth_token');
    const appBaseUrl = getSetting('anthropic_base_url');
    if (appToken) sdkEnv.ANTHROPIC_AUTH_TOKEN = appToken;
    if (appBaseUrl) sdkEnv.ANTHROPIC_BASE_URL = appBaseUrl;
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      sdkEnv.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
  }

  return sdkEnv;
}

function sanitizeSummaryResult(resultText: string): string {
  return resultText
    .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, '')
    .trim();
}

async function runClaudeOneShot(
  prompt: string,
  workingDirectory?: string,
  effort?: string,
): Promise<string> {
  const sdkEnv = buildSdkEnv();

  const queryOptions: Options = {
    cwd: workingDirectory || os.homedir(),
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: 1,
    tools: [],
    env: sdkEnv,
    settingSources: [],
  };
  if (effort && ['low', 'medium', 'high', 'max'].includes(effort)) {
    queryOptions.effort = effort as 'low' | 'medium' | 'high' | 'max';
  }

  const claudePath = findClaudeBinary();
  if (claudePath) {
    const ext = path.extname(claudePath).toLowerCase();
    if (ext !== '.cmd' && ext !== '.bat') {
      queryOptions.pathToClaudeCodeExecutable = claudePath;
    }
  }

  let resultText = '';
  const conversation = query({ prompt, options: queryOptions });

  for await (const message of conversation) {
    if (message.type === 'assistant') {
      const assistantMsg = message as SDKAssistantMessage;
      for (const block of assistantMsg.message.content) {
        if (block.type === 'text') {
          resultText = block.text;
        }
      }
    }
  }

  return sanitizeSummaryResult(resultText);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract memories or skills from content using the Claude Code backend.
 *
 * Modes:
 * - 'memory'         — extract facts from a single message
 * - 'skill'          — extract a procedure from a single message
 * - 'session-memory' — extract facts from a full conversation
 * - 'session-skill'  — extract procedures from a full conversation
 */
export async function summarize({
  content,
  mode,
  action = 'extract',
  backend = 'claude',
  model,
  effort,
  workingDirectory,
}: {
  content: string;
  mode: SummarizeMode;
  action?: SummarizeAction;
  backend?: SummarizeBackend;
  model?: string;
  effort?: string;
  workingDirectory?: string;
}): Promise<string> {
  const extractPrompts: Record<SummarizeMode, string> = {
    'memory': MEMORY_EXTRACTION_PROMPT,
    'skill': SKILL_EXTRACTION_PROMPT,
    'session-memory': SESSION_MEMORY_PROMPT,
    'session-skill': SESSION_SKILL_PROMPT,
  };
  const generatePrompts: Partial<Record<SummarizeMode, string>> = {
    'memory': MEMORY_GENERATION_PROMPT,
    'skill': SKILL_GENERATION_PROMPT,
  };

  const promptMap = action === 'generate' ? generatePrompts : extractPrompts;
  const promptPrefix = promptMap[mode];
  if (!promptPrefix) {
    throw new Error(`Mode "${mode}" does not support ${action}`);
  }

  const prompt = promptPrefix + content.slice(0, 8000);
  const result = backend === 'codex'
    ? await runCodexOneShot({ prompt, model, workingDirectory, effort: effort || 'low' })
    : await runClaudeOneShot(prompt, workingDirectory, effort);

  return sanitizeSummaryResult(result) || (mode.includes('skill') ? 'No reusable skill found.' : 'Nothing notable to remember.');
}
