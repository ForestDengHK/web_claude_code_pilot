const LOCAL_ABSOLUTE_PREFIXES = [
  '/Users/',
  '/Volumes/',
  '/tmp/',
  '/private/tmp/',
  '/var/folders/',
  '/private/var/folders/',
];

const WINDOWS_ABSOLUTE_PATH_RE = /^[a-zA-Z]:[\\/]/;

function decodeFileUrlPath(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== 'file:') return null;
    const pathname = decodeURIComponent(url.pathname);
    const windowsPath = pathname.match(/^\/([a-zA-Z]:[\\/].*)$/);
    return windowsPath ? windowsPath[1] : pathname;
  } catch {
    return null;
  }
}

export function getLocalFileHrefPath(href: string | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;

  if (/^file:/i.test(trimmed)) {
    return decodeFileUrlPath(trimmed);
  }

  if (trimmed === '~' || trimmed.startsWith('~/')) {
    return trimmed;
  }

  if (WINDOWS_ABSOLUTE_PATH_RE.test(trimmed)) {
    return trimmed;
  }

  if (LOCAL_ABSOLUTE_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) {
    return trimmed;
  }

  return null;
}

export function rewriteLocalFileHref(href: string | undefined, sessionId: string | null): string | undefined {
  const filePath = getLocalFileHrefPath(href);
  if (!filePath) return href;

  const params = new URLSearchParams({ path: filePath });
  if (sessionId) params.set('session_id', sessionId);
  return `/api/files/raw?${params.toString()}`;
}
