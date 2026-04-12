// src/lib/organize-rules.ts
/**
 * Configurable rule engine for stage 1 session classification.
 * Runs entirely on metadata — no AI calls, no message content reads.
 */

import type { ChatSession } from '@/types';
import type { OrganizeConfig, OrganizeSuggestion } from '@/types/organize';

interface SessionWithCount extends ChatSession {
  messageCount: number;
}

type RuleResult = Pick<OrganizeSuggestion, 'action' | 'reason' | 'suggestedTitle'> | null;
type Rule = (session: SessionWithCount, config: OrganizeConfig) => RuleResult;

function daysSince(dateStr: string): number {
  const date = new Date(dateStr.replace(' ', 'T') + (dateStr.includes('T') ? '' : 'Z'));
  return (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24);
}

const emptySession: Rule = (session) => {
  if (session.messageCount === 0) {
    return { action: 'delete', reason: 'Empty session with no messages' };
  }
  return null;
};

const nearlyEmpty: Rule = (session, config) => {
  if (session.messageCount <= 2 && daysSince(session.updated_at) > config.emptyMaxAgeDays) {
    return {
      action: 'delete',
      reason: `Only ${session.messageCount} message(s), inactive for ${Math.floor(daysSince(session.updated_at))} days`,
    };
  }
  return null;
};

const defaultTitle: Rule = (session) => {
  if (session.title === 'New Chat' && session.messageCount > 0) {
    return { action: 'rename', reason: 'Default title "New Chat" — needs a descriptive name' };
  }
  return null;
};

const longInactive: Rule = (session, config) => {
  if (
    daysSince(session.updated_at) > config.inactiveMaxAgeDays &&
    session.messageCount < config.inactiveMaxMessages
  ) {
    return {
      action: 'delete',
      reason: `Inactive for ${Math.floor(daysSince(session.updated_at))} days with only ${session.messageCount} messages`,
    };
  }
  return null;
};

/** All rules in priority order. First match wins. */
const rules: Rule[] = [emptySession, nearlyEmpty, defaultTitle, longInactive];

/**
 * Run all rules against a session. Returns a suggestion if any rule matches,
 * or null if the session needs AI analysis.
 */
export function classifyByRules(
  session: ChatSession,
  messageCount: number,
  config: OrganizeConfig,
): OrganizeSuggestion | null {
  const sessionWithCount: SessionWithCount = { ...session, messageCount };

  for (const rule of rules) {
    const result = rule(sessionWithCount, config);
    if (result) {
      return {
        sessionId: session.id,
        sessionTitle: session.title,
        projectName: session.project_name,
        messageCount,
        lastUpdated: session.updated_at,
        action: result.action,
        reason: result.reason,
        suggestedTitle: result.suggestedTitle,
        confidence: 'rule',
        analyzed: true,
      };
    }
  }

  return null;
}
