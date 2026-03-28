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
  const textNodes: { node: Text; start: number }[] = [];
  let accumulated = '';

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const raw = node.textContent || '';
    const norm = normalizeWhitespace(raw);
    textNodes.push({ node, start: accumulated.length });
    accumulated += norm;
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
 * Highlight a Range by placing overlay divs on top of each client rect.
 * Uses getClientRects() for multi-line support. No DOM mutation of the text content.
 * Returns a cleanup function.
 */
export function highlightRange(range: Range, container: HTMLElement): () => void {
  // Ensure container is positioned for overlay placement
  const prevPosition = container.style.position;
  if (!prevPosition || prevPosition === 'static') {
    container.style.position = 'relative';
  }

  const containerRect = container.getBoundingClientRect();
  const rects = range.getClientRects();
  const overlays: HTMLDivElement[] = [];

  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    // Skip tiny rects (whitespace artifacts)
    if (rect.width < 2 || rect.height < 2) continue;

    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position: absolute;
      left: ${rect.left - containerRect.left}px;
      top: ${rect.top - containerRect.top}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      background: rgba(250, 204, 21, 0.35);
      border-radius: 3px;
      pointer-events: none;
      z-index: 5;
    `;
    container.appendChild(overlay);
    overlays.push(overlay);
  }

  return () => {
    for (const o of overlays) o.remove();
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
