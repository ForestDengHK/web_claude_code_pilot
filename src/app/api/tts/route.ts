// src/app/api/tts/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { stripMarkdown } from '@/lib/tts/strip-markdown';
import { parseSRT } from '@/lib/tts/parse-srt';
import type { TTSResponse } from '@/lib/tts/types';

const MAX_TEXT_LENGTH = 5000;

/** Detect if text is primarily CJK */
function isCJK(text: string): boolean {
  const cjkChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  return (cjkChars?.length ?? 0) / text.length > 0.3;
}

function pickVoice(text: string): string {
  return isCJK(text)
    ? 'zh-CN-XiaoxiaoNeural'
    : 'en-US-AndrewMultilingualNeural';
}

export async function POST(request: NextRequest) {
  let body: { text?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { text } = body;
  if (!text || typeof text !== 'string') {
    return NextResponse.json({ error: 'Missing text' }, { status: 400 });
  }

  const plain = stripMarkdown(text);
  if (!plain) {
    return NextResponse.json({ error: 'No speakable text after stripping markdown' }, { status: 400 });
  }
  if (plain.length > MAX_TEXT_LENGTH) {
    return NextResponse.json(
      { error: `Text too long (${plain.length} chars, max ${MAX_TEXT_LENGTH})` },
      { status: 400 },
    );
  }

  const voice = pickVoice(plain);

  // Temp file for SRT subtitles (edge-tts needs a file path for --write-subtitles)
  const srtPath = join(tmpdir(), `codepilot-tts-${randomBytes(8).toString('hex')}.srt`);

  try {
    const { audio, srt } = await synthesize(plain, voice, srtPath);
    const segments = parseSRT(srt);

    const response: TTSResponse = {
      audio: audio.toString('base64'),
      segments,
    };

    return NextResponse.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'TTS synthesis failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  } finally {
    // Cleanup temp SRT file
    unlink(srtPath).catch(() => {});
  }
}

function synthesize(
  text: string,
  voice: string,
  srtPath: string,
): Promise<{ audio: Buffer; srt: string }> {
  return new Promise((resolve, reject) => {
    const audioChunks: Buffer[] = [];

    // edge-tts writes audio to stdout by default, subtitles to the specified file
    const proc = spawn('edge-tts', [
      '--text', text,
      '--voice', voice,
      '--write-subtitles', srtPath,
    ]);

    proc.stdout.on('data', (chunk: Buffer) => audioChunks.push(chunk));

    // Collect stderr for error messages
    let stderrText = '';
    proc.stderr.on('data', (chunk: Buffer) => { stderrText += chunk.toString(); });

    proc.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`edge-tts exited with code ${code}: ${stderrText}`));
        return;
      }

      const audio = Buffer.concat(audioChunks);
      if (audio.length === 0) {
        reject(new Error('edge-tts produced no audio output'));
        return;
      }

      // Read the SRT file
      let srt = '';
      try {
        srt = await readFile(srtPath, 'utf-8');
      } catch {
        // SRT is optional — we can still play audio without highlighting
      }

      resolve({ audio, srt });
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn edge-tts: ${err.message}`));
    });
  });
}
