/**
 * Centralized operational configuration.
 *
 * All tunable constants live here — file size limits, timeouts, cache TTLs,
 * shared URLs, etc. Import from '@/lib/config' instead of hardcoding values.
 *
 * Constants that are purely UI/layout (panel sizes, collapse heights) or
 * module-internal with no chance of being reused stay in their own files.
 */

// ─── File size limits ────────────────────────────────────────────────────────

/** General file upload limit (chat attachments, file-tree upload) */
export const MAX_UPLOAD_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

/** Human-readable label for the general upload limit (error messages / UI) */
export const MAX_UPLOAD_FILE_SIZE_LABEL = '50 MB';

/** Session JSONL parsing limit (skip very large session files) */
export const MAX_SESSION_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

/** PDF request body limit */
export const MAX_PDF_REQUEST_SIZE = 10 * 1024 * 1024; // 10 MB

/** Telegram Bot API getFile limit (imposed by Telegram, not us) */
export const MAX_TELEGRAM_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

/** Max message / input length for bridge context */
export const MAX_MESSAGE_LENGTH = 2000;

/** Max input length accepted by bridge validators */
export const MAX_INPUT_LENGTH = 32_000;

/** Max TTS text length */
export const MAX_TTS_TEXT_LENGTH = 100_000;

// ─── Timeouts ────────────────────────────────────────────────────────────────

/** Approval / permission / input-request pending timeout */
export const REGISTRY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min

/** Git clone operation timeout */
export const CLONE_TIMEOUT_MS = 120_000; // 2 min

/** Minimum voice recording duration before accepting */
export const MIN_RECORDING_MS = 500;

// ─── Cache TTLs ──────────────────────────────────────────────────────────────

/** Binary path cache (platform.ts) */
export const BINARY_CACHE_TTL = 60_000; // 60 s

/** Model list cache */
export const MODELS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

/** Skills list cache */
export const SKILLS_CACHE_TTL = 5 * 60 * 1000; // 5 min

/** Claude usage info cache */
export const USAGE_CACHE_TTL = 5 * 60 * 1000; // 5 min

/** Session "active" threshold (consider file recently modified) */
export const SESSION_ACTIVE_THRESHOLD_MS = 10 * 60 * 1000; // 10 min

// ─── URLs & hosts ────────────────────────────────────────────────────────────

/** Telegram Bot API base URL */
export const TELEGRAM_API = 'https://api.telegram.org';

/** Default git hosting service */
export const DEFAULT_GIT_HOST = 'https://github.com';

// ─── File extensions (shared across components) ──────────────────────────────

/** Image file extensions recognised across the app */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.bmp', '.ico'] as const;

/** Image extensions as a Set (for O(1) lookups) */
export const IMAGE_EXTENSIONS_SET = new Set<string>(IMAGE_EXTENSIONS);

// ─── TTS ─────────────────────────────────────────────────────────────────────

/** Target characters per TTS chunk (~2-4 seconds of audio) */
export const TTS_CHUNK_TARGET = 500;

/** Max concurrent TTS synthesis requests */
export const TTS_MAX_CONCURRENT = 5;

/** Default TTS voice — English */
export const TTS_VOICE_EN = 'en-US-BrianMultilingualNeural';

/** Default TTS voice — Chinese */
export const TTS_VOICE_ZH = 'zh-CN-XiaoxiaoNeural';

/** Default TTS voice — Mixed / code-switching */
export const TTS_VOICE_MIXED = 'en-US-BrianMultilingualNeural';

// ─── Misc ────────────────────────────────────────────────────────────────────

/** Filename validation regex (mkdir, upload) */
export const INVALID_NAME_PATTERN = /[/\\:*?"<>|\0]|\.\./;

/** Telegram optimal long-edge for Claude vision */
export const TELEGRAM_OPTIMAL_LONG_EDGE = 1568;
