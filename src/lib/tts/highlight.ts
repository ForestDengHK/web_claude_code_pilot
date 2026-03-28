'use client';

/**
 * Find a text substring within a DOM container and return a Range covering it.
 * Uses TreeWalker to walk text nodes. Normalizes whitespace for fuzzy matching
 * since Streamdown rendering may differ from raw text whitespace.
 */
export function findTextRange(container: HTMLElement, searchText: string): Range | null {
  const normalized = normalizeWhitespace(searchText);
  if (!normalized) return null;

  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: { node: Text; start: number; rawStart: number }[] = [];
  let accumulated = '';
  let rawAccumulated = '';

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const raw = node.textContent || '';
    const norm = normalizeWhitespace(raw);
    textNodes.push({ node, start: accumulated.length, rawStart: rawAccumulated.length });
    accumulated += norm;
    rawAccumulated += raw;
  }

  const matchIndex = accumulated.indexOf(normalized);
  if (matchIndex === -1) return null;
  const matchEnd = matchIndex + normalized.length;

  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  for (let i = 0; i < textNodes.length; i++) {
    const { node: tn, start } = textNodes[i];
    const normLen = normalizeWhitespace(tn.textContent || '').length;
    const end = start + normLen;

    if (!startNode && matchIndex >= start && matchIndex < end) {
      startNode = tn;
      startOffset = mapNormToRawOffset(tn.textContent || '', matchIndex - start);
    }
    if (matchEnd > start && matchEnd <= end) {
      endNode = tn;
      endOffset = mapNormToRawOffset(tn.textContent || '', matchEnd - start);
      break;
    }
  }

  if (!startNode || !endNode) return null;

  try {
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  } catch {
    return null;
  }
}

/**
 * Apply CSS Custom Highlight API. Returns a cleanup function.
 * Falls back to a positioned overlay div if Highlight API is unavailable.
 */
export function highlightRange(range: Range, container: HTMLElement): () => void {
  if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
    ensureHighlightStyle();
    const highlight = new Highlight(range);
    (CSS.highlights as Map<string, Highlight>).set('tts-active', highlight);
    return () => {
      (CSS.highlights as Map<string, Highlight>).delete('tts-active');
    };
  }

  // Fallback: absolutely positioned overlay (no DOM mutation)
  const rect = range.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  const overlay = document.createElement('div');
  overlay.className = 'tts-highlight-overlay';
  overlay.style.cssText = `
    position: absolute;
    left: ${rect.left - containerRect.left}px;
    top: ${rect.top - containerRect.top}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    background: rgba(59, 130, 246, 0.2);
    border-radius: 2px;
    pointer-events: none;
    transition: all 0.15s ease;
    z-index: 1;
  `;

  const prevPosition = container.style.position;
  if (!prevPosition || prevPosition === 'static') {
    container.style.position = 'relative';
  }
  container.appendChild(overlay);

  return () => {
    overlay.remove();
    if (!prevPosition || prevPosition === 'static') {
      container.style.position = prevPosition;
    }
  };
}

/**
 * Scroll the range into view within the chat scroll container.
 */
export function scrollToRange(range: Range, scrollContainer: Element | null): void {
  if (!scrollContainer) return;
  const rect = range.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();
  if (rect.bottom > containerRect.bottom || rect.top < containerRect.top) {
    range.startContainer.parentElement?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  }
}

/** Inject ::highlight(tts-active) CSS once (Turbopack can't parse it statically) */
let highlightStyleInjected = false;
function ensureHighlightStyle(): void {
  if (highlightStyleInjected) return;
  try {
    const style = document.createElement('style');
    style.textContent = '::highlight(tts-active) { background-color: rgba(59, 130, 246, 0.2); }';
    document.head.appendChild(style);
    highlightStyleInjected = true;
  } catch {
    // Ignore — fallback overlay will be used
  }
}

function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function mapNormToRawOffset(raw: string, normOffset: number): number {
  let ni = 0;
  let inSpace = false;
  let ri = 0;
  while (ri < raw.length && /\s/.test(raw[ri])) ri++;

  for (; ri < raw.length && ni < normOffset; ri++) {
    if (/\s/.test(raw[ri])) {
      if (!inSpace) {
        ni++;
        inSpace = true;
      }
    } else {
      ni++;
      inSpace = false;
    }
  }
  return ri;
}
