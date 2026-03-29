export interface CodexUsageWindow {
  usedPercent: number | null;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export interface CodexUsageCredits {
  hasCredits: boolean;
  unlimited: boolean;
  balance: string | null;
}

export interface CodexUsageSnapshot {
  limitId: string | null;
  limitName: string | null;
  primary: CodexUsageWindow | null;
  secondary: CodexUsageWindow | null;
  credits: CodexUsageCredits | null;
  planType: string | null;
}

export interface CodexUsageAccount {
  type: 'chatgpt' | 'apiKey' | string;
  email?: string | null;
  planType?: string | null;
}

export interface CodexUsageResponse {
  account: CodexUsageAccount | null;
  requiresOpenaiAuth: boolean;
  rateLimits: CodexUsageSnapshot | null;
  rateLimitsByLimitId: Record<string, CodexUsageSnapshot> | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function normalizeWindow(value: unknown): CodexUsageWindow | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const usedPercent = raw.usedPercent ?? raw.used_percent;
  const windowMinutes = raw.windowMinutes ?? raw.window_minutes ?? raw.windowDurationMins;
  const resetsAt = raw.resetsAt ?? raw.resets_at;

  return {
    usedPercent: typeof usedPercent === 'number' ? usedPercent : null,
    windowMinutes: typeof windowMinutes === 'number' ? windowMinutes : null,
    resetsAt: typeof resetsAt === 'number' ? resetsAt : null,
  };
}

function normalizeCredits(value: unknown): CodexUsageCredits | null {
  const raw = asRecord(value);
  if (!raw) return null;

  return {
    hasCredits: Boolean(raw.hasCredits ?? raw.has_credits),
    unlimited: Boolean(raw.unlimited),
    balance: typeof raw.balance === 'string' ? raw.balance : null,
  };
}

export function normalizeUsageSnapshot(value: unknown): CodexUsageSnapshot | null {
  const raw = asRecord(value);
  if (!raw) return null;

  return {
    limitId: typeof (raw.limitId ?? raw.limit_id) === 'string' ? String(raw.limitId ?? raw.limit_id) : null,
    limitName: typeof (raw.limitName ?? raw.limit_name) === 'string' ? String(raw.limitName ?? raw.limit_name) : null,
    primary: normalizeWindow(raw.primary),
    secondary: normalizeWindow(raw.secondary),
    credits: normalizeCredits(raw.credits),
    planType: typeof (raw.planType ?? raw.plan_type) === 'string' ? String(raw.planType ?? raw.plan_type) : null,
  };
}

function normalizeSnapshotsByLimitId(value: unknown): Record<string, CodexUsageSnapshot> | null {
  const raw = asRecord(value);
  if (!raw) return null;

  const entries = Object.entries(raw)
    .map(([key, snapshot]) => [key, normalizeUsageSnapshot(snapshot)] as const)
    .filter((entry): entry is readonly [string, CodexUsageSnapshot] => entry[1] !== null);

  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

export function normalizeCodexUsageResponse(value: unknown): CodexUsageResponse {
  const raw = asRecord(value) ?? {};
  const accountRaw = asRecord(raw.account);

  return {
    account: accountRaw ? {
      type: typeof accountRaw.type === 'string' ? accountRaw.type : 'unknown',
      email: typeof accountRaw.email === 'string' ? accountRaw.email : null,
      planType: typeof (accountRaw.planType ?? accountRaw.plan_type) === 'string'
        ? String(accountRaw.planType ?? accountRaw.plan_type)
        : null,
    } : null,
    requiresOpenaiAuth: Boolean(raw.requiresOpenaiAuth ?? raw.requires_openai_auth),
    rateLimits: normalizeUsageSnapshot(raw.rateLimits ?? raw.rate_limits),
    rateLimitsByLimitId: normalizeSnapshotsByLimitId(raw.rateLimitsByLimitId ?? raw.rate_limits_by_limit_id),
  };
}

function formatPercent(value: number | null): string {
  if (value === null) return 'Unavailable';
  return `${value % 1 === 0 ? value.toFixed(0) : value.toFixed(1)}%`;
}

function formatWindow(window: CodexUsageWindow | null): string {
  if (!window) return 'Unavailable';

  const usage = `${formatPercent(window.usedPercent)} used`;
  const duration = window.windowMinutes ? ` over ${window.windowMinutes} min` : '';
  const reset = window.resetsAt
    ? `, resets ${new Date(window.resetsAt * 1000).toLocaleString()}`
    : '';

  return `${usage}${duration}${reset}`;
}

function formatCredits(credits: CodexUsageCredits | null): string {
  if (!credits) return 'Unavailable';
  if (!credits.hasCredits) return 'No credits enabled';
  if (credits.unlimited) return 'Unlimited';
  if (credits.balance) return `${credits.balance} credits`;
  return 'Enabled';
}

function formatPlan(planType: string | null | undefined): string {
  if (!planType) return 'Unknown';
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}

export function formatCodexUsageMarkdown(data: CodexUsageResponse): string {
  const lines: string[] = ['## Account Usage', ''];

  if (data.requiresOpenaiAuth && !data.account) {
    lines.push('OpenAI login is required before CodePilot can read Codex usage data.');
    return lines.join('\n');
  }

  if (!data.account) {
    lines.push('No account information returned by Codex.');
  } else if (data.account.type === 'chatgpt') {
    lines.push(`- Account: ${data.account.email || 'Unknown email'}`);
    lines.push(`- Plan: ${formatPlan(data.account.planType)}`);
    lines.push('- Auth: ChatGPT');
  } else if (data.account.type === 'apiKey') {
    lines.push('- Auth: API key');
  } else {
    lines.push(`- Auth: ${data.account.type}`);
  }

  const snapshots = data.rateLimitsByLimitId
    ? Object.entries(data.rateLimitsByLimitId)
    : data.rateLimits
      ? [[data.rateLimits.limitId || 'default', data.rateLimits] as const]
      : [];

  if (snapshots.length === 0) {
    lines.push('');
    lines.push('No Codex rate-limit snapshot was returned.');
  } else {
    for (const [limitId, snapshot] of snapshots) {
      const heading = snapshot.limitName || snapshot.limitId || limitId;
      lines.push('');
      lines.push(`### ${heading}`);
      lines.push(`- Primary window: ${formatWindow(snapshot.primary)}`);
      if (snapshot.secondary) {
        lines.push(`- Secondary window: ${formatWindow(snapshot.secondary)}`);
      }
      lines.push(`- Credits: ${formatCredits(snapshot.credits)}`);
      if (snapshot.planType) {
        lines.push(`- Limit plan: ${formatPlan(snapshot.planType)}`);
      }
    }
  }

  lines.push('');
  lines.push('OpenAI currently does not expose an exact “messages used / messages remaining” counter for ChatGPT Plus. This view shows the Codex account and rate-limit snapshot that the app-server can read.');
  return lines.join('\n');
}
