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

  // Streaming state refs
  const streamingDoneRef = useRef(true);
  const pendingPlayIndexRef = useRef<number | null>(null);

  // Mirror state into a ref for use in event handlers (avoids stale closures)
  const stateRef = useRef<TTSState>('idle');
  useEffect(() => { stateRef.current = state; }, [state]);

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

  // ── Mobile: resume audio when returning from background ──
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const audio = audioRef.current;
      if (!audio) return;

      // Resume if we were playing but the OS paused the audio
      if (stateRef.current === 'playing' && audio.paused) {
        audio.play().catch(() => {
          // If play fails (gesture required), user can tap resume
        });
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
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
    pendingPlayIndexRef.current = null;
    setSegments([]);
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current);
      blobUrlRef.current = null;
    }
  }, [stopSegmentTracking]);

  const stopAudio = useCallback(() => {
    abortRef.current?.abort();
    stopSegmentTracking();
    pendingPlayIndexRef.current = null;
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
      if (streamingDoneRef.current) {
        // All chunks played and streaming finished
        resetState();
      } else {
        // Still streaming — wait for the next chunk to arrive
        pendingPlayIndexRef.current = index;
        // Keep state as 'playing' so UI doesn't flash; audio is just briefly silent
      }
      return;
    }

    pendingPlayIndexRef.current = null;
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
    streamingDoneRef.current = true;
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
    streamingDoneRef.current = false;
    pendingPlayIndexRef.current = null;

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

    // ── Cache miss: streaming fetch with progressive playback ──
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

    // Read NDJSON stream — play first chunk immediately, accumulate rest
    (async () => {
      let firstChunkStarted = false;
      const allChunks: TTSChunk[] = [];
      const allSegs: TTSTimedSegment[] = [];
      const map: Array<{ chunkIdx: number; localIdx: number }> = [];

      try {
        const response = await fetch('/api/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'TTS failed' }));
          throw new Error(err.error || 'TTS failed');
        }

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop()!; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;
            const parsed = JSON.parse(line);

            // Server may send an error line on synthesis failure
            if (parsed.error) {
              throw new Error(parsed.error);
            }

            const chunk: TTSChunk = parsed;
            const chunkIdx = allChunks.length;
            allChunks.push(chunk);

            for (let si = 0; si < chunk.segments.length; si++) {
              allSegs.push(chunk.segments[si]);
              map.push({ chunkIdx, localIdx: si });
            }

            // Update refs so playChunk can access new chunks
            chunksRef.current = allChunks.slice();
            segmentMapRef.current = map.slice();
            setSegments(allSegs.slice());

            if (!firstChunkStarted) {
              firstChunkStarted = true;
              playChunk(0);
            } else {
              // If playback was waiting for this chunk, trigger it
              const pending = pendingPlayIndexRef.current;
              if (pending !== null && pending < allChunks.length) {
                pendingPlayIndexRef.current = null;
                playChunk(pending);
              }
            }
          }
        }

        // Streaming complete — cache the full result
        streamingDoneRef.current = true;
        if (allChunks.length > 0) {
          ttsCache.set(messageId, { chunks: allChunks, allSegments: allSegs, segmentMap: map });
        }

        // If playback was waiting and we have the chunk, play it; otherwise finish
        const pending = pendingPlayIndexRef.current;
        if (pending !== null) {
          pendingPlayIndexRef.current = null;
          if (pending < allChunks.length) {
            playChunk(pending);
          } else {
            resetState();
          }
        }

      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;

        console.error('TTS streaming error:', err);

        // Mark streaming as done so playback won't wait for more chunks
        streamingDoneRef.current = true;

        if (allChunks.length > 0 && firstChunkStarted) {
          // We already have chunks playing — let playback continue with what we got.
          // Partial cache (better than nothing for replay).
          ttsCache.set(messageId, { chunks: allChunks, allSegments: allSegs, segmentMap: map });

          // If playback was waiting for a chunk that won't arrive, reset
          const pending = pendingPlayIndexRef.current;
          if (pending !== null && pending >= allChunks.length) {
            pendingPlayIndexRef.current = null;
            // Current audio will end naturally → playChunk(next) → resetState
          }
        } else {
          // No chunks received at all — reset to idle
          setState('idle');
          setActiveMessageId(null);
        }
      }
    })();
  }, [stopAudio, playChunk, startFromCache, resetState]);

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
