'use client';

import { useRef, useState, useCallback, useEffect, type KeyboardEvent, type FormEvent } from 'react';
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AtIcon,
  Wrench01Icon,
  ClipboardIcon,
  HelpCircleIcon,
  ArrowDown01Icon,
  ArrowUp02Icon,
  CommandLineIcon,
  PlusSignIcon,
  Cancel01Icon,
  Delete02Icon,
  Coins01Icon,
  FileZipIcon,
  Stethoscope02Icon,
  FileEditIcon,
  SearchList01Icon,
  BrainIcon,
  GlobalIcon,
  Shield01Icon,
  Mic01Icon,
  Loading02Icon,
} from "@hugeicons/core-free-icons";
import { cn } from '@/lib/utils';
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  PromptInputButton,
  PromptInputSubmit,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input';
import { SquareIcon } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { ChatStatus } from 'ai';
import type { FileAttachment } from '@/types';
import { nanoid } from 'nanoid';
import { useVoiceInput } from '@/hooks/useVoiceInput';

import { MAX_UPLOAD_FILE_SIZE as MAX_FILE_SIZE } from '@/lib/config';

/** Codex skill reference resolved from `$skill-name` in user input. */
interface CodexSkillRef {
  name: string;
  path: string;
}

interface MessageInputProps {
  onSend: (content: string, files?: FileAttachment[], skillInfo?: { name: string; content: string }, codexSkills?: CodexSkillRef[]) => void;
  onCommand?: (command: string) => void;
  onStop?: () => void;
  /** Whether a graceful stop has been requested (next click will force stop) */
  stopRequested?: boolean;
  disabled?: boolean;
  isStreaming?: boolean;
  sessionId?: string;
  modelName?: string;
  onModelChange?: (model: string) => void;
  workingDirectory?: string;
  mode?: string;
  onModeChange?: (mode: string) => void;
  backend?: 'claude' | 'codex';
  onBackendChange?: (backend: 'claude' | 'codex') => void;
  effort?: string;
  onEffortChange?: (effort: string) => void;
}

interface CodexModelInfo {
  value: string;
  label: string;
  reasoningEfforts?: Array<{ value: string; label: string }>;
  defaultEffort?: string;
}

/** Effort info for Claude models (from SDK ModelInfo) */
interface ClaudeModelEffortInfo {
  supportsEffort: boolean;
  supportedEffortLevels: string[];
}

interface PopoverItem {
  label: string;
  value: string;
  description?: string;
  builtIn?: boolean;
  immediate?: boolean;
  installedSource?: "agents" | "claude";
  icon?: typeof CommandLineIcon;
  /** Codex skill metadata — present only for items from /api/codex/skills */
  codexSkillPath?: string;
}

type PopoverMode = 'file' | 'skill' | 'codexSkill' | null;

// Expansion prompts for CLI-only commands (not natively supported by SDK).
// SDK-native commands (/compact, /init, /review) are sent as-is — the SDK handles them directly.
const COMMAND_PROMPTS: Record<string, string> = {
  '/doctor': 'Run diagnostic checks on this project. Check system health, dependencies, configuration files, and report any issues.',
  '/terminal-setup': 'Help me configure my terminal for optimal use with Claude Code. Check current setup and suggest improvements.',
  '/memory': 'Show the current CLAUDE.md project memory file and help me review or edit it.',
};

const BUILT_IN_COMMANDS: PopoverItem[] = [
  { label: 'help', value: '/help', description: 'Show available commands and tips', builtIn: true, immediate: true, icon: HelpCircleIcon },
  { label: 'clear', value: '/clear', description: 'Clear conversation history', builtIn: true, immediate: true, icon: Delete02Icon },
  { label: 'cost', value: '/cost', description: 'Show session token usage guidance', builtIn: true, immediate: true, icon: Coins01Icon },
  { label: 'usage', value: '/usage', description: 'Show account quota and rate limits', builtIn: true, immediate: true, icon: GlobalIcon },
  { label: 'compact', value: '/compact', description: 'Compress conversation context', builtIn: true, icon: FileZipIcon },
  { label: 'doctor', value: '/doctor', description: 'Diagnose project health', builtIn: true, icon: Stethoscope02Icon },
  { label: 'init', value: '/init', description: 'Initialize CLAUDE.md for project', builtIn: true, icon: FileEditIcon },
  { label: 'review', value: '/review', description: 'Review code quality', builtIn: true, icon: SearchList01Icon },
  { label: 'terminal-setup', value: '/terminal-setup', description: 'Configure terminal settings', builtIn: true, icon: CommandLineIcon },
  { label: 'memory', value: '/memory', description: 'Edit project memory file', builtIn: true, icon: BrainIcon },
];

interface ModeOption {
  value: string;
  label: string;
  icon: typeof Wrench01Icon;
  description: string;
}

const MODE_OPTIONS: ModeOption[] = [
  { value: 'code', label: 'Code', icon: Wrench01Icon, description: 'Read, write files & run commands' },
  { value: 'plan', label: 'Plan', icon: ClipboardIcon, description: 'Plan first, then confirm changes' },
];

// Fallback model options used when the API is unavailable
const FALLBACK_MODEL_OPTIONS: Array<{ value: string; label: string; group?: 'claude' | 'codex' }> = [
  { value: 'sonnet', label: 'Sonnet', group: 'claude' },
  { value: 'opus', label: 'Opus', group: 'claude' },
  { value: 'haiku', label: 'Haiku', group: 'claude' },
];

/**
 * 将 Claude API 完整模型名称转换为工具栏按钮的短显示名称。
 * 下拉菜单中保持显示完整名称，只有按钮标签缩短。
 *
 * 示例:
 *   "claude-sonnet-4-5"        -> "Sonnet 4"
 *   "claude-opus-4-5"          -> "Opus 4"
 *   "claude-3-5-haiku-latest"  -> "Haiku 3.5"
 *   "claude-3-7-sonnet-latest" -> "Sonnet 3.7"
 *   "Sonnet" / "Opus" / "Haiku" -> 原样返回（fallback 已经够短）
 */
