/**
 * Telegram media handling — download photos and document images.
 */

import crypto from 'crypto';
import type { FileAttachment } from '@/types';
import { getSetting } from '../../db';
import { MAX_TELEGRAM_FILE_SIZE as MAX_FILE_SIZE, TELEGRAM_API, TELEGRAM_OPTIMAL_LONG_EDGE } from '@/lib/config';

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface MediaDownloadResult {
  attachment?: FileAttachment;
  rejected?: 'too_large' | 'download_failed' | 'unsupported_type';
  rejectedMessage?: string;
}

const OPTIMAL_LONG_EDGE = TELEGRAM_OPTIMAL_LONG_EDGE;

const SUPPORTED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
]);

const EXTENSION_MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/**
 * Check if image handling is enabled via settings.
 */
export function isImageEnabled(): boolean {
  return getSetting('bridge_telegram_image_enabled') !== 'false';
}

/**
 * Check if a MIME type is a supported image format.
 */
export function isSupportedImageMime(mime: string): boolean {
  return SUPPORTED_IMAGE_MIMES.has(mime);
}

/**
 * Infer MIME type from a filename extension. Returns null if unknown.
 */
export function inferMimeType(filename: string): string | null {
  const dotIdx = filename.lastIndexOf('.');
  if (dotIdx < 0) return null;
  const ext = filename.slice(dotIdx).toLowerCase();
  return EXTENSION_MIME_MAP[ext] ?? null;
}

/**
 * Select the optimal photo size from an array of Telegram PhotoSize objects.
 *
 * Strategy: pick the smallest photo whose long edge >= 1568px (Claude vision optimal).
 * If none qualify, pick the largest available.
 */
export function selectOptimalPhoto(photos: TelegramPhotoSize[]): TelegramPhotoSize | null {
  if (!photos || photos.length === 0) return null;

  // Filter candidates where long edge >= optimal
  const qualifying = photos.filter(
    (p) => Math.max(p.width, p.height) >= OPTIMAL_LONG_EDGE,
  );

  if (qualifying.length > 0) {
    // Pick the smallest qualifying (by long edge)
    qualifying.sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
    return qualifying[0];
  }

  // None qualify — pick the largest available
  const sorted = [...photos].sort(
    (a, b) => Math.max(b.width, b.height) - Math.max(a.width, a.height),
  );
  return sorted[0];
}

/**
 * Download a file from Telegram by file_id with exponential backoff.
 * Returns the file content as a Buffer, or null on failure.
 */
async function downloadFileById(
  botToken: string,
  fileId: string,
  maxRetries: number = 3,
): Promise<Buffer | null> {
  // Step 1: get file path via getFile
  let filePath: string | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${TELEGRAM_API}/bot${botToken}/getFile`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_id: fileId }),
      });

      const body = await res.json() as { ok: boolean; result?: { file_path?: string } };
      if (body.ok && body.result?.file_path) {
        filePath = body.result.file_path;
        break;
      }

      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    } catch {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  if (!filePath) return null;

  // Step 2: download the file
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const downloadUrl = `${TELEGRAM_API}/file/bot${botToken}/${filePath}`;
      const res = await fetch(downloadUrl);
      if (!res.ok) {
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
          continue;
        }
        return null;
      }
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch {
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
  }

  return null;
}

/**
 * Download the best photo from a Telegram photo array.
 * Returns a MediaDownloadResult with a base64-encoded FileAttachment.
 */
export async function downloadPhoto(
  botToken: string,
  photos: TelegramPhotoSize[],
  messageId: string,
): Promise<MediaDownloadResult> {
  const photo = selectOptimalPhoto(photos);
  if (!photo) {
    return { rejected: 'download_failed', rejectedMessage: 'No photo sizes available' };
  }

  if (photo.file_size && photo.file_size > MAX_FILE_SIZE) {
    return {
      rejected: 'too_large',
      rejectedMessage: `Photo too large: ${(photo.file_size / 1024 / 1024).toFixed(1)} MB`,
    };
  }

  const buffer = await downloadFileById(botToken, photo.file_id);
  if (!buffer) {
    return { rejected: 'download_failed', rejectedMessage: 'Failed to download photo from Telegram' };
  }

  const attachment: FileAttachment = {
    id: crypto.randomUUID(),
    name: `telegram-photo-${messageId}.jpg`,
    type: 'image/jpeg',
    size: buffer.length,
    data: buffer.toString('base64'),
  };

  return { attachment };
}

/**
 * Download a document if it's a supported image type.
 */
export async function downloadDocumentImage(
  botToken: string,
  doc: TelegramDocument,
  messageId: string,
): Promise<MediaDownloadResult> {
  // Determine MIME type
  let mime = doc.mime_type ?? null;
  if (!mime && doc.file_name) {
    mime = inferMimeType(doc.file_name);
  }

  if (!mime || !isSupportedImageMime(mime)) {
    return {
      rejected: 'unsupported_type',
      rejectedMessage: `Unsupported document type: ${mime ?? 'unknown'}`,
    };
  }

  if (doc.file_size && doc.file_size > MAX_FILE_SIZE) {
    return {
      rejected: 'too_large',
      rejectedMessage: `Document too large: ${(doc.file_size / 1024 / 1024).toFixed(1)} MB`,
    };
  }

  const buffer = await downloadFileById(botToken, doc.file_id);
  if (!buffer) {
    return { rejected: 'download_failed', rejectedMessage: 'Failed to download document from Telegram' };
  }

  const fileName = doc.file_name ?? `telegram-doc-${messageId}`;
  const attachment: FileAttachment = {
    id: crypto.randomUUID(),
    name: fileName,
    type: mime,
    size: buffer.length,
    data: buffer.toString('base64'),
  };

  return { attachment };
}
