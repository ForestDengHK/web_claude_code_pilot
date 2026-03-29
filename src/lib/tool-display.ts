export type ToolCategory =
  | 'read'
  | 'write'
  | 'bash'
  | 'search'
  | 'skill'
  | 'agent'
  | 'web'
  | 'todo'
  | 'ask'
  | 'other';

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico'];
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from']);

function normalizeToolName(name: string): string {
  const lower = name.toLowerCase().trim();
  const parts = lower.split(/[./:]/).filter(Boolean);
  return parts[parts.length - 1] || lower;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function extractFilename(path: string): string {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function looksLikePath(value: string): boolean {
  return value.includes('/') || value.startsWith('.') || /\.[a-z0-9]{1,8}$/i.test(value);
}

function extractPathsDeep(value: unknown, acc: string[], seen: Set<string>): void {
  if (acc.length >= 20 || value == null) return;
  if (typeof value === 'string') {
    if (looksLikePath(value) && !seen.has(value)) {
      seen.add(value);
      acc.push(value);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) extractPathsDeep(item, acc, seen);
    return;
  }
  const rec = asRecord(value);
  if (!rec) return;

  const pathKeys = [
    'file_path',
    'filePath',
    'path',
    'relative_path',
    'relativePath',
    'new_path',
    'newPath',
    'old_path',
    'oldPath',
    'target_path',
    'targetPath',
    'destination',
    'dest',
    'source',
  ];

  for (const key of pathKeys) {
    const pathValue = rec[key];
    if (typeof pathValue === 'string' && looksLikePath(pathValue) && !seen.has(pathValue)) {
      seen.add(pathValue);
      acc.push(pathValue);
      if (acc.length >= 20) return;
    }
  }

  for (const val of Object.values(rec)) {
    extractPathsDeep(val, acc, seen);
    if (acc.length >= 20) return;
  }
}

export function getFilePaths(input: unknown): string[] {
  const acc: string[] = [];
  extractPathsDeep(input, acc, new Set<string>());
  return acc;
}

export function getFilePath(input: unknown): string {
  return getFilePaths(input)[0] || '';
}

function getStringValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').join(' ').trim();
  }
  return '';
}

export function isImagePath(path: string): boolean {
  const lower = path.toLowerCase();
  return IMAGE_EXTENSIONS.some(ext => lower.endsWith(ext));
}

export function getToolCategory(name: string): ToolCategory {
  const lower = normalizeToolName(name);
  if (lower === 'skill') return 'skill';
  if (lower === 'agent' || lower === 'task' || lower === 'spawn_agent' || lower === 'send_input') return 'agent';
  if (lower === 'read' || lower === 'readfile' || lower === 'read_file' || lower === 'notebookread' || lower === 'notebook_read' || lower === 'open') return 'read';
  if (
    lower === 'write' || lower === 'edit' || lower === 'file_edit' || lower === 'writefile' ||
    lower === 'write_file' || lower === 'create_file' || lower === 'createfile' ||
    lower === 'notebookedit' || lower === 'notebook_edit' || lower === 'apply_patch'
  ) return 'write';
  if (
    lower === 'bash' || lower === 'command' || lower === 'execute' || lower === 'run' ||
    lower === 'shell' || lower === 'execute_command' || lower === 'exec_command' || lower === 'write_stdin'
  ) return 'bash';
  if (
    lower === 'search' || lower === 'glob' || lower === 'grep' ||
    lower === 'find_files' || lower === 'search_files' ||
    lower === 'websearch' || lower === 'web_search' || lower === 'toolsearch' ||
    lower === 'search_query' || lower === 'image_query' || lower === 'find'
  ) return 'search';
  if (lower === 'webfetch' || lower === 'web_fetch' || lower === 'open_url' || lower === 'click' || lower === 'open') return 'web';
  if (lower === 'todowrite' || lower === 'todo_write' || lower === 'update_plan') return 'todo';
  if (lower === 'askuserquestion' || lower === 'ask_user_question' || lower === 'request_user_input') return 'ask';
  return 'other';
}

export function getToolLabel(name: string, category: ToolCategory): string {
  switch (category) {
    case 'read': return 'Read';
    case 'write': return 'File Edit';
    case 'skill': return 'Skill';
    case 'agent': return 'Agent';
    case 'web': return 'Fetch';
    case 'todo': return 'Todo';
    case 'ask': return 'Ask';
    case 'bash': return '';
    default: return normalizeToolName(name);
  }
}