function getShortModelName(label: string): string {
  if (label.length <= 8) return label;

  const lower = label.toLowerCase();

  // "Default (recommended)" → "Default" so user knows it's not a specific model
  if (lower.startsWith('default')) return 'Default';

  const numericSegments = label.match(/\d+/g) ?? [];

  if (lower.includes('opus')) {
    const major = numericSegments[0];
    return major ? `Opus ${major}` : 'Opus';
  }
  if (lower.includes('sonnet')) {
    // "claude-3-7-sonnet-latest" -> ["3","7"] -> "Sonnet 3.7"
    // "claude-sonnet-4-5"        -> ["4","5"] -> "Sonnet 4"
    if (numericSegments.length >= 2 && numericSegments[0] === '3') {
      return `Sonnet ${numericSegments[0]}.${numericSegments[1]}`;
    }
    const major = numericSegments[0];
    return major ? `Sonnet ${major}` : 'Sonnet';
  }
  if (lower.includes('haiku')) {
    if (numericSegments.length >= 2 && numericSegments[0] === '3') {
      return `Haiku ${numericSegments[0]}.${numericSegments[1]}`;
    }
    const major = numericSegments[0];
    return major ? `Haiku ${major}` : 'Haiku';
  }

  // 通用 fallback：取最后一个英文单词 + 最后一个数字
  const parts = label.split('-').filter(Boolean);
  const lastWord = parts.findLast((p) => /[a-z]/i.test(p));
  const lastNum = numericSegments[numericSegments.length - 1];
  if (lastWord) {
    const capitalized = lastWord.charAt(0).toUpperCase() + lastWord.slice(1);
    return lastNum ? `${capitalized} ${lastNum}` : capitalized;
  }
  return label;
}

/**
 * Convert a data URL to a FileAttachment object.
 */
async function dataUrlToFileAttachment(
  dataUrl: string,
  filename: string,
  mediaType: string,
): Promise<FileAttachment> {
  // data:image/png;base64,<data>  — extract the base64 part
  const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;

  // Estimate raw size from base64 length
  const size = Math.ceil((base64.length * 3) / 4);

  return {
    id: nanoid(),
    name: filename,
    type: mediaType || 'application/octet-stream',
    size,
    data: base64,
  };
}

/**
 * Submit button that's aware of file attachments. Must be rendered inside PromptInput.
 */
function FileAwareSubmitButton({
  status,
  onStop,
  stopRequested,
  disabled,
  inputValue,
}: {
  status: ChatStatus;
  onStop?: () => void;
  stopRequested?: boolean;
  disabled?: boolean;
  inputValue: string;
}) {
  const attachments = usePromptInputAttachments();
  const hasFiles = attachments.files.length > 0;
  const isStreaming = status === 'streaming' || status === 'submitted';

  return (
    <PromptInputSubmit
      status={status}
      onStop={onStop}
      stopRequested={stopRequested}
      disabled={disabled || (!isStreaming && !inputValue.trim() && !hasFiles)}
      className="rounded-full"
    >
      {isStreaming ? (
        <SquareIcon className="size-4" />
      ) : (
        <HugeiconsIcon icon={ArrowUp02Icon} className="h-4 w-4" strokeWidth={2} />
      )}
    </PromptInputSubmit>
  );
}

/**
 * Attachment button that opens the file dialog. Must be rendered inside PromptInput.
 */
function AttachFileButton() {
  const attachments = usePromptInputAttachments();

  return (
    <PromptInputButton
      onClick={() => attachments.openFileDialog()}
      tooltip="Attach files"
    >
      <HugeiconsIcon icon={PlusSignIcon} className="h-3.5 w-3.5" />
    </PromptInputButton>
  );
}

/**
 * Mic button for voice input. Must be rendered inside MessageInput
 * where it can access setInputValue and textareaRef via props.
 */
