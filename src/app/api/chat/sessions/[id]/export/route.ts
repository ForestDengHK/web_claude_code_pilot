import { NextRequest } from 'next/server';
import { getSession, getAllMessages } from '@/lib/db';
import { parseMessageContent } from '@/types';
import type { MessageContentBlock, TokenUsage } from '@/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// UTF-8 BOM — ensures correct encoding in editors/viewers (especially mobile & Windows)
const UTF8_BOM = '\uFEFF';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool summary — mirrors page ToolActionsGroup display (one-line per tool)
// ---------------------------------------------------------------------------

function getFilePath(input: unknown): string {
  const inp = input as Record<string, unknown> | undefined;
  if (!inp) return '';
  return (inp.file_path || inp.path || inp.filePath || '') as string;
}

function getStringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .join(' ')
      .trim();
  }
  return '';
}

function getToolCategory(name: string): string {
  const lower = name.toLowerCase();
  if (
    lower === 'read' || lower === 'readfile' || lower === 'read_file' ||
    lower === 'notebookread' || lower === 'notebook_read'
  ) return 'Read';
  if (
    lower === 'write' || lower === 'edit' || lower === 'file_edit' || lower === 'writefile' ||
    lower === 'write_file' || lower === 'create_file' || lower === 'createfile' ||
    lower === 'notebookedit' || lower === 'notebook_edit'
  ) return 'Write';
  if (
    lower === 'bash' || lower === 'command' || lower === 'execute' || lower === 'run' ||
    lower === 'shell' || lower === 'execute_command'
  ) return 'Bash';
  if (
    lower === 'search' || lower === 'glob' || lower === 'grep' ||
    lower === 'find_files' || lower === 'search_files' ||
    lower === 'websearch' || lower === 'web_search' || lower === 'toolsearch'
  ) return 'Search';
  if (lower === 'skill') return 'Skill';
  if (lower === 'agent' || lower === 'task') return 'Agent';
  if (lower === 'webfetch' || lower === 'web_fetch') return 'Web';
  if (lower === 'todowrite' || lower === 'todo_write') return 'Todo';
  if (lower === 'askuserquestion' || lower === 'ask_user_question') return 'Ask';
  return name;
}

function getToolOneLiner(block: MessageContentBlock & { type: 'tool_use' }): string {
  const category = getToolCategory(block.name);
  const inp = block.input as Record<string, unknown> | undefined;
  const filePath = getFilePath(block.input);

  let detail = '';
  switch (category) {
    case 'Read':
    case 'Write':
      detail = filePath ? extractFilename(filePath) : '';
      break;
    case 'Bash': {
      const cmd = getStringValue(inp?.command) || getStringValue(inp?.cmd);
      detail = cmd ? (cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd) : '';
      break;
    }
    case 'Search': {
      const pattern = getStringValue(inp?.pattern) || getStringValue(inp?.query) || getStringValue(inp?.glob);
      detail = pattern ? `"${pattern.length > 50 ? pattern.slice(0, 47) + '...' : pattern}"` : '';
      break;
    }
    case 'Skill': {
      const skillName = getStringValue(inp?.skill) || getStringValue(inp?.name) || getStringValue(inp?.skill_name);
      detail = skillName ? `/${skillName}` : '';
      break;
    }
    case 'Agent': {
      const agentType = getStringValue(inp?.subagent_type);
      const desc = getStringValue(inp?.description);
      if (agentType && desc) {
        detail = `${agentType} · ${desc.length > 40 ? desc.slice(0, 37) + '...' : desc}`;
      } else if (agentType) {
        detail = agentType;
      } else if (desc) {
        detail = desc.length > 50 ? desc.slice(0, 47) + '...' : desc;
      }
      break;
    }
    case 'Web': {
      const url = getStringValue(inp?.url);
      if (url) {
        try {
          detail = new URL(url).hostname;
        } catch {
          detail = url.length > 50 ? url.slice(0, 47) + '...' : url;
        }
      }
      break;
    }
    case 'Todo': {
      const todos = Array.isArray(inp?.todos) ? inp.todos : [];
      if (todos.length > 0) {
        const first = getStringValue((todos[0] as Record<string, unknown> | undefined)?.content);
        detail = `${todos.length} items${first ? ` · ${first.length > 30 ? first.slice(0, 27) + '...' : first}` : ''}`;
      }
      break;
    }
    case 'Ask': {
      const question = getStringValue(inp?.question) || getStringValue(inp?.text);
      detail = question ? (question.length > 50 ? question.slice(0, 47) + '...' : question) : '';
      break;
    }
    default:
      detail = '';
  }

  return detail ? `${category} → ${detail}` : category;
}

// ---------------------------------------------------------------------------
// File attachment parsing (user messages)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main export handler
// ---------------------------------------------------------------------------

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
        // File attachments
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
        // Assistant message: text + compact tool summary
        const blocks = parseMessageContent(msg.content);
        const toolSummaries: string[] = [];

        for (const block of blocks) {
          if (block.type === 'text' && block.text.trim()) {
            lines.push(block.text.trim());
          } else if (block.type === 'tool_use') {
            toolSummaries.push(
              getToolOneLiner(block as MessageContentBlock & { type: 'tool_use' })
            );
          }
          // tool_result: skip — not shown prominently on page
        }

        // Append compact tool summary block (like the collapsed ToolActionsGroup on page)
        if (toolSummaries.length > 0) {
          lines.push('');
          lines.push(`> 🔧 **${toolSummaries.length} tool calls**`);
          for (const s of toolSummaries) {
            lines.push(`> - ${s}`);
          }
        }
      }

      lines.push('');
      lines.push('---');
      lines.push('');
    }

    const markdown = UTF8_BOM + lines.join('\n');
    const title = (session.title || 'chat-export')
      .replace(/\s+/g, '-')
      .slice(0, 100);

    // ASCII-only fallback for filename (strip non-ASCII chars)
    const asciiTitle = title.replace(/[^a-zA-Z0-9\-_]/g, '') || 'chat-export';
    // RFC 5987 encoded filename for UTF-8 support (Chinese, etc.)
    const utf8Title = encodeURIComponent(title);

    return new Response(markdown, {
      headers: {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': `attachment; filename="${asciiTitle}.md"; filename*=UTF-8''${utf8Title}.md`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to export session';
    return Response.json({ error: message }, { status: 500 });
  }
}
