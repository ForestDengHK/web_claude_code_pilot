'use client';

/**
 * Find text in the DOM that corresponds to a TTS segment.
 *
 * The challenge: TTS segments come from stripped text (no code, no emoji),
 * but the DOM still has those elements. So exact matching fails when
 * stripped content (like inline code) was between words.
 *
 * Strategy:
 * 1. Try exact match first (fast path, works for simple segments)
 * 2. Fuzzy match: find the first word in the DOM, then find the last word
 *    AFTER the first word. Highlight everything between them. This naturally
 *    bridges over inline code, emoji, bold markers, etc.
 */
export function findTextRange(container: HTMLElement, searchText: string): Range | null {
  const normalized = normalizeWhitespace(searchText);
  if (!normalized) return null;

  // Collect all text nodes and build accumulated text
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: { node: Text; start: number }[] = [];
  let accumulated = '';

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const raw = node.textContent || '';
    const norm = normalizeWhitespace(raw);
    if (norm) {
      textNodes.push({ node, start: accumulated.length });
      accumulated += (accumulated ? ' ' : '') + norm;
    }
  }

  if (!accumulated) return null;

  // Try exact match first
  const exactIdx = accumulated.indexOf(normalized);
  if (exactIdx !== -1) {
    return buildRange(textNodes, accumulated, exactIdx, exactIdx + normalized.length);
  }

  // Fuzzy match using first word + last word as anchors
  const words = normalized.split(/\s+/).filter(w => w.length > 0);
  if (words.length === 0) return null;

  // Find start anchor: try first 2 words, then first word, then progressively
  // shorter prefixes (handles CJK text split by bold/italic formatting)
  let startIdx = -1;
  if (words.length >= 2) {
    startIdx = accumulated.indexOf(words[0] + ' ' + words[1]);
  }
  if (startIdx === -1) {
    startIdx = accumulated.indexOf(words[0]);
  }
  if (startIdx === -1) {
    // CJK fallback: the first "word" may be a long CJK string that got split
    // by formatting (e.g., "果然设置页面里没有" but DOM has "果然设置页面里" + "没有")
    // Try progressively shorter prefixes (min 4 chars to avoid false positives)
    const firstWord = words[0];
    for (let len = firstWord.length - 1; len >= Math.min(4, firstWord.length); len--) {
      startIdx = accumulated.indexOf(firstWord.slice(0, len));
      if (startIdx !== -1) break;
    }
  }
  if (startIdx === -1) return null;

  // Single word segment — just highlight that word
  if (words.length === 1) {
    return buildRange(textNodes, accumulated, startIdx, startIdx + words[0].length);
  }

  // Find end anchor: try last word, searching AFTER startIdx
  const lastWord = words[words.length - 1];
  // Search from a position after the start to avoid matching the same word
  const searchFrom = startIdx + words[0].length;
  let endIdx = accumulated.indexOf(lastWord, searchFrom);

  if (endIdx === -1) {
    // Last word not found — try second-to-last word
    if (words.length >= 3) {
      const altWord = words[words.length - 2];
      endIdx = accumulated.indexOf(altWord, searchFrom);
      if (endIdx !== -1) {
        return buildRange(textNodes, accumulated, startIdx, endIdx + altWord.length);
      }
    }
    // Still not found — highlight from start to a reasonable length
    return buildRange(textNodes, accumulated, startIdx, Math.min(startIdx + 80, accumulated.length));
  }

  return buildRange(textNodes, accumulated, startIdx, endIdx + lastWord.length);
}

/** Build a DOM Range from accumulated text offsets */
function buildRange(
  textNodes: { node: Text; start: number }[],
  _accumulated: string,
  matchStart: number,
  matchEnd: number,
): Range | null {
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  for (let i = 0; i < textNodes.length; i++) {
    const { node: tn, start } = textNodes[i];
    const normLen = normalizeWhitespace(tn.textContent || '').length;
    const end = start + normLen;

    if (!startNode && matchStart >= start && matchStart < end) {
      startNode = tn;
      startOffset = mapNormToRawOffset(tn.textContent || '', matchStart - start);
    }
    if (matchEnd > start && matchEnd <= end) {
      endNode = tn;
      endOffset = mapNormToRawOffset(tn.textContent || '', matchEnd - start);
      break;
    }
    // If we've passed the matchEnd, use end of previous node
    if (start > matchEnd && !endNode && startNode) {
      const prev = textNodes[i - 1];
      endNode = prev.node;
      endOffset = prev.node.textContent?.length || 0;
      break;
    }
  }

  // If matchEnd extends past last text node
  if (startNode && !endNode) {
    const last = textNodes[textNodes.length - 1];
    endNode = last.node;
    endOffset = last.node.textContent?.length || 0;
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
 * Returns a cleanup function.
 */
export function highlightRange(range: Range, container: HTMLElement): () => void {
  const prevPosition = container.style.position;
  if (!prevPosition || prevPosition === 'static') {
    container.style.position = 'relative';
  }

  const containerRect = container.getBoundingClientRect();
  const rects = range.getClientRects();
  const overlays: HTMLDivElement[] = [];

  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
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