function VoiceInputButton({
  onTranscript,
}: {
  onTranscript: (text: string) => void;
}) {
  const { isRecording, isTranscribing, duration, toggleRecording, isAvailable } = useVoiceInput({
    onTranscript,
    onError: (msg) => console.warn('[VoiceInput]', msg),
  });

  if (!isAvailable) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <PromptInputButton disabled>
            <HugeiconsIcon icon={Mic01Icon} className="h-3.5 w-3.5 opacity-30" />
          </PromptInputButton>
        </TooltipTrigger>
        <TooltipContent side="top">HTTPS required for voice input</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <PromptInputButton onClick={toggleRecording} disabled={isTranscribing}>
          {isTranscribing ? (
            <HugeiconsIcon icon={Loading02Icon} className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <div className="relative flex items-center">
              <HugeiconsIcon
                icon={Mic01Icon}
                className={cn("h-3.5 w-3.5", isRecording && "text-red-500")}
              />
              {isRecording && (
                <span className="absolute -top-1 -right-1 flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
                </span>
              )}
            </div>
          )}
          {isRecording && (
            <span className="text-[10px] text-red-500 tabular-nums ml-0.5">
              {Math.floor(duration / 60)}:{String(duration % 60).padStart(2, '0')}
            </span>
          )}
        </PromptInputButton>
      </TooltipTrigger>
      <TooltipContent side="top">
        {isRecording ? 'Stop recording' : isTranscribing ? 'Transcribing...' : 'Voice input'}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Bridge component that listens for 'attach-file-to-chat' / 'detach-file-from-chat'
 * custom events from the file tree and manages file attachments.
 * Broadcasts 'attached-files-changed' so the file tree can show +/- toggle state.
 * Must be rendered inside PromptInput.
 */
function FileTreeAttachmentBridge() {
  const attachments = usePromptInputAttachments();
  const attachmentsRef = useRef(attachments);
  // Map: file path → attachment id (for removal by path)
  const pathToIdRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // Broadcast current attached paths whenever attachments change
  useEffect(() => {
    // Clean up stale path mappings (attachment was removed via capsule X button)
    const currentIds = new Set(attachments.files.map(f => f.id));
    const pathMap = pathToIdRef.current;
    for (const [path, id] of pathMap) {
      if (!currentIds.has(id)) {
        pathMap.delete(path);
      }
    }
    // Broadcast the current set of paths
    const paths = new Set(pathMap.keys());
    window.dispatchEvent(new CustomEvent('attached-files-changed', { detail: paths }));
  }, [attachments.files]);

  // Listen for attach events
  useEffect(() => {
    const handler = async (e: Event) => {
      const customEvent = e as CustomEvent<{ path: string; isDirectory?: boolean }>;
      const filePath = customEvent.detail?.path;
      const isDirectory = customEvent.detail?.isDirectory ?? false;
      if (!filePath) return;

      // Already attached — ignore duplicate
      if (pathToIdRef.current.has(filePath)) return;

      try {
        // Both files and directories from the tree: create a lightweight path reference.
        // No need to fetch content — Claude Code subprocess reads from disk directly.
        // The MIME type marks it as a reference so the API can handle it appropriately.
        const baseName = filePath.split(/[/\\]/).pop() || (isDirectory ? 'directory' : 'file');
        const filename = isDirectory ? `${baseName}/` : baseName;
        const mimeType = isDirectory ? 'text/x-directory-ref' : 'text/x-file-ref';
        const file = new File([filePath], filename, { type: mimeType });

        attachmentsRef.current.add([file]);
        setTimeout(() => {
          const files = attachmentsRef.current.files;
          const match = files.find(f => f.filename === filename && !pathToIdRef.current.has(filePath));
          if (match) {
            pathToIdRef.current.set(filePath, match.id);
            const paths = new Set(pathToIdRef.current.keys());
            window.dispatchEvent(new CustomEvent('attached-files-changed', { detail: paths }));
          }
        }, 100);
      } catch (err) {
        console.warn('[FileTreeAttachment] Error attaching:', filePath, err);
      }
    };

    window.addEventListener('attach-file-to-chat', handler);
    return () => window.removeEventListener('attach-file-to-chat', handler);
  }, []);

  // Listen for detach events
  useEffect(() => {
    const handler = (e: Event) => {
      const customEvent = e as CustomEvent<{ path: string }>;
      const filePath = customEvent.detail?.path;
      if (!filePath) return;

      const id = pathToIdRef.current.get(filePath);
      if (id) {
        attachmentsRef.current.remove(id);
        pathToIdRef.current.delete(filePath);
        const paths = new Set(pathToIdRef.current.keys());
        window.dispatchEvent(new CustomEvent('attached-files-changed', { detail: paths }));
      }
    };

    window.addEventListener('detach-file-from-chat', handler);
    return () => window.removeEventListener('detach-file-from-chat', handler);
  }, []);

  return null;
}

/**
 * Capsule display for attached files, rendered inside PromptInput context.
 */
function FileAttachmentsCapsules() {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) return null;

  return (
    <div className="flex w-full flex-wrap items-center gap-1.5 px-3 pt-2 pb-0 order-first">
      {attachments.files.map((file) => {
        const isImage = file.mediaType?.startsWith('image/');
        return (
          <span
            key={file.id}
            className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 pl-2 pr-1 py-0.5 text-xs font-medium border border-emerald-500/20"
          >
            {isImage && file.url && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={file.url}
                alt={file.filename || 'image'}
                className="h-5 w-5 rounded object-cover"
              />
            )}
            <span className="max-w-[120px] truncate text-[11px]">
              {file.filename || 'file'}
            </span>
            <button
              type="button"
              onClick={() => attachments.remove(file.id)}
              className="ml-0.5 rounded-full p-0.5 hover:bg-emerald-500/20 transition-colors"
            >
              <HugeiconsIcon icon={Cancel01Icon} className="h-3 w-3" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

export function MessageInput({
  onSend,
  onCommand,
  onStop,
  stopRequested,
  disabled,
  isStreaming,
  sessionId,
  modelName,
  onModelChange,
  workingDirectory,
  mode = 'code',
  onModeChange,
  backend = 'claude',
  onBackendChange,
  effort,
  onEffortChange,
}: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modeMenuRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  const [popoverMode, setPopoverMode] = useState<PopoverMode>(null);
  const [popoverItems, setPopoverItems] = useState<PopoverItem[]>([]);
  const [popoverFilter, setPopoverFilter] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [triggerPos, setTriggerPos] = useState<number | null>(null);
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [inputValue, setInputValue] = useState('');
  const [dynamicModels, setDynamicModels] = useState<Array<{ value: string; label: string; group?: 'claude' | 'codex' }> | null>(null);
  const [codexModelInfo, setCodexModelInfo] = useState<Map<string, CodexModelInfo>>(new Map());
  const [claudeEffortInfo, setClaudeEffortInfo] = useState<Map<string, ClaudeModelEffortInfo>>(new Map());
  const skillsCacheRef = useRef<Map<string, string>>(new Map());
  /** Cache of Codex skill metadata (name → path), populated from /api/codex/skills */
  const codexSkillsCacheRef = useRef<Map<string, string>>(new Map());
  const [skipPermissions, setSkipPermissions] = useState(false);

  // Fetch per-session skip_permissions on mount / sessionId change
  useEffect(() => {
    if (!sessionId) return;
    fetch(`/api/chat/sessions/${sessionId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.session) {
          setSkipPermissions(data.session.skip_permissions === 1);
        }
      })
      .catch(() => {});
  }, [sessionId]);

  // Fetch supported models from BOTH backends and merge into grouped list
  useEffect(() => {
    Promise.all([
      fetch('/api/models').then(r => r.ok ? r.json() : { models: [] }).catch(() => ({ models: [] })),
      fetch('/api/codex/models').then(r => r.ok ? r.json() : { models: [] }).catch(() => ({ models: [] })),
    ]).then(([claudeData, codexData]) => {
      const claudeModels = (claudeData.models || []).map((m: { value: string; displayName: string }) => ({
        value: m.value,
        label: m.displayName,
        group: 'claude' as const,
      }));
      const codexModels = (codexData.models || []).map((m: { value: string; displayName: string }) => ({
        value: m.value,
        label: m.displayName,
        group: 'codex' as const,
      }));

      const allModels = [...claudeModels, ...codexModels];
      setDynamicModels(allModels);

      // Build effort info map for Claude models
      const claudeEffortMap = new Map<string, ClaudeModelEffortInfo>();
      for (const m of claudeData.models || []) {
        if (m.supportsEffort && m.supportedEffortLevels?.length > 1) {
          claudeEffortMap.set(m.value, {
            supportsEffort: true,
            supportedEffortLevels: m.supportedEffortLevels,
          });
        }
      }
      setClaudeEffortInfo(claudeEffortMap);

      // Build effort info map for Codex models
      const infoMap = new Map<string, CodexModelInfo>();
      for (const m of codexData.models || []) {
        const info: CodexModelInfo = { value: m.value, label: m.displayName };
        if (m.reasoningEfforts && m.reasoningEfforts.length > 1) {
          info.reasoningEfforts = m.reasoningEfforts;
          info.defaultEffort = m.defaultEffort;
        }
        infoMap.set(m.value, info);
      }
      setCodexModelInfo(infoMap);

      // Auto-select default model if no explicit model set
      if (!modelName && allModels.length > 0) {
        const preferred =
          allModels.find((m: { value: string }) => m.value === 'sonnet') ??
          allModels.find((m: { value: string }) => m.value !== 'default') ??
          allModels[0];
        if (preferred) {
          onModelChange?.(preferred.value);
          // Auto-set backend based on model group
          const newBackend = preferred.group === 'codex' ? 'codex' : 'claude';
          if (newBackend !== backend) onBackendChange?.(newBackend);
          // Auto-set default effort
          if (preferred.group === 'codex') {
            const modelData = (codexData.models || []).find((dm: { value: string }) => dm.value === preferred.value);
            if (modelData?.defaultEffort && !effort) onEffortChange?.(modelData.defaultEffort);
          } else if (!effort) {
            // Claude: set default effort if model supports it
            const cEffort = claudeEffortMap.get(preferred.value);
            if (cEffort?.supportsEffort) onEffortChange?.('high');
          }
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  const MODEL_OPTIONS = dynamicModels || FALLBACK_MODEL_OPTIONS;

  // Auto-set default effort when Claude effort info loads for the current model
  useEffect(() => {
    if (!effort && modelName && claudeEffortInfo.size > 0) {
      const info = claudeEffortInfo.get(modelName);
      if (info?.supportsEffort) {
        onEffortChange?.('high');
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claudeEffortInfo, modelName]);

  // Toggle per-session skip permissions
  const toggleSkipPermissions = useCallback(async () => {
    if (!sessionId) return;
    const newValue = !skipPermissions;
    setSkipPermissions(newValue);
    try {
      await fetch(`/api/chat/sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skip_permissions: newValue ? 1 : 0 }),
      });
    } catch {
      // Revert on failure
      setSkipPermissions(!newValue);
    }
  }, [sessionId, skipPermissions]);

  // Fetch files for @ mention
  const fetchFiles = useCallback(async (filter: string) => {
    if (!workingDirectory) return [];
    try {
      const params = new URLSearchParams();
      params.set('dir', workingDirectory);
      params.set('baseDir', workingDirectory);
      if (filter) params.set('q', filter);
      params.set('depth', '4');
      const res = await fetch(`/api/files?${params.toString()}`);
      if (!res.ok) return [];
      const data = await res.json();
      const tree = data.tree || [];
      const items: PopoverItem[] = [];
      function flattenTree(nodes: Array<{ name: string; path: string; type: string; children?: unknown[] }>) {
        for (const node of nodes) {
          items.push({ label: node.name, value: node.path });
          if (node.children) flattenTree(node.children as typeof nodes);
        }
      }
      flattenTree(tree);
      // Filter by query client-side (API doesn't support q param)
      if (filter) {
        const lower = filter.toLowerCase();
        return items.filter(i => i.label.toLowerCase().includes(lower) || i.value.toLowerCase().includes(lower)).slice(0, 20);
      }
      return items.slice(0, 20);
    } catch {
      return [];
    }
  }, [workingDirectory]);

  // Fetch skills for / command (built-in + API)
  // Returns all items unfiltered — filtering is done by filteredItems
  // Also caches skill content for expansion at submit time
  const fetchSkills = useCallback(async () => {
    let apiSkills: PopoverItem[] = [];
    try {
      const cwdParam = workingDirectory ? `?cwd=${encodeURIComponent(workingDirectory)}` : "";
      const res = await fetch(`/api/skills${cwdParam}`);
      if (res.ok) {
        const data = await res.json();
        const skills = data.skills || [];
        const cache = new Map<string, string>();
        apiSkills = skills
          .map((s: { name: string; description: string; content?: string; source?: string; installedSource?: "agents" | "claude" }) => {
            if (s.content) cache.set(s.name, s.content);
            return {
              label: s.name,
              value: `/${s.name}`,
              description: s.description || "",
              builtIn: false,
              installedSource: s.installedSource,
            };
          });
        skillsCacheRef.current = cache;
      }
    } catch {
      // API not available - just use built-in commands
    }

    // Deduplicate: remove API skills that share a name with built-in commands
    const builtInNames = new Set(BUILT_IN_COMMANDS.map(c => c.label));
    const uniqueSkills = apiSkills.filter(s => !builtInNames.has(s.label));

    // When Codex is active, only show CodePilot-native commands (help, clear, cost, usage)
    // and hide Claude-specific ones (compact, doctor, init, review, etc.)
    const CODEX_SAFE_COMMANDS = new Set(['help', 'clear', 'cost', 'usage']);
    const commands = backend === 'codex'
      ? BUILT_IN_COMMANDS.filter(c => CODEX_SAFE_COMMANDS.has(c.label))
      : BUILT_IN_COMMANDS;

    // When Codex is active, don't show Claude API skills (they use /command-name format)
    const skills = backend === 'codex' ? [] : uniqueSkills;

    return [...commands, ...skills];
  }, [workingDirectory, backend]);

  // Fetch Codex skills for $ trigger (Codex backend only).
  // Returns from cache on subsequent calls to avoid redundant fetches on every keystroke.
  const codexSkillsItemsRef = useRef<PopoverItem[]>([]);
  const fetchCodexSkills = useCallback(async (): Promise<PopoverItem[]> => {
    // Return cached popover items if already populated (skills rarely change mid-session)
    if (codexSkillsItemsRef.current.length > 0) {
      return codexSkillsItemsRef.current;
    }

    try {
      const cwdParam = workingDirectory ? `?cwd=${encodeURIComponent(workingDirectory)}` : '';
      const res = await fetch(`/api/codex/skills${cwdParam}`);
      if (!res.ok) return [];
      const data = await res.json();
      const skills: Array<{ name: string; description: string; path: string; displayName?: string }> = data.skills || [];

      const cache = new Map<string, string>();
      const items: PopoverItem[] = skills.map((s) => {
        cache.set(s.name, s.path);
        return {
          label: s.name,
          value: `$${s.name}`,
          description: s.description || '',
          builtIn: false,
          codexSkillPath: s.path,
        };
      });
      codexSkillsCacheRef.current = cache;
      codexSkillsItemsRef.current = items;
      return items;
    } catch {
      return [];
    }
  }, [workingDirectory]);

  // Close popover
  const closePopover = useCallback(() => {
    setPopoverMode(null);
    setPopoverItems([]);
    setPopoverFilter('');
    setSelectedIndex(0);
    setTriggerPos(null);
  }, []);

  // Insert selected item
  const insertItem = useCallback((item: PopoverItem) => {
    if (triggerPos === null) return;

    // Immediate built-in commands: execute right away
    if (item.builtIn && item.immediate && onCommand) {
      setInputValue('');
      closePopover();
      onCommand(item.value);
      return;
    }

    // Non-immediate commands and skills: insert /name inline
    if (popoverMode === 'skill') {
      const currentVal = inputValue;
      const before = currentVal.slice(0, triggerPos);
      const cursorEnd = triggerPos + popoverFilter.length + 1; // +1 for the /
      const after = currentVal.slice(cursorEnd);
      const insertText = `/${item.label} `;

      setInputValue(before + insertText + after);
      closePopover();
      setTimeout(() => textareaRef.current?.focus(), 0);
      return;
    }

    // Codex skill: insert $name inline
    if (popoverMode === 'codexSkill') {
      const currentVal = inputValue;
      const before = currentVal.slice(0, triggerPos);
      const cursorEnd = triggerPos + popoverFilter.length + 1; // +1 for the $
      const after = currentVal.slice(cursorEnd);
      const insertText = `$${item.label} `;

      setInputValue(before + insertText + after);
      closePopover();
      setTimeout(() => textareaRef.current?.focus(), 0);
      return;
    }

    // File mention: insert into text
    const currentVal = inputValue;
    const before = currentVal.slice(0, triggerPos);
    const cursorEnd = triggerPos + popoverFilter.length + 1;
    const after = currentVal.slice(cursorEnd);
    const insertText = `@${item.value} `;

    setInputValue(before + insertText + after);
    closePopover();

    // Refocus textarea
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [triggerPos, popoverMode, closePopover, onCommand, inputValue, popoverFilter]);

  // Handle input changes to detect @ and /
  const handleInputChange = useCallback(async (val: string) => {
    setInputValue(val);

    const textarea = textareaRef.current;
    if (!textarea) return;

    const cursorPos = textarea.selectionStart;
    const beforeCursor = val.slice(0, cursorPos);

    // Check for @ trigger
    const atMatch = beforeCursor.match(/@([^\s@]*)$/);
    if (atMatch) {
      const filter = atMatch[1];
      setPopoverMode('file');
      setPopoverFilter(filter);
      setTriggerPos(cursorPos - atMatch[0].length);
      setSelectedIndex(0);
      const items = await fetchFiles(filter);
      setPopoverItems(items);
      return;
    }

    // Check for $ trigger (Codex skills — only when backend is Codex)
    if (backend === 'codex') {
      const dollarMatch = beforeCursor.match(/(^|\s)\$([^\s$]*)$/);
      if (dollarMatch) {
        const filter = dollarMatch[2];
        setPopoverMode('codexSkill');
        setPopoverFilter(filter);
        setTriggerPos(cursorPos - dollarMatch[2].length - 1);
        setSelectedIndex(0);
        const items = await fetchCodexSkills();
        setPopoverItems(items);
        return;
      }
    }

    // Check for / trigger (only at start of line or after space)
    const slashMatch = beforeCursor.match(/(^|\s)\/([^\s]*)$/);
    if (slashMatch) {
      const filter = slashMatch[2];
      setPopoverMode('skill');
      setPopoverFilter(filter);
      setTriggerPos(cursorPos - slashMatch[2].length - 1);
      setSelectedIndex(0);
      const items = await fetchSkills();
      setPopoverItems(items);
      return;
    }

    if (popoverMode) {
      closePopover();
    }
  }, [fetchFiles, fetchSkills, fetchCodexSkills, popoverMode, closePopover, backend]);

  const handleSubmit = useCallback(async (msg: { text: string; files: Array<{ type: string; url: string; filename?: string; mediaType?: string }> }, e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const content = inputValue.trim();

    closePopover();

    // Convert PromptInput FileUIParts (with data URLs) to FileAttachment[]
    const convertFiles = async (): Promise<FileAttachment[]> => {
      if (!msg.files || msg.files.length === 0) return [];

      const attachments: FileAttachment[] = [];
      for (const file of msg.files) {
        if (!file.url) continue;
        try {
          const attachment = await dataUrlToFileAttachment(
            file.url,
            file.filename || 'file',
            file.mediaType || 'application/octet-stream',
          );
          // Enforce per-type size limits
          if (attachment.size <= MAX_FILE_SIZE) {
            attachments.push(attachment);
          }
        } catch {
          // Skip files that fail conversion
        }
      }
      return attachments;
    };

    const files = await convertFiles();
    const hasFiles = files.length > 0;

    if ((!content && !hasFiles) || disabled || isStreaming) return;

    // Check for /command or /skill prefix and expand inline
    if (content.startsWith('/')) {
      const match = content.match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
      if (match) {
        const commandName = match[1];
        const userInput = match[2]?.trim() || '';

        // Check built-in commands
        const cmd = BUILT_IN_COMMANDS.find(c => c.label === commandName);
        if (cmd) {
          if (cmd.immediate && onCommand && !userInput && !hasFiles) {
            setInputValue('');
            onCommand(cmd.value);
            return;
          }
          // Non-immediate built-in: expand with COMMAND_PROMPTS
          const promptTemplate = COMMAND_PROMPTS[cmd.value] || '';
          const finalPrompt = userInput
            ? `${promptTemplate}\n\nUser context: ${userInput}`
            : promptTemplate || cmd.value;
          setInputValue('');
          onSend(finalPrompt, hasFiles ? files : undefined);
          return;
        }

        // Check skills cache — pass skill name + content so ChatView can inject
        // it into the message as a <command-name> block (matching Claude Code CLI behavior).
        // The display text keeps the /command prefix so the user can see which skill was used.
        const skillContent = skillsCacheRef.current.get(commandName);
        if (skillContent) {
          const displayText = userInput ? `/${commandName} ${userInput}` : `/${commandName}`;
          setInputValue('');
          onSend(displayText, hasFiles ? files : undefined, { name: commandName, content: skillContent });
          return;
        }
      }
      // Unknown /command — send as-is
    }

    // Codex backend: detect $skill-name references anywhere in the message.
    // If the cache is empty (user typed/pasted without triggering the $ popover),
    // fetch skills first so references can be resolved.
    if (backend === 'codex') {
      const hasSkillRef = /(^|\s)\$[a-zA-Z0-9_-]+/.test(content);
      if (hasSkillRef) {
        // Ensure cache is populated (no-op if already filled)
        if (codexSkillsCacheRef.current.size === 0) {
          await fetchCodexSkills();
        }

        const skillRefPattern = /(^|\s)\$([a-zA-Z0-9_-]+)/g;
        const matchedSkills: CodexSkillRef[] = [];
        let refMatch;
        while ((refMatch = skillRefPattern.exec(content)) !== null) {
          const skillName = refMatch[2];
          const skillPath = codexSkillsCacheRef.current.get(skillName);
          if (skillPath) {
            matchedSkills.push({ name: skillName, path: skillPath });
          }
        }
        if (matchedSkills.length > 0) {
          setInputValue('');
          onSend(content, hasFiles ? files : undefined, undefined, matchedSkills);
          return;
        }
      }
    }

    onSend(content || 'Please review the attached file(s).', hasFiles ? files : undefined);
    setInputValue('');
  }, [inputValue, onSend, onCommand, disabled, isStreaming, closePopover, backend, fetchCodexSkills]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Popover navigation
      if (popoverMode && popoverItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          if (filteredItems[selectedIndex]) {
            insertItem(filteredItems[selectedIndex]);
          }
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          closePopover();
          return;
        }
      }

    },
    [popoverMode, popoverItems, popoverFilter, selectedIndex, insertItem, closePopover]
  );

  // Click outside to close popover
  useEffect(() => {
    if (!popoverMode) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        closePopover();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [popoverMode, closePopover]);

  // Click outside to close mode menu
  useEffect(() => {
    if (!modeMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (modeMenuRef.current && !modeMenuRef.current.contains(e.target as Node)) {
        setModeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modeMenuOpen]);

  // Click outside to close model menu
  useEffect(() => {
    if (!modelMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [modelMenuOpen]);

  const filteredItems = popoverItems.filter((item) =>
    item.label.toLowerCase().includes(popoverFilter.toLowerCase())
  );

  const currentModelValue = modelName || MODEL_OPTIONS[0]?.value || 'sonnet';
  const currentModelOption = MODEL_OPTIONS.find((m) => m.value === currentModelValue) || MODEL_OPTIONS[0];
  const currentMode = MODE_OPTIONS.find((m) => m.value === mode) || MODE_OPTIONS[0];

  // Reasoning effort — unified for both Claude and Codex models
  const codexInfo = codexModelInfo.get(currentModelValue);
  const claudeEffort = claudeEffortInfo.get(currentModelValue);

  // Build unified effort options: { value, label }[]
  const currentModelEfforts = (() => {
    if (codexInfo?.reasoningEfforts && codexInfo.reasoningEfforts.length > 1) {
      return codexInfo.reasoningEfforts; // Codex: already has value+label
    }
    if (claudeEffort?.supportsEffort && claudeEffort.supportedEffortLevels.length > 1) {
      return claudeEffort.supportedEffortLevels.map(level => ({
        value: level,
        label: level.charAt(0).toUpperCase() + level.slice(1),
      }));
    }
    return undefined;
  })();

  // Default effort: Codex uses model-specific default, Claude defaults to 'high'
  const defaultEffort = codexInfo?.defaultEffort || (claudeEffort?.supportsEffort ? 'high' : undefined);

  // Validate effort: if stored effort isn't in model's supported list, fall back to default
  const supportedEffortValues = currentModelEfforts?.map(e => e.value) || [];
  const rawEffort = effort || defaultEffort;
  const currentEffort = rawEffort && supportedEffortValues.length > 0 && !supportedEffortValues.includes(rawEffort)
    ? defaultEffort || supportedEffortValues[0]
    : rawEffort;

  /** Short effort label for the toolbar button (e.g. "Med", "Hi", "XHi") */
  const effortShortLabel = (val?: string) => {
    if (!val) return '';
    const map: Record<string, string> = {
      none: 'No', minimal: 'Min', low: 'Lo', medium: 'Med', high: 'Hi', xhigh: 'XHi', max: 'Max',
    };
    return map[val] || val.slice(0, 3);
  };

  // Map isStreaming to ChatStatus for PromptInputSubmit
  const chatStatus: ChatStatus = isStreaming ? 'streaming' : 'ready';

  return (
    <div className="bg-background/80 backdrop-blur-lg px-4 py-3">
      <div className="mx-auto">
        <div className="relative">
          {/* Popover */}
          {popoverMode && filteredItems.length > 0 && (() => {
            const builtInItems = filteredItems.filter(item => item.builtIn);
            const skillItems = filteredItems.filter(item => !item.builtIn);
            let globalIdx = 0;

            const renderItem = (item: PopoverItem, idx: number) => (
              <button
                type="button"
                key={`${idx}-${item.value}`}
                ref={idx === selectedIndex ? (el) => { el?.scrollIntoView({ block: 'nearest' }); } : undefined}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
                  idx === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                )}
                onClick={() => insertItem(item)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                {popoverMode === 'file' ? (
                  <HugeiconsIcon icon={AtIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : item.builtIn && item.icon ? (
                  <HugeiconsIcon icon={item.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : !item.builtIn ? (
                  <HugeiconsIcon icon={GlobalIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                ) : (
                  <HugeiconsIcon icon={CommandLineIcon} className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="font-mono text-xs truncate">
                  {popoverMode === 'codexSkill' ? `$${item.label}` : item.label}
                </span>
                {item.description && (
                  <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                    {item.description}
                  </span>
                )}
                {!item.builtIn && item.installedSource && (
                  <span className="text-xs text-muted-foreground shrink-0 ml-auto">
                    {item.installedSource === 'claude' ? 'Personal' : 'Agents'}
                  </span>
                )}
              </button>
            );

            return (
              <div
                ref={popoverRef}
                className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border bg-popover shadow-lg overflow-hidden z-50"
              >
                {(popoverMode === 'skill' || popoverMode === 'codexSkill') ? (
                  <div className="px-3 py-2 border-b">
                    <input
                      ref={searchInputRef}
                      type="text"
                      placeholder={popoverMode === 'codexSkill' ? 'Search Codex skills...' : 'Search...'}
                      value={popoverFilter}
                      onChange={(e) => {
                        const val = e.target.value;
                        setPopoverFilter(val);
                        setSelectedIndex(0);
                        // Sync textarea: replace the filter portion after / or $
                        if (triggerPos !== null) {
                          const before = inputValue.slice(0, triggerPos + 1);
                          setInputValue(before + val);
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') {
                          e.preventDefault();
                          setSelectedIndex((prev) => (prev + 1) % filteredItems.length);
                        } else if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
                        } else if (e.key === 'Enter' || e.key === 'Tab') {
                          e.preventDefault();
                          if (filteredItems[selectedIndex]) {
                            insertItem(filteredItems[selectedIndex]);
                          }
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          closePopover();
                          textareaRef.current?.focus();
                        }
                      }}
                      className="w-full bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
                      autoFocus
                    />
                  </div>
                ) : (
                  <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b">
                    Files
                  </div>
                )}
                <div className="max-h-48 overflow-y-auto py-1">
                  {popoverMode === 'file' ? (
                    filteredItems.map((item, i) => renderItem(item, i))
                  ) : popoverMode === 'codexSkill' ? (
                    <>
                      <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                        Codex Skills
                      </div>
                      {filteredItems.map((item, i) => renderItem(item, i))}
                    </>
                  ) : (
                    <>
                      {builtInItems.length > 0 && (
                        <>
                          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                            Commands
                          </div>
                          {builtInItems.map((item) => {
                            const idx = globalIdx++;
                            return renderItem(item, idx);
                          })}
                        </>
                      )}
                      {skillItems.length > 0 && (
                        <>
                          <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground">
                            Skills
                          </div>
                          {skillItems.map((item) => {
                            const idx = globalIdx++;
                            return renderItem(item, idx);
                          })}
                        </>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })()}

          {/* PromptInput replaces the old input area */}
          <PromptInput
            onSubmit={handleSubmit}
            multiple
            maxFileSize={MAX_FILE_SIZE}
          >
            {/* Bridge: listens for file tree "+" button events */}
            <FileTreeAttachmentBridge />
            {/* File attachment capsules */}
            <FileAttachmentsCapsules />
            <PromptInputTextarea
              ref={textareaRef}
              placeholder="Message Claude..."
              value={inputValue}
              onChange={(e) => handleInputChange(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              className="min-h-10"
            />
            <PromptInputFooter>
              <PromptInputTools className="gap-0 sm:gap-1">
                {/* Attach file button */}
                <AttachFileButton />

                {/* Voice input button */}
                <VoiceInputButton
                  onTranscript={(text) => {
                    setInputValue(prev => prev ? `${prev} ${text}` : text);
                    setTimeout(() => textareaRef.current?.focus(), 0);
                  }}
                />

                {/* Mode selector */}
                <div className="relative" ref={modeMenuRef}>
                  <PromptInputButton
                    onClick={() => setModeMenuOpen((prev) => !prev)}
                  >
                    <span className="text-xs">{currentMode.label}</span>
                    <HugeiconsIcon icon={ArrowDown01Icon} className={cn("h-2.5 w-2.5 transition-transform duration-200", modeMenuOpen && "rotate-180")} />
                  </PromptInputButton>

                  {/* Mode dropdown */}
                  {modeMenuOpen && (
                    <div className="absolute bottom-full left-0 mb-1.5 w-56 rounded-lg border bg-popover shadow-lg overflow-hidden z-50">
                      <div className="py-1">
                        {MODE_OPTIONS.map((opt) => {
                          const isActive = opt.value === mode;
                          return (
                            <button
                              type="button"
                              key={opt.value}
                              className={cn(
                                "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                                isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                              )}
                              onClick={() => {
                                onModeChange?.(opt.value);
                                setModeMenuOpen(false);
                              }}
                            >
                              <HugeiconsIcon icon={opt.icon} className="h-4 w-4 shrink-0" />
                              <div className="flex flex-col min-w-0">
                                <span className="font-medium text-xs">{opt.label}</span>
                                <span className="text-[10px] text-muted-foreground truncate">
                                  {opt.description}
                                </span>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>

                {/* Model selector (with effort for Codex) */}
                <div className="relative min-w-0 shrink" ref={modelMenuRef}>
                  <PromptInputButton
                    onClick={() => setModelMenuOpen((prev) => !prev)}
                  >
                    <span className="text-xs font-mono max-w-[5ch] truncate sm:max-w-none">
                      {getShortModelName(currentModelOption.label)}
                      {currentModelEfforts && currentEffort ? `\u00B7${effortShortLabel(currentEffort)}` : ''}
                    </span>
                    <HugeiconsIcon icon={ArrowDown01Icon} className={cn("h-2.5 w-2.5 shrink-0 transition-transform duration-200", modelMenuOpen && "rotate-180")} />
                  </PromptInputButton>

                  {modelMenuOpen && (
                    <div className="absolute bottom-full left-0 mb-1.5 w-40 rounded-lg border bg-popover shadow-lg z-50 max-h-[50vh] flex flex-col overflow-hidden">
                      <div className="overflow-y-auto py-0.5 flex-1 min-h-0">
                        {/* Claude models group */}
                        {MODEL_OPTIONS.some(m => m.group === 'claude' || (!m.group && !codexModelInfo.has(m.value))) && (
                          <div className="px-2 py-0.5 text-[9px] font-medium text-muted-foreground/50 uppercase tracking-wider">Claude</div>
                        )}
                        {MODEL_OPTIONS.filter(m => m.group === 'claude' || (!m.group && !codexModelInfo.has(m.value))).map((opt) => {
                          const isActive = opt.value === currentModelValue;
                          return (
                            <button
                              type="button"
                              key={opt.value}
                              className={cn(
                                "flex w-full items-center px-2 py-[5px] text-left transition-colors",
                                isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                              )}
                              onClick={() => {
                                onModelChange?.(opt.value);
                                if (backend !== 'claude') onBackendChange?.('claude');
                                // Set default effort for Claude model, or clear if not supported
                                const cEffort = claudeEffortInfo.get(opt.value);
                                if (cEffort?.supportsEffort) {
                                  onEffortChange?.('high'); // Claude default
                                } else {
                                  onEffortChange?.('');
                                  setModelMenuOpen(false);
                                }
                              }}
                            >
                              <span className="font-mono text-[11px]">{opt.label}</span>
                            </button>
                          );
                        })}
                        {/* Codex models group */}
                        {MODEL_OPTIONS.some(m => m.group === 'codex' || codexModelInfo.has(m.value)) && (
                          <div className="px-2 py-0.5 text-[9px] font-medium text-muted-foreground/50 uppercase tracking-wider border-t border-border/50 mt-0.5 pt-1">Codex</div>
                        )}
                        {MODEL_OPTIONS.filter(m => m.group === 'codex' || codexModelInfo.has(m.value)).map((opt) => {
                          const isActive = opt.value === currentModelValue;
                          return (
                            <button
                              type="button"
                              key={opt.value}
                              className={cn(
                                "flex w-full items-center px-2 py-[5px] text-left transition-colors",
                                isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
                              )}
                              onClick={() => {
                                onModelChange?.(opt.value);
                                if (backend !== 'codex') onBackendChange?.('codex');
                                const newModelInfo = codexModelInfo.get(opt.value);
                                // Always reset effort to new model's default (prevents carrying unsupported efforts like xhigh→mini)
                                const supportedValues = newModelInfo?.reasoningEfforts?.map(e => e.value) || [];
                                if (newModelInfo?.defaultEffort) {
                                  onEffortChange?.(newModelInfo.defaultEffort);
                                } else if (supportedValues.length > 0) {
                                  onEffortChange?.(supportedValues[0]);
                                } else {
                                  onEffortChange?.('');
                                }
                                // Don't close — let user adjust effort level
                              }}
                            >
                              <span className="font-mono text-[11px]">{opt.label}</span>
                            </button>
                          );
                        })}
                      </div>

                      {/* Reasoning effort selector — pinned at bottom, always visible */}
                      {currentModelEfforts && currentModelEfforts.length > 1 && (
                        <div className="border-t px-2 py-1.5 shrink-0">
                          <span className="text-[9px] text-muted-foreground">Thinking</span>
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {currentModelEfforts.map((e) => (
                              <button
                                type="button"
                                key={e.value}
                                className={cn(
                                  "px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors",
                                  currentEffort === e.value
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-muted text-muted-foreground hover:bg-accent"
                                )}
                                onClick={() => { onEffortChange?.(e.value); setModelMenuOpen(false); }}
                              >
                                {effortShortLabel(e.value)}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Per-session skip permissions toggle */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <PromptInputButton
                      className=""
                      onClick={toggleSkipPermissions}
                    >
                      <div className="relative flex items-center">
                        <HugeiconsIcon
                          icon={Shield01Icon}
                          className={cn("h-3.5 w-3.5", skipPermissions ? "text-orange-500" : "")}
                        />
                        {skipPermissions && (
                          <span className="absolute -top-1 -right-1 flex h-2 w-2">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-orange-400 opacity-75" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-orange-500" />
                          </span>
                        )}
                      </div>
                    </PromptInputButton>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {skipPermissions ? 'Auto-approve ON (click to disable)' : 'Auto-approve OFF (click to enable)'}
                  </TooltipContent>
                </Tooltip>
              </PromptInputTools>

              <FileAwareSubmitButton
                status={chatStatus}
                onStop={onStop}
                stopRequested={stopRequested}
                disabled={disabled}
                inputValue={inputValue}
              />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>

    </div>
  );
}
