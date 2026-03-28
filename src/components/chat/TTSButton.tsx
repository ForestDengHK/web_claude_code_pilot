'use client';

import { useCallback } from 'react';
import { Volume2Icon, LoaderIcon, PauseIcon, SquareIcon } from 'lucide-react';
import { useTTS } from '@/contexts/TTSContext';

interface TTSButtonProps {
  messageId: string;
  text: string;
}

export function TTSButton({ messageId, text }: TTSButtonProps) {
  const tts = useTTS();

  const isActive = tts.activeMessageId === messageId;
  const state = isActive ? tts.state : 'idle';

  const handleClick = useCallback(() => {
    switch (state) {
      case 'idle':
        tts.play(messageId, text);
        break;
      case 'loading':
        tts.stop();
        break;
      case 'playing':
        tts.pause();
        break;
      case 'paused':
        tts.stop(); // second click = stop (not resume)
        break;
    }
  }, [state, messageId, text, tts]);

  const icon = (() => {
    switch (state) {
      case 'loading':
        return <LoaderIcon className="h-3.5 w-3.5 animate-spin" />;
      case 'playing':
        return <PauseIcon className="h-3.5 w-3.5 text-blue-500" />;
      case 'paused':
        return <SquareIcon className="h-3.5 w-3.5 text-blue-500" />;
      default:
        return <Volume2Icon className="h-3.5 w-3.5" />;
    }
  })();

  const title = (() => {
    switch (state) {
      case 'loading': return 'Cancel';
      case 'playing': return 'Pause';
      case 'paused': return 'Stop';
      default: return 'Read aloud';
    }
  })();

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center justify-center rounded-md min-w-[32px] min-h-[32px] px-1.5 py-1 text-xs text-muted-foreground/60 hover:text-muted-foreground hover:bg-muted active:bg-muted/80 transition-colors"
      title={title}
    >
      {icon}
    </button>
  );
}
