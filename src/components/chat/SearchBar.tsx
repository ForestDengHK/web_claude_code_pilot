'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { SearchIcon, XIcon, ChevronUpIcon, ChevronDownIcon } from 'lucide-react';
import type { Message } from '@/types';

interface SearchBarProps {
  messages: Message[];
  isOpen: boolean;
  onClose: () => void;
  onHighlightChange: (matchIds: Set<string>, activeId: string | null, query: string) => void;
}

function extractTextFromMessage(content: string): string {
  // JSON array format (new)
  if (content.startsWith('[')) {
    try {
      const blocks = JSON.parse(content) as Array<{ type: string; text?: string }>;
      return blocks
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join(' ');
    } catch {
      // fall through
    }
  }
  // Legacy format: strip HTML comments
  return content
    .replace(/<!--files:[\s\S]*?-->\n?/, '')
    .replace(/<!--tool_use:[\s\S]*?-->/g, '')
    .replace(/<!--tool_result:[\s\S]*?-->/g, '')
    .trim();
}

export function SearchBar({ messages, isOpen, onClose, onHighlightChange }: SearchBarProps) {
  const [query, setQuery] = useState('');
  const [matchIndices, setMatchIndices] = useState<number[]>([]);
  const [activeMatchIdx, setActiveMatchIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      // Small delay to ensure DOM is ready after animation
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [isOpen]);

  // Clear state when closed
  useEffect(() => {
    if (!isOpen) {
      setQuery('');
      setMatchIndices([]);
      setActiveMatchIdx(0);
      onHighlightChange(new Set(), null, '');
    }
  }, [isOpen, onHighlightChange]);

  // Search logic: scan messages when query changes
  useEffect(() => {
    if (!query.trim()) {
      setMatchIndices([]);
      setActiveMatchIdx(0);
      onHighlightChange(new Set(), null, '');
      return;
    }

    const lowerQuery = query.toLowerCase();
    const indices: number[] = [];

    for (let i = 0; i < messages.length; i++) {
      const text = extractTextFromMessage(messages[i].content);
      if (text.toLowerCase().includes(lowerQuery)) {
        indices.push(i);
      }
    }

    setMatchIndices(indices);
    setActiveMatchIdx(0);

    const matchIds = new Set(indices.map((i) => messages[i].id));
    const activeId = indices.length > 0 ? messages[indices[0]].id : null;
    onHighlightChange(matchIds, activeId, query);
  }, [query, messages, onHighlightChange]);

  const goToMatch = useCallback(
    (idx: number) => {
      if (matchIndices.length === 0) return;
      const wrapped = ((idx % matchIndices.length) + matchIndices.length) % matchIndices.length;
      setActiveMatchIdx(wrapped);
      const msgId = messages[matchIndices[wrapped]].id;
      onHighlightChange(
        new Set(matchIndices.map((i) => messages[i].id)),
        msgId,
        query
      );
      // Scroll into view
      const el = document.getElementById(`msg-${msgId}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    [matchIndices, messages, onHighlightChange, query]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) {
        // Cmd/Ctrl+G behavior — but Enter alone is fine
      }
      if (e.shiftKey) {
        goToMatch(activeMatchIdx - 1);
      } else {
        goToMatch(activeMatchIdx + 1);
      }
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      goToMatch(activeMatchIdx - 1);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-background/95 backdrop-blur-sm">
      <SearchIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search messages..."
        className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/50"
      />
      {query && (
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">
          {matchIndices.length === 0
            ? 'No matches'
            : `${activeMatchIdx + 1} of ${matchIndices.length}`}
        </span>
      )}
      <div className="flex items-center gap-0.5">
        <button
          type="button"
          onClick={() => goToMatch(activeMatchIdx - 1)}
          disabled={matchIndices.length === 0}
          className="p-1 rounded hover:bg-muted disabled:opacity-30 transition-colors"
          title="Previous match (Shift+Enter)"
        >
          <ChevronUpIcon className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={() => goToMatch(activeMatchIdx + 1)}
          disabled={matchIndices.length === 0}
          className="p-1 rounded hover:bg-muted disabled:opacity-30 transition-colors"
          title="Next match (Enter)"
        >
          <ChevronDownIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <button
        type="button"
        onClick={onClose}
        className="p-1 rounded hover:bg-muted transition-colors"
        title="Close (Esc)"
      >
        <XIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
