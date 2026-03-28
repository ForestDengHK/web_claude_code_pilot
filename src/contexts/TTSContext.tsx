'use client';

import { createContext, useContext, useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import type { TTSTimedSegment, TTSState } from '@/lib/tts/types';

interface TTSContextValue {
  activeMessageId: string | null;
  state: TTSState;
  /** Index of the currently playing segment (-1 if none) */
  activeSegmentIndex: number;
  /** The timed segments from SRT */
  segments: TTSTimedSegment[];
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
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(-1);
  const [segments, setSegments] = useState<TTSTimedSegment[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const segmentsRef = useRef<TTSTimedSegment[]>([]);
  const segmentIndexRef = useRef(-1);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      audioRef.current?.pause();
      clearInterval(intervalRef.current);
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  /** Poll audio.currentTime and update activeSegmentIndex only when it changes */
  const startSegmentTracking = useCallback(() => {
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      const audio = audioRef.current;
      const segs = segmentsRef.current;
      if (!audio || segs.length === 0 || audio.paused) return;

      const t = audio.currentTime;
      let newIndex = -1;
      for (let i = 0; i < segs.length; i++) {
        if (t >= segs[i].start && (i === segs.length - 1 || t < segs[i + 1].start)) {
          newIndex = i;
          break;
        }
      }

      if (newIndex !== segmentIndexRef.current) {
        segmentIndexRef.current = newIndex;
        setActiveSegmentIndex(newIndex);

      }
    }, 100); // Check 10x/sec but only setState when segment actually changes
  }, []);

  const stopSegmentTracking = useCallback(() => {
    clearInterval(intervalRef.current);
  }, []);

  const cleanup = useCallback(() => {
    abortRef.current?.abort();
    stopSegmentTracking();
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, [stopSegmentTracking]);

  const stop = useCallback(() => {
    cleanup();
    setState('idle');
    setActiveMessageId(null);
    setActiveSegmentIndex(-1);
    segmentIndexRef.current = -1;
    segmentsRef.current = [];
    setSegments([]);
  }, [cleanup]);

  const play = useCallback((messageId: string, text: string) => {
    cleanup();

    const controller = new AbortController();
    abortRef.current = controller;

    setState('loading');
    setActiveMessageId(messageId);
    setActiveSegmentIndex(-1);
    segmentIndexRef.current = -1;
    segmentsRef.current = [];
    setSegments([]);

    // iOS audio unlock: create/reuse Audio element synchronously in user gesture
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    const audio = audioRef.current;

    // Unlock audio on iOS by playing a tiny silent buffer synchronously.
    // IMPORTANT: Don't set onended/onerror yet — the silent clip ending would reset state.
    audio.onended = null;
    audio.onerror = null;
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
        segmentsRef.current = segs;
        setSegments(segs);

        const binary = atob(audioBase64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        blobUrlRef.current = url;

        // Now wire up onended/onerror for the REAL audio (not the silent unlock clip)
        audio.onended = () => {
          stopSegmentTracking();
          setState('idle');
          setActiveMessageId(null);
          setActiveSegmentIndex(-1);
          segmentIndexRef.current = -1;
          if (blobUrlRef.current) {
            URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = null;
          }
        };
        audio.onerror = () => {
          stopSegmentTracking();
          setState('idle');
          setActiveMessageId(null);
        };

        audio.src = url;
        audio.play().then(() => {
          setState('playing');
          startSegmentTracking();
        }).catch((err) => {
          console.error('[TTS] audio.play() failed:', err);
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
  }, [cleanup, startSegmentTracking, stopSegmentTracking]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    stopSegmentTracking();
    setState('paused');
  }, [stopSegmentTracking]);

  const resume = useCallback(() => {
    audioRef.current?.play();
    startSegmentTracking();
    setState('playing');
  }, [startSegmentTracking]);

  return (
    <TTSContext.Provider value={{
      activeMessageId, state, activeSegmentIndex, segments,
      play, pause, resume, stop,
    }}>
      {children}
    </TTSContext.Provider>
  );
}
