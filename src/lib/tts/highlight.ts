'use client';

/**
 * Result from findTextRange, includes both the DOM Range and the matched
 * offset in accumulated DOM text (used for sequential position tracking).
 */
export interface FindTextResult {
  range: Range;
  /** End offset in accumulated DOM text — pass as searchAfter for the next sequential search */
  textOffset: number;
}

/**
 * Find text in the DOM that corresponds to a TTS segment.
 *
 * The challenge: TTS segments come from stripped text (no code, no emoji),
 * but the DOM still has those elements.
 *
 * Strategy:
 * 1. Table-derived text ("Header: Value, ...") → highlight the matching <tr>
 * 2. Exact string match in concatenated text nodes (fast path)
 * 3. Subsequence match (handles code/emoji in DOM)
 * 4. Alphanumeric-only fallback (handles punctuation mismatches)
 *
 * @param searchAfter - Offset in accumulated DOM text to start searching from.
 *   When reading sequentially, pass the previous result's textOffset so that
 *   repeated/similar text later in the document matches correctly instead of
 *   always matching the first occurrence.
 */
export function findTextRange(
  container: HTMLElement,
  searchText: string,
  searchAfter: number = 0,
): FindTextResult | null {
  const search = searchText.replace(/\s+/g, ' ').trim();
  if (!search) return null;

  // Always collect text nodes first — needed for both table textOffset
  // computation and the text-based matching strategies
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

  // Small backward buffer to handle slight SRT segment overlap
  const startFrom = searchAfter > 0 ? Math.max(0, searchAfter - 10) : 0;

  // 1. Table row matching — detect "Header: Value, Header: Value." pattern
  const tableResult = findTableRowMatch(container, search, textNodes, startFrom);
  if (tableResult) return tableResult;

  // 2. Try exact match (fast path) — search from expected position first
  let exactIdx = startFrom > 0 ? accumulated.indexOf(search, startFrom) : -1;
  if (exactIdx === -1) exactIdx = accumulated.indexOf(search);
  if (exactIdx !== -1) {
    const range = buildRange(textNodes, exactIdx, exactIdx + search.length);
    if (range) return { range, textOffset: exactIdx + search.length };
  }

  // Max allowed match span for fuzzy strategies — prevents absurdly large
  // ranges when prefix matches early and suffix matches late
  const maxSpan = search.length * 3 + 100;

  // 3. Subsequence match: find the first and last characters of the search text
  // in the accumulated DOM text, allowing extra content in between.
  // This handles cases like:
  //   search: "目标目录 () 写死了"  (code stripped, empty parens)
  //   DOM:    "目标目录 (/Users/party/working) 写死了"  (code still present)

  let seqStart = findSubsequenceStart(accumulated, search, startFrom);
  if (seqStart === -1 && startFrom > 0) {
    seqStart = findSubsequenceStart(accumulated, search, 0);
  }
  if (seqStart !== -1) {
    const seqEnd = findSubsequenceEnd(accumulated, search, seqStart);
    if (seqEnd !== -1 && (seqEnd - seqStart) <= maxSpan) {
      const range = buildRange(textNodes, seqStart, seqEnd);
      if (range) return { range, textOffset: seqEnd };
    }
  }

  // 4. Alphanumeric-only fallback — strip punctuation from search then match
  let alphaResult = findAlphaMatch(accumulated, search, startFrom);
  if (!alphaResult && startFrom > 0) {
    alphaResult = findAlphaMatch(accumulated, search, 0);
  }
  if (alphaResult && (alphaResult.end - alphaResult.start) <= maxSpan) {
    const range = buildRange(textNodes, alphaResult.start, alphaResult.end);
    if (range) return { range, textOffset: alphaResult.end };
  }

  return null;
}

/**
 * Match table-derived TTS text ("Header: Value, Header: Value.") to DOM <tr> rows.
 *
 * The TTS reads tables as "Col1: Val1, Col2: Val2." per row, but the DOM has
 * the values in <td> cells. We find cells matching the values and highlight
 * their parent <tr>.
 *
 * @param textNodes - Pre-collected text nodes with accumulated offsets, used to
 *   compute textOffset and for position-aware row filtering.
 * @param startFrom - Offset in accumulated DOM text; rows before this position
 *   are skipped (for sequential reading through multi-row tables).
 */
