'use client';

import { createContext, useContext, useState, useRef, useCallback, useEffect, type ReactNode } from 'react';
import type { TTSTimedSegment, TTSChunk, TTSState } from '@/lib/tts/types';

interface TTSContextValue {
  activeMessageId: string | null;
  state: TTSState;
  activeSegmentIndex: number;
  segments: TTSTimedSegment[];
  play: (messageId: string, text: string) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  /** Seek to a specific segment by global index (tap-to-jump) */
  seekToSegment: (globalIndex: number) => void;
}

const TTSContext = createContext<TTSContextValue | null>(null);

export function useTTS(): TTSContextValue {
  const ctx = useContext(TTSContext);
  if (!ctx) throw new Error('useTTS must be used within TTSProvider');
  return ctx;
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

// ── Cache ──
// Keyed by messageId. Stores processed chunk data so replays are instant.
interface CachedTTS {
  chunks: TTSChunk[];
  allSegments: TTSTimedSegment[];
  segmentMap: Array<{ chunkIdx: number; localIdx: number }>;
}
const ttsCache = new Map<string, CachedTTS>();

export function TTSProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<TTSState>('idle');
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null);
  const [activeSegmentIndex, setActiveSegmentIndex] = useState(-1);
  const [segments, setSegments] = useState<TTSTimedSegment[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // Chunked playback refs
  const chunksRef = useRef<TTSChunk[]>([]);
  const chunkIndexRef = useRef(0);
  const segmentMapRef = useRef<Array<{ chunkIdx: number; localIdx: number }>>([]);

  // Segment tracking
  const segmentIndexRef = useRef(-1);
  const intervalRef = useRef<ReturnType<typeof setInterval>>(undefined);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      audioRef.current?.pause();
      clearInterval(intervalRef.current);
      if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
    };
  }, []);

  const startSegmentTracking = useCallback(() => {
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => {
      const audio = audioRef.current;
      if (!audio || audio.paused) return;

      const ci = chunkIndexRef.current;
      const chunk = chunksRef.current[ci];
      if (!chunk || chunk.segments.length === 0) return;

      const t = audio.currentTime;
      let localIdx = -1;
      for (let i = 0; i < chunk.segments.length; i++) {
        if (t >= chunk.segments[i].start && (i === chunk.segments.length - 1 || t < chunk.segments[i + 1].start)) {
          localIdx = i;
          break;
        }
      }

      const map = segmentMapRef.current;
      const globalIdx = map.findIndex(m => m.chunkIdx === ci && m.localIdx === localIdx);

      if (globalIdx >= 0 && globalIdx !== segmentIndexRef.current) {
        segmentIndexRef.current = globalIdx;
        setActiveSegmentIndex(globalIdx);
      }
    }, 100);
  }, []);

  const stopSegmentTracking = useCallback(() => {
    clearInterval(intervalRef.current);
  }, []);

  const resetState = useCallback(() => {
    stopSegmentTracking();
    setState('idle');
    setActiveMessageId(null);
    setActiveSegmentIndex(-1);
    segmentIndexRef.current = -1;
    chunksRef.current = [];
    chunkIndexRef.current = 0;
    segmentMapRef.current = [];
    setSegments([]);
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, [stopSegmentTracking]);

  const stopAudio = useCallback(() => {
    abortRef.current?.abort();
    stopSegmentTracking();
    if (audioRef.current) {
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      audioRef.current.pause();
      audioRef.current.removeAttribute('src');
      audioRef.current.load();
    }
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, [stopSegmentTracking]);

  /** Play a specific chunk by index */
  const playChunk = useCallback((index: number) => {
    const chunks = chunksRef.current;
    if (index >= chunks.length) {
      resetState();
      return;
    }

    chunkIndexRef.current = index;
    const chunk = chunks[index];
    const audio = audioRef.current!;

    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);

    const blob = base64ToBlob(chunk.audio, 'audio/mpeg');
    const url = URL.createObjectURL(blob);
    blobUrlRef.current = url;

    audio.onended = () => playChunk(index + 1);
    audio.onerror = () => {
      stopSegmentTracking();
      setState('idle');
      setActiveMessageId(null);
    };

    audio.src = url;
    audio.play().then(() => {
      setState('playing');
      startSegmentTracking();
    }).catch(() => {
      setState('idle');
      setActiveMessageId(null);
    });
  }, [resetState, startSegmentTracking, stopSegmentTracking]);

  /** Load cached data into refs and state, then start playback */
  const startFromCache = useCallback((messageId: string, cached: CachedTTS) => {
    chunksRef.current = cached.chunks;
    segmentMapRef.current = cached.segmentMap;
    setSegments(cached.allSegments);
    setActiveMessageId(messageId);
    setState('playing');
    playChunk(0);
  }, [playChunk]);

  const stop = useCallback(() => {
    stopAudio();
    resetState();
  }, [stopAudio, resetState]);

  const play = useCallback((messageId: string, text: string) => {
    stopAudio();

    setActiveSegmentIndex(-1);
    segmentIndexRef.current = -1;
    chunkIndexRef.current = 0;

    // ── Cache hit: instant replay ──
    const cached = ttsCache.get(messageId);
    if (cached) {
      // iOS audio unlock
      if (!audioRef.current) audioRef.current = new Audio();
      audioRef.current.onended = null;
      audioRef.current.onerror = null;
      startFromCache(messageId, cached);
      return;
    }

    // ── Cache miss: fetch from API ──
    const controller = new AbortController();
    abortRef.current = controller;

    setState('loading');
    setActiveMessageId(messageId);
    chunksRef.current = [];
    segmentMapRef.current = [];
    setSegments([]);

    // iOS audio unlock
    if (!audioRef.current) audioRef.current = new Audio();
    const audio = audioRef.current;
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
        const { chunks } = data;

        // Build flattened segments + mapping
        const allSegs: TTSTimedSegment[] = [];
        const map: Array<{ chunkIdx: number; localIdx: number }> = [];
        for (let ci = 0; ci < chunks.length; ci++) {
          for (let si = 0; si < chunks[ci].segments.length; si++) {
            allSegs.push(chunks[ci].segments[si]);
            map.push({ chunkIdx: ci, localIdx: si });
          }
        }

        // Store in cache for instant replay
        ttsCache.set(messageId, { chunks, allSegments: allSegs, segmentMap: map });

        chunksRef.current = chunks;
        segmentMapRef.current = map;
        setSegments(allSegs);

        setState('playing');
        playChunk(0);
      })
      .catch(err => {
        if (err.name !== 'AbortError') {
          console.error('TTS error:', err);
          setState('idle');
          setActiveMessageId(null);
        }
      });
  }, [stopAudio, playChunk, startFromCache]);

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

  /** Seek to a specific segment by global index. Handles cross-chunk seeking. */
  const seekToSegment = useCallback((globalIndex: number) => {
    const map = segmentMapRef.current;
    const chunks = chunksRef.current;
    if (globalIndex < 0 || globalIndex >= map.length || chunks.length === 0) return;

    const { chunkIdx, localIdx } = map[globalIndex];
    const chunk = chunks[chunkIdx];
    if (!chunk) return;

    const targetTime = chunk.segments[localIdx]?.start ?? 0;
    const audio = audioRef.current;
    if (!audio) return;

    // Update segment index immediately for instant highlight feedback
    segmentIndexRef.current = globalIndex;
    setActiveSegmentIndex(globalIndex);

    if (chunkIdx === chunkIndexRef.current) {
      // Same chunk — just seek within current audio
      audio.currentTime = targetTime;
      if (audio.paused) {
        audio.play();
        startSegmentTracking();
        setState('playing');
      }
    } else {
      // Different chunk — need to switch audio source
      stopSegmentTracking();
      playChunkAt(chunkIdx, targetTime);
    }
  }, [startSegmentTracking, stopSegmentTracking]);

  /** Play a chunk starting at a specific time offset */
  const playChunkAt = useCallback((index: number, startTime: number) => {
    const chunks = chunksRef.current;
    if (index >= chunks.length) return;

    chunkIndexRef.current = index;
    const chunk = chunks[index];
    const audio = audioRef.current!;

    if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);

    const blob = base64ToBlob(chunk.audio, 'audio/mpeg');
    const url = URL.createObjectURL(blob);
    blobUrlRef.current = url;

    audio.onended = () => playChunk(index + 1);
    audio.onerror = () => {
      stopSegmentTracking();
      setState('idle');
      setActiveMessageId(null);
    };

    audio.src = url;
    audio.currentTime = startTime;
    audio.play().then(() => {
      setState('playing');
      startSegmentTracking();
    }).catch(() => {
      setState('idle');
      setActiveMessageId(null);
    });
  }, [playChunk, startSegmentTracking, stopSegmentTracking]);

  return (
    <TTSContext.Provider value={{
      activeMessageId, state, activeSegmentIndex, segments,
      play, pause, resume, stop, seekToSegment,
    }}>
      {children}
    </TTSContext.Provider>
  );
}
