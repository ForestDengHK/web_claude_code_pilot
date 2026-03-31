import type { Message } from '@/types';
import type { RateLimitInfo } from '@/hooks/useSSEStream';

/**
 * Account info returned by the Claude Agent SDK's accountInfo() method.
 */
export interface ClaudeAccountInfo {
  email?: string;
  organization?: string;
  subscriptionType?: string;
  tokenSource?: string;
  apiKeySource?: string;
  apiProvider?: 'firstParty' | 'bedrock' | 'vertex' | 'foundry' | string;
}

/**
 * Aggregate session token data from messages.
 */
interface SessionTokenSummary {
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreation: number;
  totalCost: number;
  turnCount: number;
}

function aggregateSessionTokens(messages: Message[]): SessionTokenSummary {
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalCost = 0;
  let turnCount = 0;

  for (const msg of messages) {
    if (msg.token_usage) {
      try {
        const usage = typeof msg.token_usage === 'string' ? JSON.parse(msg.token_usage) : msg.token_usage;
        totalInput += usage.input_tokens || 0;
        totalOutput += usage.output_tokens || 0;
        totalCacheRead += usage.cache_read_input_tokens || 0;
        totalCacheCreation += usage.cache_creation_input_tokens || 0;
        if (usage.cost_usd) totalCost += usage.cost_usd;
        turnCount++;
      } catch { /* skip */ }
    }
  }

  return { totalInput, totalOutput, totalCacheRead, totalCacheCreation, totalCost, turnCount };
}

function formatProvider(provider: string | undefined): string {
  switch (provider) {
    case 'firstParty': return 'Anthropic';
    case 'bedrock': return 'AWS Bedrock';
    case 'vertex': return 'Google Vertex AI';
    case 'foundry': return 'Azure Foundry';
    default: return provider || 'Unknown';
  }
}

function formatSubscription(sub: string | undefined): string {
  if (!sub) return 'Unknown';
  return sub.charAt(0).toUpperCase() + sub.slice(1);
}

function formatTokenSource(source: string | undefined): string {
  if (!source) return '';
  switch (source) {
    case 'claude_pro': return 'Claude Pro';
    case 'claude_max_5': return 'Claude Max (5x)';
    case 'claude_max_20': return 'Claude Max (20x)';
    case 'claude_team': return 'Claude Team';
    case 'claude_enterprise': return 'Claude Enterprise';
    case 'api_key': return 'API Key';
    default: return source.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }
}

function formatRateLimitType(type: string | undefined): string {
  switch (type) {
    case 'five_hour': return '5-hour window';
    case 'seven_day': return '7-day window';
    case 'seven_day_opus': return '7-day Opus window';
    case 'seven_day_sonnet': return '7-day Sonnet window';
    case 'overage': return 'Overage';
    default: return type || 'Rate limit';
  }
}

function formatRateLimitStatus(status: string): string {
  switch (status) {
    case 'allowed': return 'OK';
    case 'allowed_warning': return 'Approaching limit';
    case 'rejected': return 'Rate limited';
    default: return status;
  }
}

function statusEmoji(status: string): string {
  switch (status) {
    case 'allowed': return '✅';
    case 'allowed_warning': return '⚠️';
    case 'rejected': return '🚫';
    default: return '❓';
  }
}

function formatTimeUntilReset(resetsAt: number): string {
  const now = Date.now() / 1000;
  const diff = resetsAt - now;
  if (diff <= 0) return 'now';
  if (diff < 60) return `${Math.round(diff)}s`;
  if (diff < 3600) return `${Math.round(diff / 60)}m`;
  const hours = Math.floor(diff / 3600);
  const mins = Math.round((diff % 3600) / 60);
  if (diff < 86400) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(diff / 86400);
  const remainHours = Math.round((diff % 86400) / 3600);
  return remainHours > 0 ? `${days}d ${remainHours}h` : `${days}d`;
}

/**
 * Format a single rate limit entry as markdown lines.
 */
function formatSingleRateLimit(rl: RateLimitInfo): string[] {
  const lines: string[] = [];
  const limitType = formatRateLimitType(rl.rateLimitType);

  if (typeof rl.utilization === 'number') {
    const pct = (rl.utilization * 100);
    const pctStr = pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1);
    // Progress bar: 20 chars wide
    const filled = Math.min(20, Math.round(rl.utilization * 20));
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    const emoji = statusEmoji(rl.status);
    lines.push(`**${limitType}** ${emoji} ${pctStr}% used`);
    lines.push(`\`${bar}\``);
  } else {
    lines.push(`**${limitType}**: ${statusEmoji(rl.status)} ${formatRateLimitStatus(rl.status)}`);
  }

  if (rl.resetsAt) {
    const timeLeft = formatTimeUntilReset(rl.resetsAt);
    lines.push(`Resets in ${timeLeft}`);
  }

  return lines;
}

