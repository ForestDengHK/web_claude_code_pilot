import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { readFile, writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { stripMarkdown } from '@/lib/tts/strip-markdown';
import { parseSRT } from '@/lib/tts/parse-srt';
import type { TTSResponse } from '@/lib/tts/types';

// ~20k chars ≈ 5-8 minutes of audio, reasonable upper bound
const MAX_TEXT_LENGTH = 20000;

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
      { error: `Text too long (${plain.length} chars, max ${MAX_TEXT_LENGTH}). Try selecting a shorter section.` },
      { status: 400 },
    );
  }

  const voice = pickVoice(plain);
  const id = randomBytes(8).toString('hex');
  const textPath = join(tmpdir(), `codepilot-tts-${id}.txt`);
  const srtPath = join(tmpdir(), `codepilot-tts-${id}.srt`);

  try {
    // Write text to file — avoids CLI arg length limits for long texts
    await writeFile(textPath, plain, 'utf-8');

    const { audio, srt } = await synthesize(textPath, voice, srtPath);
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
    unlink(textPath).catch(() => {});
    unlink(srtPath).catch(() => {});
  }
}

function synthesize(
  textFilePath: string,
  voice: string,
  srtPath: string,
): Promise<{ audio: Buffer; srt: string }> {
  return new Promise((resolve, reject) => {
    const audioChunks: Buffer[] = [];

    // Use --file instead of --text to avoid CLI arg length limits
    const proc = spawn('edge-tts', [
      '--file', textFilePath,
      '--voice', voice,
      '--write-subtitles', srtPath,
    ]);

    proc.stdout.on('data', (chunk: Buffer) => audioChunks.push(chunk));

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

      let srt = '';
      try {
        srt = await readFile(srtPath, 'utf-8');
      } catch {
        // SRT is optional
      }

      resolve({ audio, srt });
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn edge-tts: ${err.message}`));
    });
  });
}
