import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatClaudeUsageMarkdown } from '../../lib/claude-usage';

describe('formatClaudeUsageMarkdown', () => {
  it('shows used and remaining percentages for Claude rate limits', () => {
    const markdown = formatClaudeUsageMarkdown(
      {
        email: 'user@example.com',
        subscriptionType: 'pro',
        tokenSource: 'claude_pro',
        apiProvider: 'firstParty',
      },
      [
        {
          status: 'allowed',
          rateLimitType: 'five_hour',
          utilization: 0.32,
          resetsAt: Date.now() / 1000 + 3600,
        },
        {
          status: 'allowed_warning',
          rateLimitType: 'seven_day',
          utilization: 0.81,
          resetsAt: Date.now() / 1000 + 3 * 24 * 3600,
        },
      ],
    );

    assert.match(markdown, /5-hour window/);
    assert.match(markdown, /Used 32% · Remaining 68%/);
    assert.match(markdown, /7-day window/);
    assert.match(markdown, /Used 81% · Remaining 19%/);
    assert.doesNotMatch(markdown, /Estimated cost/);
    assert.doesNotMatch(markdown, /Session Usage/);
  });

  it('shows a fallback note when no Claude rate-limit snapshot is available', () => {
    const markdown = formatClaudeUsageMarkdown(null, []);
    assert.match(markdown, /Rate limit data will appear after sending at least one Claude message\./);
  });
});
