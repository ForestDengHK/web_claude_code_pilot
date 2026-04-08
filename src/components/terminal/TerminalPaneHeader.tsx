// src/components/terminal/TerminalPaneHeader.tsx
'use client';

import { useState, useRef } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Cancel01Icon, Maximize01Icon, Minimize01Icon } from '@hugeicons/core-free-icons';

interface TerminalPaneHeaderProps {
  title: string;
  isFocused: boolean;
  onClose: () => void;
  onToggleFocus: () => void;
  onRename: (newTitle: string) => void;
}

export function TerminalPaneHeader({
  title, isFocused, onClose, onToggleFocus, onRename,
}: TerminalPaneHeaderProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);

  function startEdit() {
    setDraft(title);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  }

  function commitEdit() {
    const t = draft.trim();
    if (t) onRename(t);
    setEditing(false);
  }

  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-zinc-800 bg-zinc-900 px-3">
      {editing ? (
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitEdit();
            if (e.key === 'Escape') setEditing(false);
          }}
          className="min-w-0 flex-1 bg-transparent text-xs text-zinc-100 outline-none"
          autoFocus
        />
      ) : (
        <span
          className="min-w-0 flex-1 cursor-pointer truncate text-xs text-zinc-400 hover:text-zinc-200"
          onDoubleClick={startEdit}
          title="Double-click to rename"
        >
          {title}
        </span>
      )}
      <button
        type="button"
        onClick={onToggleFocus}
        className="rounded p-0.5 text-zinc-500 hover:text-zinc-200"
        title={isFocused ? 'Restore grid' : 'Maximize'}
      >
        <HugeiconsIcon
          icon={isFocused ? Minimize01Icon : Maximize01Icon}
          className="h-3.5 w-3.5"
        />
      </button>
      <button
        type="button"
        onClick={onClose}
        className="rounded p-0.5 text-zinc-500 hover:text-red-400"
        title="Close terminal"
      >
        <HugeiconsIcon icon={Cancel01Icon} className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
