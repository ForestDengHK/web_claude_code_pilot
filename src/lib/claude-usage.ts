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

function formatPercent(value: number): string {
  return value % 1 === 0 ? value.toFixed(0) : value.toFixed(1);
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
  const emoji = statusEmoji(rl.status);

  if (typeof rl.utilization === 'number') {
    const usedPct = Math.max(0, Math.min(100, rl.utilization * 100));
    const remainingPct = Math.max(0, 100 - usedPct);
    // Progress bar: 20 chars wide
    const filled = Math.min(20, Math.round(rl.utilization * 20));
    const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
    lines.push(`**${limitType}** ${emoji}`);
    lines.push(`Used ${formatPercent(usedPct)}% · Remaining ${formatPercent(remainingPct)}%`);
    lines.push(`\`${bar}\``);
  } else {
    lines.push(`**${limitType}**: ${emoji} ${formatRateLimitStatus(rl.status)}`);
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
 * Format Claude account info + rate limits into a markdown message.
 */
export function formatClaudeUsageMarkdown(
  account: ClaudeAccountInfo | null,
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
    lines.push('### Remaining Quota');

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

  // Note about rate limit availability
  if (validLimits.length === 0) {
    lines.push('');
    lines.push('> Rate limit data will appear after sending at least one Claude message.');
  } else {
    lines.push('');
    lines.push('> Session token counts are shown under each assistant message and via `/cost`.');
  }

  return lines.join('\n');
}