// Sort order for rate limit types (lower = shown first)
const RATE_LIMIT_ORDER: Record<string, number> = {
  five_hour: 1,
  seven_day: 2,
  seven_day_opus: 3,
  seven_day_sonnet: 4,
  overage: 5,
};

/**
 * Format Claude account info + session tokens + rate limits into a markdown message.
 */
export function formatClaudeUsageMarkdown(
  account: ClaudeAccountInfo | null,
  messages: Message[],
  rateLimits?: RateLimitInfo[] | null,
): string {
  const lines: string[] = ['## Account Usage'];

  // Account section
  lines.push('');
  if (account) {
    if (account.email) {
      lines.push(`- **Account**: ${account.email}`);
    }
    if (account.organization) {
      lines.push(`- **Organization**: ${account.organization}`);
    }
    lines.push(`- **Provider**: ${formatProvider(account.apiProvider)}`);
    if (account.subscriptionType) {
      lines.push(`- **Subscription**: ${formatSubscription(account.subscriptionType)}`);
    }
    if (account.tokenSource) {
      lines.push(`- **Token source**: ${formatTokenSource(account.tokenSource)}`);
    }
    if (account.apiKeySource) {
      lines.push(`- **API key**: ${account.apiKeySource}`);
    }
  } else {
    lines.push('Account information unavailable.');
  }

  // Rate limits section — filter out stale entries (resetsAt already passed)
  const nowSec = Date.now() / 1000;
  const validLimits = (rateLimits || []).filter(
    rl => {
      // If the reset time has passed, the window has reset — data is stale
      if (rl.resetsAt && rl.resetsAt < nowSec) return false;
      // Only show if there's useful data
      return typeof rl.utilization === 'number' || rl.status !== 'allowed';
    },
  );

  if (validLimits.length > 0) {
    // Sort by type priority
    validLimits.sort((a, b) => {
      const orderA = RATE_LIMIT_ORDER[a.rateLimitType || ''] ?? 99;
      const orderB = RATE_LIMIT_ORDER[b.rateLimitType || ''] ?? 99;
      return orderA - orderB;
    });

    lines.push('');
    lines.push('### Rate Limits');

    for (const rl of validLimits) {
      lines.push('');
      const rlLines = formatSingleRateLimit(rl);
      lines.push(...rlLines);

      // Overage info
      if (rl.isUsingOverage && rl.overageStatus) {
        lines.push('');
        lines.push(`**Overage**: ${statusEmoji(rl.overageStatus)} ${formatRateLimitStatus(rl.overageStatus)}`);
        if (rl.overageResetsAt) {
          lines.push(`Resets in ${formatTimeUntilReset(rl.overageResetsAt)}`);
        }
      }
    }
  }

  // Session tokens section
  const session = aggregateSessionTokens(messages);

  if (session.turnCount > 0) {
    const totalTokens = session.totalInput + session.totalOutput;
    lines.push('');
    lines.push('### Session Usage');
    lines.push('');
    lines.push('| Metric | Count |');
    lines.push('|--------|-------|');
    lines.push(`| Input tokens | ${session.totalInput.toLocaleString()} |`);
    lines.push(`| Output tokens | ${session.totalOutput.toLocaleString()} |`);
    if (session.totalCacheRead > 0) {
      lines.push(`| Cache read | ${session.totalCacheRead.toLocaleString()} |`);
    }
    if (session.totalCacheCreation > 0) {
      lines.push(`| Cache creation | ${session.totalCacheCreation.toLocaleString()} |`);
    }
    lines.push(`| **Total tokens** | **${totalTokens.toLocaleString()}** |`);
    lines.push(`| Turns | ${session.turnCount} |`);
    if (session.totalCost > 0) {
      lines.push(`| **Estimated cost** | **$${session.totalCost.toFixed(4)}** |`);
    }
  } else {
    lines.push('');
    lines.push('*No token usage data in this session yet.*');
  }

  // Note about rate limit availability
  if (validLimits.length === 0) {
    lines.push('');
    lines.push('> Rate limit data will appear after sending at least one message.');
  }

  return lines.join('\n');
}
