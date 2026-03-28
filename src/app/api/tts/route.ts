import { NextRequest, NextResponse } from 'next/server';
import { spawn } from 'child_process';
import { readFile, writeFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomBytes } from 'crypto';
import { stripMarkdown } from '@/lib/tts/strip-markdown';
import { parseSRT } from '@/lib/tts/parse-srt';
import { getSetting } from '@/lib/db';
import type { TTSChunk, TTSResponse } from '@/lib/tts/types';

const MAX_TEXT_LENGTH = 20000;
// Target chunk size in characters (~2-4 seconds of audio each)
const CHUNK_TARGET = 500;

// Default voices — can be overridden via Settings (tts_voice_en, tts_voice_zh, tts_voice_mixed)
const DEFAULT_VOICE_EN = 'en-US-BrianMultilingualNeural';    // Approachable, casual, sincere
const DEFAULT_VOICE_ZH = 'zh-CN-XiaoxiaoNeural';             // Warm, natural, versatile
const DEFAULT_VOICE_MIXED = 'en-US-BrianMultilingualNeural'; // Multilingual handles code-switching

/**
 * Pick the best voice based on text language mix.
 * Reads user-configured voices from settings, falls back to defaults.
 */
function pickVoice(text: string): string {
  const cjkChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  const ratio = (cjkChars?.length ?? 0) / text.length;

  if (ratio > 0.8) return getSetting('tts_voice_zh') || DEFAULT_VOICE_ZH;
  if (ratio > 0.05) return getSetting('tts_voice_mixed') || DEFAULT_VOICE_MIXED;
  return getSetting('tts_voice_en') || DEFAULT_VOICE_EN;
}

/**
 * Split plain text into chunks at sentence/paragraph boundaries.
 * Each chunk is roughly CHUNK_TARGET chars, split at natural boundaries.
 */
function splitIntoChunks(text: string): string[] {
  // Short text: no splitting needed
  if (text.length <= CHUNK_TARGET * 1.5) return [text];

  // Split into paragraphs first
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    // If adding this paragraph would exceed target, finalize current chunk
    if (current && (current.length + para.length) > CHUNK_TARGET) {
      chunks.push(current.trim());
      current = '';
    }

    // If a single paragraph is very long, split at sentence boundaries
    if (para.length > CHUNK_TARGET * 1.5) {
      if (current) {
        chunks.push(current.trim());
        current = '';
      }
      const sentences = para.split(/(?<=[.!?。！？])\s+/);
      let sentenceChunk = '';
      for (const s of sentences) {
        if (sentenceChunk && (sentenceChunk.length + s.length) > CHUNK_TARGET) {
          chunks.push(sentenceChunk.trim());
          sentenceChunk = '';
        }
        sentenceChunk += (sentenceChunk ? ' ' : '') + s;
      }
      if (sentenceChunk.trim()) {
        current = sentenceChunk;
      }
    } else {
      current += (current ? '\n\n' : '') + para;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks.filter(c => c.length > 0);
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
  const textChunks = splitIntoChunks(plain);
  const batchId = randomBytes(4).toString('hex');

  // Synthesize all chunks in parallel
  const chunkPromises = textChunks.map((chunk, i) => {
    const id = `${batchId}-${i}`;
    const textPath = join(tmpdir(), `codepilot-tts-${id}.txt`);
    const srtPath = join(tmpdir(), `codepilot-tts-${id}.srt`);
    return synthesizeChunk(chunk, voice, textPath, srtPath);
  });

  try {
    const results = await Promise.all(chunkPromises);
    const response: TTSResponse = { chunks: results };
    return NextResponse.json(response);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'TTS synthesis failed';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

async function synthesizeChunk(
  text: string,
  voice: string,
  textPath: string,
  srtPath: string,
): Promise<TTSChunk> {
  try {
    await writeFile(textPath, text, 'utf-8');

    const { audio, srt } = await synthesize(textPath, voice, srtPath);
    const segments = parseSRT(srt);

    return {
      audio: audio.toString('base64'),
      segments,
    };
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
