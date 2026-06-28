// src/components/terminal/TerminalAccessoryBar.tsx
'use client';

interface TerminalAccessoryBarProps {
  // Push a raw byte sequence into the PTY (same channel as a typed keystroke).
  onKey: (seq: string) => void;
  // Sticky Ctrl: armed → the next typed letter becomes its control char.
  ctrlArmed: boolean;
  onToggleCtrl: () => void;
}

// Phone soft keyboards have no Esc / Tab / Ctrl / arrow keys, so shell completion
// (Tab), history (↑/↓), in-line editing (←/→) and interrupt (Ctrl-C) are all
// unreachable. Each button here pushes the matching escape/control sequence
// straight into the PTY.
const LEFT_KEYS: { label: string; seq: string }[] = [
  { label: 'Esc', seq: '\x1b' },
  { label: 'Tab', seq: '\t' },
];

const RIGHT_KEYS: { label: string; seq: string }[] = [
  { label: '↑', seq: '\x1b[A' },
  { label: '↓', seq: '\x1b[B' },
  { label: '←', seq: '\x1b[D' },
  { label: '→', seq: '\x1b[C' },
  { label: '⌃C', seq: '\x03' },
  { label: '|', seq: '|' },
  { label: '~', seq: '~' },
  { label: '/', seq: '/' },
  { label: '-', seq: '-' },
  { label: '_', seq: '_' },
];

const btn =
  'shrink-0 rounded px-3 py-1.5 text-xs font-medium select-none bg-zinc-800 ' +
  'text-zinc-300 active:bg-zinc-700';

export function TerminalAccessoryBar({ onKey, ctrlArmed, onToggleCtrl }: TerminalAccessoryBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-zinc-800 bg-zinc-900 px-2 py-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {LEFT_KEYS.map((k) => (
        <button
          key={k.label}
          type="button"
          // Acting on pointerdown + preventDefault keeps focus in xterm's hidden
          // textarea, so tapping a key doesn't dismiss the soft keyboard.
          onPointerDown={(e) => { e.preventDefault(); onKey(k.seq); }}
          className={btn}
        >
          {k.label}
        </button>
      ))}
      <button
        type="button"
        onPointerDown={(e) => { e.preventDefault(); onToggleCtrl(); }}
        className={`${btn} ${ctrlArmed ? '!bg-sky-600 !text-white' : ''}`}
      >
        Ctrl
      </button>
      {RIGHT_KEYS.map((k) => (
        <button
          key={k.label}
          type="button"
          onPointerDown={(e) => { e.preventDefault(); onKey(k.seq); }}
          className={btn}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
