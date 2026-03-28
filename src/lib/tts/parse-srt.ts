import type { TTSTimedSegment } from './types';

/**
 * Parse SRT subtitle format into timed segments.
 *
 * SRT format:
 *   1
 *   00:00:00,050 --> 00:00:02,937
 *   Hello world, this is a test.
 *
 *   2
 *   00:00:03,100 --> 00:00:05,200
 *   Another sentence here.
 */
export function parseSRT(srt: string): TTSTimedSegment[] {
  const segments: TTSTimedSegment[] = [];
  const blocks = srt.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    const timeMatch = lines[1].match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
    );
    if (!timeMatch) continue;

    const start = parseTimestamp(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4]);
    const end = parseTimestamp(timeMatch[5], timeMatch[6], timeMatch[7], timeMatch[8]);

    const text = lines.slice(2).join(' ').trim();
    if (text) {
      segments.push({ text, start, end });
    }
  }

  return segments;
}

function parseTimestamp(h: string, m: string, s: string, ms: string): number {
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000;
}