function findTableRowMatch(
  container: HTMLElement,
  searchText: string,
  textNodes: { node: Text; start: number }[],
  startFrom: number,
): FindTextResult | null {
  // Detect "Key: Value" pattern — require at least 2 pairs to avoid false
  // positives on regular sentences that happen to contain a colon
  // (e.g. "注意: 这个功能还在开发中" would match 1 pair but isn't a table)
  const pairPattern = /([\w\u4e00-\u9fff\u3400-\u4dbf]+)\s*:\s*([^,.\n]+)/g;
  const pairs: { header: string; value: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = pairPattern.exec(searchText)) !== null) {
    pairs.push({ header: m[1].trim(), value: m[2].trim() });
  }
  if (pairs.length < 2) return null;

  // Only trigger if the container actually has a table
  const tdCells = container.querySelectorAll('td');
  if (tdCells.length === 0) return null;

  const values = pairs.map(p => p.value.toLowerCase());

  // Helper: get the text offset where a row starts in accumulated DOM text
  const getRowStartOffset = (row: Element): number => {
    for (const { node, start } of textNodes) {
      if (row.contains(node)) return start;
    }
    return -1;
  };

  // Helper: get the text offset where a row ends in accumulated DOM text
  const getRowEndOffset = (row: Element): number => {
    let endPos = -1;
    for (const { node, start } of textNodes) {
      if (row.contains(node)) {
        endPos = start + (node.textContent?.length || 0);
      }
    }
    return endPos;
  };

  // Score a row: count how many cells match a value
  const scoreRow = (row: Element): number => {
    const rowCells = row.querySelectorAll('td');
    if (rowCells.length === 0) return 0; // skip header rows (th only)

    let score = 0;
    for (const cell of rowCells) {
      const cellText = (cell.textContent || '').trim().toLowerCase();
      if (!cellText) continue;
      if (values.some(v =>
        cellText.includes(v) ||
        // Reverse match: only if cell text is substantial (>=2 chars)
        // to prevent single-char cells from matching everything
        (cellText.length >= 2 && v.includes(cellText))
      )) {
        score++;
      }
    }
    return score;
  };

  // Find the best matching <tr>, preferring rows at or after startFrom
  const rows = container.querySelectorAll('tbody tr, tr');

  let bestRow: Element | null = null;
  let bestScore = 0;

  // First pass: only consider rows at or after startFrom
  if (startFrom > 0) {
    for (const row of rows) {
      const rowStart = getRowStartOffset(row);
      if (rowStart < startFrom) continue; // skip rows we've already passed

      const score = scoreRow(row);
      if (score > bestScore) {
        bestScore = score;
        bestRow = row;
      }
    }
  }

  // Fallback: if no row matched after startFrom, search all rows
  if (!bestRow || bestScore === 0) {
    bestScore = 0;
    for (const row of rows) {
      const score = scoreRow(row);
      if (score > bestScore) {
        bestScore = score;
        bestRow = row;
      }
    }
  }

  if (!bestRow || bestScore === 0) return null;

  // Compute textOffset from the matched row's end position
  let bestEndOffset = getRowEndOffset(bestRow);
  if (bestEndOffset < 0) bestEndOffset = startFrom;

  try {
    const range = document.createRange();
    range.selectNodeContents(bestRow);
    return { range, textOffset: bestEndOffset };
  } catch {
    return null;
  }
}

/**
 * Fallback: strip non-alphanumeric characters, then try to find matching words
 * sequentially in the DOM text.
 * Handles cases where TTS text has punctuation (colons, commas, periods)
 * that doesn't exist in the DOM.
 */
function findAlphaMatch(
  domText: string,
  searchText: string,
  startFrom: number = 0,
): { start: number; end: number } | null {
  // Extract significant words (2+ chars) from search text
  const words = searchText.match(/[\w\u4e00-\u9fff\u3400-\u4dbf]{2,}/gu);
  if (!words || words.length < 2) return null;

  // Find each word in the DOM, tracking positions
  const positions: { pos: number; end: number }[] = [];
  let searchFrom = startFrom;
  for (const word of words) {
    const pos = domText.indexOf(word, searchFrom);
    if (pos !== -1) {
      positions.push({ pos, end: pos + word.length });
      if (pos >= searchFrom) searchFrom = pos + word.length;
    }
  }

  if (positions.length < 2) return null;

  return {
    start: positions[0].pos,
    end: positions[positions.length - 1].end,
  };
}

/**
 * Find where the search text starts as a subsequence in the DOM text.
 * Match the first few characters of search contiguously to anchor the start.
 */
function findSubsequenceStart(domText: string, search: string, startFrom: number = 0): number {
  // Use a reasonable prefix to anchor — first 6 chars or full search if shorter
  const prefixLen = Math.min(6, search.length);
  const prefix = search.slice(0, prefixLen);

  // Try exact prefix match
  const idx = domText.indexOf(prefix, startFrom);
  if (idx !== -1) return idx;

  // Try progressively shorter prefixes (min 2 chars)
  for (let len = prefixLen - 1; len >= 2; len--) {
    const shorter = search.slice(0, len);
    const sIdx = domText.indexOf(shorter, startFrom);
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

  // Fallback: try suffix with punctuation stripped
  const cleanSearch = search.replace(/[^a-zA-Z0-9\u4e00-\u9fff\u3400-\u4dbf\s]/g, '').trim();
  if (cleanSearch) {
    const cleanSuffixLen = Math.min(6, cleanSearch.length);
    for (let len = cleanSuffixLen; len >= 2; len--) {
      const cleanSuffix = cleanSearch.slice(-len);
      const cIdx = domText.indexOf(cleanSuffix, afterPos);
      if (cIdx !== -1) return cIdx + cleanSuffix.length;
    }
  }

  // Last resort — return -1 to let the caller try other strategies
  return -1;
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
