import { NextRequest } from 'next/server';
import { getSession, getAllMessages } from '@/lib/db';
import { parseMessageContent } from '@/types';
import type { MessageContentBlock, TokenUsage } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function formatTimestamp(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  } catch {
    return dateStr;
  }
}

function extractFilename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function getFilePath(input: unknown): string {
  const inp = input as Record<string, unknown> | undefined;
  if (!inp) return '';
  return (inp.file_path || inp.path || inp.filePath || '') as string;
}

function getToolCategory(name: string): string {
  const lower = name.toLowerCase();
  if (lower === 'read' || lower === 'readfile' || lower === 'read_file') return 'Read';
  if (
    lower === 'write' || lower === 'edit' || lower === 'writefile' ||
    lower === 'write_file' || lower === 'create_file' || lower === 'createfile' ||
    lower === 'notebookedit' || lower === 'notebook_edit'
  ) return 'Write';
  if (
    lower === 'bash' || lower === 'execute' || lower === 'run' ||
    lower === 'shell' || lower === 'execute_command'
  ) return 'Bash';
  if (
    lower === 'search' || lower === 'glob' || lower === 'grep' ||
    lower === 'find_files' || lower === 'search_files' ||
    lower === 'websearch' || lower === 'web_search'
  ) return 'Search';
  return name;
}

function formatToolUse(block: MessageContentBlock & { type: 'tool_use' }): string {
  const category = getToolCategory(block.name);
  const filePath = getFilePath(block.input);
  const inp = block.input as Record<string, unknown> | undefined;

  let summary = '';
  if (filePath) {
    summary = filePath;
  } else if (inp?.command) {
    summary = String(inp.command);
  } else if (inp?.pattern || inp?.query || inp?.glob) {
    summary = String(inp.pattern || inp.query || inp.glob);
  }

  const header = summary
    ? `${category} → ${summary}`
    : category;

  const lines: string[] = [];
  lines.push(`<details><summary>🔧 ${header}</summary>\n`);

  if (inp) {
    // For write/edit tools, show content or diff
    const content = (inp.content || inp.new_source || '') as string;
    const oldStr = (inp.old_string ?? inp.oldString ?? '') as string;
    const newStr = (inp.new_string ?? inp.newString ?? '') as string;

    if (oldStr || newStr) {
      const lang = filePath ? guessLanguage(filePath) : '';
      lines.push('```' + lang);
      if (oldStr) {
        for (const line of oldStr.split('\n')) {
          lines.push('- ' + line);
        }
      }
      if (newStr) {
        for (const line of newStr.split('\n')) {
          lines.push('+ ' + line);
        }
      }
      lines.push('```');
    } else if (content) {
      const lang = filePath ? guessLanguage(filePath) : '';
      const truncated = content.length > 3000 ? content.slice(0, 3000) + '\n... (truncated)' : content;
      lines.push('```' + lang);
      lines.push(truncated);
      lines.push('```');
    } else if (inp.command) {
      lines.push('```bash');
      lines.push(String(inp.command));
      lines.push('```');
    }
  }

  lines.push('\n</details>');
  return lines.join('\n');
}

function formatToolResult(content: string, isError?: boolean): string {
  if (!content) return '';
  const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n... (truncated)' : content;
  const prefix = isError ? '❌ Error:\n' : '';
  return `\n<details><summary>${isError ? '❌' : '✅'} Result</summary>\n\n\`\`\`\n${prefix}${truncated}\n\`\`\`\n\n</details>`;
}

function guessLanguage(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
    java: 'java', kt: 'kotlin', swift: 'swift',
    css: 'css', scss: 'scss', html: 'html',
    json: 'json', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', sql: 'sql', sh: 'bash',
    toml: 'toml', xml: 'xml', c: 'c', cpp: 'cpp', h: 'c',
    vue: 'vue', svelte: 'svelte',
  };
  return map[ext] || '';
}

interface FileAttachment {
  name: string;
  type?: string;
  filePath?: string;
}

function parseMessageFiles(content: string): { files: FileAttachment[]; text: string } {
  const match = content.match(/^<!--files:(.*?)-->\n?/);
  if (!match) return { files: [], text: content };
  try {
    const files = JSON.parse(match[1]);
    const text = content.slice(match[0].length);
    return { files, text };
  } catch {
    return { files: [], text: content };
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const session = getSession(id);
    if (!session) {
      return Response.json({ error: 'Session not found' }, { status: 404 });
    }

    const messages = getAllMessages(id);
    const lines: string[] = [];

    // Header
    lines.push(`# ${session.title || 'Untitled Session'}`);
    lines.push('');
    if (session.model) lines.push(`- **Model**: ${session.model}`);
    lines.push(`- **Date**: ${formatDate(session.created_at)}`);
    if (session.working_directory) lines.push(`- **Project**: ${session.working_directory}`);
    lines.push(`- **Messages**: ${messages.length}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of messages) {
      const isUser = msg.role === 'user';
      const timestamp = formatTimestamp(msg.created_at);

      // Role header
      if (isUser) {
        lines.push(`### 👤 User`);
      } else {
        lines.push(`### 🤖 Assistant`);
      }

      // Metadata line
      const metaParts: string[] = [];
      if (timestamp) metaParts.push(`_${timestamp}_`);
      if (!isUser && msg.token_usage) {
        try {
          const usage: TokenUsage = JSON.parse(msg.token_usage);
          const totalTokens = usage.input_tokens + usage.output_tokens;
          if (usage.model) metaParts.push(`_${usage.model}_`);
          metaParts.push(`_${totalTokens.toLocaleString()} tokens_`);
          if (usage.cost_usd !== undefined && usage.cost_usd !== null) {
            metaParts.push(`_$${usage.cost_usd.toFixed(4)}_`);
          }
        } catch {
          // skip
        }
      }
      if (metaParts.length > 0) {
        lines.push(metaParts.join(' · '));
      }
      lines.push('');

      // Parse content
      if (isUser) {
        // Handle file attachments in user messages
        const { files, text: textWithoutFiles } = parseMessageFiles(msg.content);
        if (files.length > 0) {
          for (const f of files) {
            lines.push(`📎 ${f.name}`);
          }
          lines.push('');
        }
        if (textWithoutFiles.trim()) {
          lines.push(textWithoutFiles.trim());
        }
      } else {
        // Assistant message: parse structured content blocks
        const blocks = parseMessageContent(msg.content);
        for (const block of blocks) {
          switch (block.type) {
            case 'text':
              if (block.text.trim()) {
                lines.push(block.text.trim());
              }
              break;
            case 'tool_use':
              lines.push(formatToolUse(block as MessageContentBlock & { type: 'tool_use' }));
              break;
            case 'tool_result':
              lines.push(formatToolResult(block.content, block.is_error));
              break;
          }
        }
      }

      lines.push('');
      lines.push('---');
      lines.push('');
    }

    const markdown = lines.join('\n');
    const safeTitle = (session.title || 'chat-export')
      .replace(/[^a-zA-Z0-9\u4e00-\u9fff\s-_]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 100);

    return new Response(markdown, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${safeTitle}.md"`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to export session';
    return Response.json({ error: message }, { status: 500 });
  }
}
