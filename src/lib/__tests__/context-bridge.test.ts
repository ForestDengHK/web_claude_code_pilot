import { formatMessagesForContext, buildContextBridge, type SimpleMessage } from '../context-bridge';

// ---------------------------------------------------------------------------
// Mock getAllMessages from db.ts so we don't need a real SQLite database
// ---------------------------------------------------------------------------

const mockGetAllMessages = jest.fn();
jest.mock('@/lib/db', () => ({
  getAllMessages: (...args: unknown[]) => mockGetAllMessages(...args),
}));

beforeEach(() => {
  mockGetAllMessages.mockReset();
});

// ---------------------------------------------------------------------------
// formatMessagesForContext
// ---------------------------------------------------------------------------

describe('formatMessagesForContext', () => {
  it('formats user/assistant turns correctly', () => {
    const messages: SimpleMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];
    const result = formatMessagesForContext(messages);
    expect(result).toBe('User: Hello\n---\nAssistant: Hi there!');
  });

  it('handles multiple turns', () => {
    const messages: SimpleMessage[] = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
      { role: 'assistant', content: 'Second answer' },
    ];
    const result = formatMessagesForContext(messages);
    expect(result).toContain('User: First question');
    expect(result).toContain('Assistant: First answer');
    expect(result).toContain('User: Second question');
    expect(result).toContain('Assistant: Second answer');
    // Turns are separated by ---
    expect(result.split('---').length).toBe(4);
  });

  it('handles JSON content blocks — text extracted, tools summarized', () => {
    const content = JSON.stringify([
      { type: 'text', text: 'Let me check that file.' },
      { type: 'tool_use', id: 'tool1', name: 'Read', input: { path: '/src/app.ts' } },
      { type: 'tool_result', tool_use_id: 'tool1', content: 'file contents here' },
      { type: 'text', text: 'Here is what I found.' },
    ]);
    const messages: SimpleMessage[] = [
      { role: 'assistant', content },
    ];
    const result = formatMessagesForContext(messages);
    expect(result).toContain('Let me check that file.');
    expect(result).toContain('[Used tool: Read]');
    expect(result).toContain('Here is what I found.');
    // tool_result content should NOT appear
    expect(result).not.toContain('file contents here');
  });

  it('truncates long messages', () => {
    const longText = 'word '.repeat(500); // 2500 chars
    const messages: SimpleMessage[] = [
      { role: 'user', content: longText },
    ];
    const result = formatMessagesForContext(messages);
    // Should be truncated with ellipsis
    expect(result.length).toBeLessThan(longText.length + 20);
    expect(result).toContain('...');
  });

  it('returns empty string for empty messages array', () => {
    expect(formatMessagesForContext([])).toBe('');
  });

  it('skips messages with empty content', () => {
    const messages: SimpleMessage[] = [
      { role: 'user', content: '' },
      { role: 'assistant', content: 'Response' },
    ];
    const result = formatMessagesForContext(messages);
    expect(result).toBe('Assistant: Response');
  });
});

// ---------------------------------------------------------------------------
// buildContextBridge
// ---------------------------------------------------------------------------

describe('buildContextBridge', () => {
  it('returns empty string when no messages exist', async () => {
    mockGetAllMessages.mockReturnValue([]);
    const result = await buildContextBridge('session-1', 'claude');
    expect(result).toBe('');
  });

  it('includes source backend name', async () => {
    mockGetAllMessages.mockReturnValue([
      { id: '1', session_id: 's1', role: 'user', content: 'Hello', created_at: '', token_usage: null },
      { id: '2', session_id: 's1', role: 'assistant', content: 'Hi', created_at: '', token_usage: null },
    ]);
    const result = await buildContextBridge('s1', 'claude');
    expect(result).toContain('previous conversation with Claude');

    const result2 = await buildContextBridge('s1', 'codex');
    expect(result2).toContain('previous conversation with Codex');
  });

  it('formats recent turns without summary when all messages are recent', async () => {
    mockGetAllMessages.mockReturnValue([
      { id: '1', session_id: 's1', role: 'user', content: 'Q1', created_at: '', token_usage: null },
      { id: '2', session_id: 's1', role: 'assistant', content: 'A1', created_at: '', token_usage: null },
    ]);
    const result = await buildContextBridge('s1', 'claude', { maxRecentTurns: 10 });
    expect(result).toContain('User: Q1');
    expect(result).toContain('Assistant: A1');
    // Should NOT have summary section since all messages fit in recent
    expect(result).not.toContain('Summary of earlier discussion');
  });

  it('splits old and recent messages, includes summary', async () => {
    // Create 6 messages (3 turns). Set maxRecentTurns=1 so only last 2 are recent.
    mockGetAllMessages.mockReturnValue([
      { id: '1', session_id: 's1', role: 'user', content: 'Fix the bug in /src/app.ts', created_at: '', token_usage: null },
      { id: '2', session_id: 's1', role: 'assistant', content: 'Looking at /src/app.ts now.', created_at: '', token_usage: null },
      { id: '3', session_id: 's1', role: 'user', content: 'Also check /lib/db.ts', created_at: '', token_usage: null },
      { id: '4', session_id: 's1', role: 'assistant', content: 'Done with db.', created_at: '', token_usage: null },
      { id: '5', session_id: 's1', role: 'user', content: 'Thanks, now deploy', created_at: '', token_usage: null },
      { id: '6', session_id: 's1', role: 'assistant', content: 'Deploying now.', created_at: '', token_usage: null },
    ]);
    const result = await buildContextBridge('s1', 'claude', { maxRecentTurns: 1 });

    // Should have summary of old messages
    expect(result).toContain('Summary of earlier discussion');
    expect(result).toContain('Topics discussed:');
    expect(result).toContain('Fix the bug in /src/app.ts');
    expect(result).toContain('Files referenced:');
    expect(result).toContain('/src/app.ts');
    expect(result).toContain('/lib/db.ts');

    // Recent section should only have last turn
    expect(result).toContain('Recent conversation (last 1 turns)');
    expect(result).toContain('User: Thanks, now deploy');
    expect(result).toContain('Assistant: Deploying now.');

    // Footer
    expect(result).toContain('Please continue from where the previous assistant left off.');
  });

  it('defaults to 10 recent turns', async () => {
    // 4 messages = 2 turns, both fit in default 10
    mockGetAllMessages.mockReturnValue([
      { id: '1', session_id: 's1', role: 'user', content: 'Q1', created_at: '', token_usage: null },
      { id: '2', session_id: 's1', role: 'assistant', content: 'A1', created_at: '', token_usage: null },
      { id: '3', session_id: 's1', role: 'user', content: 'Q2', created_at: '', token_usage: null },
      { id: '4', session_id: 's1', role: 'assistant', content: 'A2', created_at: '', token_usage: null },
    ]);
    const result = await buildContextBridge('s1', 'claude');
    // All should be in recent, no summary
    expect(result).not.toContain('Summary of earlier discussion');
    expect(result).toContain('User: Q1');
    expect(result).toContain('User: Q2');
  });
});
