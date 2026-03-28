'use client';

import { createContext, useContext, useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import type { TTSTimedSegment, TTSState } from '@/lib/tts/types';

interface TTSContextValue {
  /** Which message is currently active (playing/paused/loading) */
  activeMessageId: string | null;
  state: TTSState;
  /** Current playback time in seconds */
  currentTime: number;
  /** The timed segments from SRT */
  segments: TTSTimedSegment[];
  /** Start TTS for a message */
  play: (messageId: string, text: string) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
}

const TTSContext = createContext<TTSContextValue | null>(null);

export function useTTS(): TTSContextValue {
  const ctx = useContext(TTSContext);
  if (!ctx) throw new Error('useTTS must be used within TTSProvider');
  return ctx;
}

export function TTSProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TTSState>('idle');
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [segments, setSegments] = useState<TTSTimedSegment[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      audioRef.current?.pause();
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    cleanup();
    setState('idle');
    setActiveMessageId(null);
    setCurrentTime(0);
    setSegments([]);
  }, [cleanup]);

  const play = useCallback((messageId: string, text: string) => {
    // Stop any current playback
    cleanup();

    const controller = new AbortController();
    abortRef.current = controller;

    setState('loading');
    setActiveMessageId(messageId);
    setCurrentTime(0);
    setSegments([]);

    // iOS audio unlock: create/reuse Audio element synchronously in user gesture
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    const audio = audioRef.current;

    // Wire up timeupdate for highlight tracking
    audio.ontimeupdate = () => {
      setCurrentTime(audio.currentTime);
    };
    audio.onended = () => {
      setState('idle');
      setActiveMessageId(null);
      setCurrentTime(0);
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
    audio.onerror = () => {
      setState('idle');
      setActiveMessageId(null);
    };

    // Unlock audio on iOS by playing a tiny silent buffer synchronously
    audio.src = 'data:audio/mp3;base64,SUQzBAAAAAAAI1RTU0VAAAAPAAADTGF2ZjU4Ljc2LjEwMAAAAAAAAAAAAAAA/+M4wAAAAAAAAAAAAEluZm8AAAAPAAAAAwAAAbAAqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV1dXV////////////////////////////////////////////AAAAAExhdmM1OC4xMwAAAAAAAAAAAAAAACQAAAAAAAAAAAGwRGNS8QAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/+M4wAAKiAHIAAAAADFciFAIBAEB4PB4PBAEAQOf/g+D4f/WD4f/5cHw//y4Ph///BAKAICgoP/+D4f/+XB8P//5QfD////ygIAgGBQb/+M4wB0AAAAH/EAAAAD8HwfB8Hw//DLMstBlwEQBAAAAA7TBcM0wPaJbNF8zOhCXP/oRUxqAwNEbJE0N4jxODGo/TKJvTP/+M4wHYAAADSAAAAAO3aA5NSgNDKRSEjxJiUJMYGBkDCRp85kcI1Aot9w8xFYk6HFHt0hOpP//TGa6f///qjJBQmP/iaHh/+M4wLAAAANIAAAAAP///yNEBQT///3///LigoJ//1DhEjv////8jRNf///////yx4eH//+IhIoMAAADSAAAAAAAA';
    audio.play().catch(() => {});

    fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    })
      .then(res => {
        if (!res.ok) return res.json().then(e => { throw new Error(e.error || 'TTS failed'); });
        return res.json();
      })
      .then(data => {
        const { audio: audioBase64, segments: segs } = data;
        setSegments(segs);

        // Convert base64 to blob URL
        const binary = atob(audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;

        // Play the real audio
        audio.src = url;
        audio.play().then(() => {
          setState('playing');
        }).catch(() => {
          setState('idle');
          setActiveMessageId(null);
        });
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          console.error('TTS error:', err);
          setState('idle');
          setActiveMessageId(null);
        }
      });
  }, [cleanup]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setState('paused');
  }, []);

  const resume = useCallback(() => {
    audioRef.current?.play();
    setState('playing');
  }, []);

  return (
    <TTSContext.Provider value={{
      activeMessageId, state, currentTime, segments,
      play, pause, resume, stop,
    }}>
      {children}
    </TTSContext.Provider>
  );
}
