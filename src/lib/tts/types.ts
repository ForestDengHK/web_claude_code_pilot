/** A timed segment from SRT subtitle data */
export interface TTSTimedSegment {
  /** The text content of this subtitle cue */
  text: string;
  /** Start time in seconds (relative to its chunk) */
  start: number;
  /** End time in seconds (relative to its chunk) */
  end: number;
}

/** A single synthesized chunk with its audio and timing */
export interface TTSChunk {
  /** Base64-encoded MP3 audio for this chunk */
  audio: string;
  /** Timed segments (from SRT) for this chunk */
  segments: TTSTimedSegment[];
}

/** API response from /api/tts */
export interface TTSResponse {
  /** Array of chunks, each with its own audio and segments */
  chunks: TTSChunk[];
}

export type TTSState = 'idle' | 'loading' | 'playing' | 'paused';
