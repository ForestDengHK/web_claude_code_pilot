/** A timed segment from SRT subtitle data */
export interface TTSTimedSegment {
  /** The text content of this subtitle cue */
  text: string;
  /** Start time in seconds */
  start: number;
  /** End time in seconds */
  end: number;
}

/** API response from /api/tts */
export interface TTSResponse {
  /** Base64-encoded MP3 audio of the full text */
  audio: string;
  /** Timed segments parsed from SRT */
  segments: TTSTimedSegment[];
}

export type TTSState = 'idle' | 'loading' | 'playing' | 'paused';
