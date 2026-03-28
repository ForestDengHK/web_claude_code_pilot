'use client';

/**
 * Find text in the DOM that corresponds to a TTS segment.
 *
 * The challenge: TTS segments come from stripped text (no code, no emoji),
 * but the DOM still has those elements.
 *
 * Strategy: Use raw text node concatenation (no artificial spaces) and
 * subsequence matching — walk through the search text character by character,
 * finding each character in the accumulated DOM text. This handles any
 * amount of extra content (code, emoji, bold markers) between characters.
 */
export function findTextRange(container: HTMLElement, searchText: string): Range | null {
  const search = searchText.replace(/\s+/g, ' ').trim();
  if (!search) return null;

  // Collect all text nodes with their raw content
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const textNodes: { node: Text; start: number }[] = [];
  let accumulated = '';

  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const raw = node.textContent || '';
    if (!raw) continue;
    textNodes.push({ node, start: accumulated.length });
    accumulated += raw;
  }

  if (!accumulated) return null;

  // Try exact match first (fast path)
  const exactIdx = accumulated.indexOf(search);
  if (exactIdx !== -1) {
    return buildRange(textNodes, exactIdx, exactIdx + search.length);
  }

  // Subsequence match: find the first and last characters of the search text
  // in the accumulated DOM text, allowing extra content in between.
  // This handles cases like:
  //   search: "目标目录 () 写死了"  (code stripped, empty parens)
  //   DOM:    "目标目录 (/Users/party/working) 写死了"  (code still present)

  const firstMatchStart = findSubsequenceStart(accumulated, search);
  if (firstMatchStart === -1) return null;

  const lastMatchEnd = findSubsequenceEnd(accumulated, search, firstMatchStart);
  if (lastMatchEnd === -1) return null;

  return buildRange(textNodes, firstMatchStart, lastMatchEnd);
}

/**
 * Find where the search text starts as a subsequence in the DOM text.
 * Match the first few characters of search contiguously to anchor the start.
 */
function findSubsequenceStart(domText: string, search: string): number {
  // Use a reasonable prefix to anchor — first 6 chars or full search if shorter
  const prefixLen = Math.min(6, search.length);
  const prefix = search.slice(0, prefixLen);

  // Try exact prefix match
  const idx = domText.indexOf(prefix);
  if (idx !== -1) return idx;

  // Try progressively shorter prefixes (min 2 chars)
  for (let len = prefixLen - 1; len >= 2; len--) {
    const shorter = search.slice(0, len);
    const sIdx = domText.indexOf(shorter);
    if (sIdx !== -1) return sIdx;
  }

  return -1;
}

/**
 * Find where the search text ends in the DOM text.
 * Match the last few characters of search contiguously to anchor the end.
 */
function findSubsequenceEnd(domText: string, search: string, afterPos: number): number {
  // Use last 6 chars as suffix anchor
  const suffixLen = Math.min(6, search.length);
  const suffix = search.slice(-suffixLen);

  // Search for suffix after the start position
  const idx = domText.indexOf(suffix, afterPos);
  if (idx !== -1) return idx + suffix.length;

  // Try progressively shorter suffixes (min 2 chars)
  for (let len = suffixLen - 1; len >= 2; len--) {
    const shorter = search.slice(-len);
    const sIdx = domText.indexOf(shorter, afterPos);
    if (sIdx !== -1) return sIdx + shorter.length;
  }

  // Last resort: just use a fixed length from start
  return Math.min(afterPos + search.length + 20, domText.length);
}

/** Build a DOM Range from raw accumulated text offsets */
function buildRange(
  textNodes: { node: Text; start: number }[],
  matchStart: number,
  matchEnd: number,
): Range | null {
  let startNode: Text | null = null;
  let startOffset = 0;
  let endNode: Text | null = null;
  let endOffset = 0;

  for (let i = 0; i < textNodes.length; i++) {
    const { node: tn, start } = textNodes[i];
    const len = tn.textContent?.length || 0;
    const end = start + len;

    if (!startNode && matchStart >= start && matchStart < end) {
      startNode = tn;
      startOffset = matchStart - start;
    }
    if (matchEnd > start && matchEnd <= end) {
      endNode = tn;
      endOffset = matchEnd - start;
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