export function getToolSummary(name: string, input: unknown, category: ToolCategory): string {
  const inp = asRecord(input);
  if (!inp) return name;

  switch (category) {
    case 'read':
    case 'write': {
      const paths = getFilePaths(input);
      if (paths.length === 1) return extractFilename(paths[0]);
      if (paths.length > 1) return `${paths.length} files · ${extractFilename(paths[0])}`;
      const grantRoot = getStringValue(inp.grantRoot);
      return grantRoot ? extractFilename(grantRoot) : name;
    }
    case 'bash': {
      const cmd = getStringValue(inp.command) || getStringValue(inp.cmd);
      if (cmd) return cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd;
      return name;
    }
    case 'search': {
      const pattern = getStringValue(inp.pattern) || getStringValue(inp.query) || getStringValue(inp.glob);
      return pattern ? `"${pattern.length > 50 ? pattern.slice(0, 47) + '...' : pattern}"` : name;
    }
    case 'skill': {
      const skillName = getStringValue(inp.skill) || getStringValue(inp.name) || getStringValue(inp.skill_name);
      const args = getStringValue(inp.args);
      if (skillName && args) return `/${skillName} ${args.length > 40 ? args.slice(0, 37) + '...' : args}`;
      if (skillName) return `/${skillName}`;
      return name;
    }
    case 'agent': {
      const agentType = getStringValue(inp.subagent_type);
      const desc = getStringValue(inp.description) || getStringValue(inp.message);
      if (agentType && desc) return `${agentType} · ${desc.length > 40 ? desc.slice(0, 37) + '...' : desc}`;
      if (agentType) return agentType;
      if (desc) return desc.length > 50 ? desc.slice(0, 47) + '...' : desc;
      return name;
    }
    case 'web': {
      const url = getStringValue(inp.url);
      if (url) {
        try {
          return new URL(url).hostname;
        } catch {
          return url.length > 50 ? url.slice(0, 47) + '...' : url;
        }
      }
      return name;
    }
    case 'todo': {
      const todos = Array.isArray(inp.todos) ? inp.todos : [];
      if (todos.length > 0) {
        const first = getStringValue(asRecord(todos[0])?.content);
        return `${todos.length} items${first ? ` · ${first.length > 30 ? first.slice(0, 27) + '...' : first}` : ''}`;
      }
      return name;
    }
    case 'ask': {
      const question = getStringValue(inp.question) || getStringValue(inp.text);
      return question ? (question.length > 50 ? question.slice(0, 47) + '...' : question) : name;
    }
    default:
      return name;
  }
}

export function getToolFullText(name: string, input: unknown, category: ToolCategory): string {
  const inp = asRecord(input);
  if (!inp) return name;

  switch (category) {
    case 'read':
    case 'write': {
      const paths = getFilePaths(input);
      if (paths.length > 0) return paths.join('\n');
      return getToolSummary(name, input, category);
    }
    case 'bash':
      return getStringValue(inp.command) || getStringValue(inp.cmd) || name;
    case 'search': {
      const pattern = getStringValue(inp.pattern) || getStringValue(inp.query) || getStringValue(inp.glob);
      return pattern ? `"${pattern}"` : name;
    }
    case 'skill': {
      const skillName = getStringValue(inp.skill) || getStringValue(inp.name) || getStringValue(inp.skill_name);
      const args = getStringValue(inp.args);
      return skillName ? `/${skillName}${args ? ` ${args}` : ''}` : name;
    }
    case 'agent': {
      const parts: string[] = [];
      const agentType = getStringValue(inp.subagent_type);
      const desc = getStringValue(inp.description) || getStringValue(inp.message);
      const prompt = getStringValue(inp.prompt);
      if (agentType) parts.push(`[${agentType}]`);
      if (desc) parts.push(desc);
      if (prompt) parts.push(`\n${prompt.length > 200 ? `${prompt.slice(0, 197)}...` : prompt}`);
      return parts.length > 0 ? parts.join(' ') : name;
    }
    case 'web':
      return getStringValue(inp.url) || name;
    case 'ask':
      return getStringValue(inp.question) || getStringValue(inp.text) || name;
    default:
      return getToolSummary(name, input, category);
  }
}

export function scorePlaylistMatch(text: string, playlistTitle: string, playlistDescription = ''): number {
  const textWords = new Set(
    text.toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length >= 3 && !STOPWORDS.has(w)) || [],
  );
  const playlistWords = new Set(
    `${playlistTitle} ${playlistDescription}`.toLowerCase().match(/[a-z0-9]+/g)?.filter(w => w.length >= 3 && !STOPWORDS.has(w)) || [],
  );
  let score = 0;
  for (const word of textWords) {
    if (playlistWords.has(word)) score += 1;
  }
  return score;
}
