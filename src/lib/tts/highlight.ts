'use client';

/**
 * Find text in the DOM that corresponds to a TTS segment.
 *
 * The challenge: TTS segments come from stripped text (no code, no emoji),
 * but the DOM still has those elements. So exact matching fails.
 *
 * Strategy: find the first few words and last few words of the segment
 * in the DOM, then create a range spanning from the start of the first
 * match to the end of the last match. This naturally bridges over
 * inline code, emoji, and other stripped content.
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

  // Try exact match first (works when no code/emoji in the segment)
  const exactIdx = accumulated.indexOf(normalized);
  if (exactIdx !== -1) {
    return buildRange(textNodes, accumulated, exactIdx, exactIdx + normalized.length);
  }

  // Fuzzy match: find first anchor words and last anchor words
  const words = normalized.split(/\s+/);
  if (words.length === 0) return null;

  // Take first 3 words and last 3 words as anchors
  const anchorLen = Math.min(3, words.length);
  const startAnchor = words.slice(0, anchorLen).join(' ');
  const endAnchor = words.slice(-anchorLen).join(' ');

  const startIdx = accumulated.indexOf(startAnchor);
  if (startIdx === -1) {
    // Try single first word as fallback
    const firstWord = words[0];
    const singleIdx = accumulated.indexOf(firstWord);
    if (singleIdx === -1) return null;
    // Just highlight what we can find
    const endIdx = endAnchor !== startAnchor ? accumulated.indexOf(endAnchor, singleIdx) : -1;
    if (endIdx !== -1) {
      return buildRange(textNodes, accumulated, singleIdx, endIdx + endAnchor.length);
    }
    return buildRange(textNodes, accumulated, singleIdx, singleIdx + firstWord.length);
  }

  if (startAnchor === endAnchor) {
    return buildRange(textNodes, accumulated, startIdx, startIdx + startAnchor.length);
  }

  const endIdx = accumulated.indexOf(endAnchor, startIdx + startAnchor.length);
  if (endIdx === -1) {
    // End anchor not found, just highlight from start anchor to a reasonable distance
    return buildRange(textNodes, accumulated, startIdx, Math.min(startIdx + normalized.length + 50, accumulated.length));
  }

  return buildRange(textNodes, accumulated, startIdx, endIdx + endAnchor.length);
}

/** Build a DOM Range from accumulated text offsets */
function buildRange(
  textNodes: { node: Text; start: number }[],
  accumulated: string,
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
    // If matchEnd goes beyond last node, use the last node's end
    if (i === textNodes.length - 1 && !endNode && startNode) {
      endNode = tn;
      endOffset = tn.textContent?.length || 0;
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
