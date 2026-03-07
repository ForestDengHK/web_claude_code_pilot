'use client';

import { useState, useRef, useCallback, useEffect } from 'react';

interface UseVoiceInputOptions {
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}

interface UseVoiceInputReturn {
  isRecording: boolean;
  isTranscribing: boolean;
  duration: number;
  startRecording: () => void;
  stopRecording: () => void;
  toggleRecording: () => void;
  isAvailable: boolean;
}

const MIN_RECORDING_MS = 500;

export function useVoiceInput({ onTranscript, onError }: UseVoiceInputOptions): UseVoiceInputReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [duration, setDuration] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);

  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  useEffect(() => { onTranscriptRef.current = onTranscript; }, [onTranscript]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);

  const isAvailable = typeof window !== 'undefined'
    && window.isSecureContext
    && !!navigator.mediaDevices?.getUserMedia;

  const cleanup = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const transcribe = useCallback(async (blob: Blob) => {
    setIsTranscribing(true);
    try {
      const formData = new FormData();
      formData.append('file', blob, 'recording.webm');

      const res = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        onErrorRef.current(data.error || 'Transcription failed');
        return;
      }

      const text = (data.text || '').trim();
      if (text) {
        onTranscriptRef.current(text);
      }
    } catch {
      onErrorRef.current('Failed to connect to transcription service');
    } finally {
      setIsTranscribing(false);
    }
  }, []);

  const startRecording = useCallback(async () => {
    if (!isAvailable) {
      onErrorRef.current('HTTPS required for microphone access');
      return;
    }
    if (isRecording || isTranscribing) return;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const recordingDuration = Date.now() - startTimeRef.current;
        stream.getTracks().forEach(track => track.stop());
        streamRef.current = null;

        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }

        if (recordingDuration < MIN_RECORDING_MS) {
          chunksRef.current = [];
          setIsRecording(false);
          setDuration(0);
          return;
        }

        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        chunksRef.current = [];
        setIsRecording(false);
        setDuration(0);

        transcribe(blob);
      };

      recorder.start();
      startTimeRef.current = Date.now();
      setIsRecording(true);
      setDuration(0);

      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
      }, 1000);
    } catch (err) {
      cleanup();
      setIsRecording(false);
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        onErrorRef.current('Microphone access denied');
      } else {
        onErrorRef.current('Failed to access microphone');
      }
    }
  }, [isAvailable, isRecording, isTranscribing, transcribe, cleanup]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const toggleRecording = useCallback(() => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, startRecording, stopRecording]);

  return {
    isRecording,
    isTranscribing,
    duration,
    startRecording,
    stopRecording,
    toggleRecording,
    isAvailable,
  };
}
