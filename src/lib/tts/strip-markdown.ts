/**
 * Convert a markdown table block into readable TTS text.
 * Input: lines like `| Name | Age |`, `|---|---|`, `| Alice | 30 |`
 * Output: "Name: Alice, Age: 30.\nName: Bob, Age: 25."
 *
 * If there's no separator line (can't detect headers), falls back to
 * reading cells comma-separated per row.
 */
function tableToText(tableLines: string[]): string {
  if (tableLines.length === 0) return '';

  const parseRow = (line: string): string[] =>
    line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()).filter(c => c !== '');

  const isSeparator = (line: string): boolean => /^\|?[\s\-:|]+\|?$/.test(line);

  // Find header and data rows
  let headers: string[] = [];
  const dataRows: string[][] = [];

  let i = 0;
  // First non-separator row is the header if followed by a separator
  if (i < tableLines.length && !isSeparator(tableLines[i])) {
    const firstRow = parseRow(tableLines[i]);
    i++;
    if (i < tableLines.length && isSeparator(tableLines[i])) {
      headers = firstRow;
      i++; // skip separator
    } else {
      // No separator — treat first row as data too
      dataRows.push(firstRow);
    }
  }

  // Remaining non-separator lines are data
  for (; i < tableLines.length; i++) {
    if (!isSeparator(tableLines[i])) {
      dataRows.push(parseRow(tableLines[i]));
    }
  }

  if (dataRows.length === 0 && headers.length > 0) {
    // Header-only table (rare) — just read the headers
    return headers.join(', ') + '.';
  }

  if (headers.length > 0) {
    // Read as "Header: Value, Header: Value." per row
    return dataRows.map(row =>
      headers.map((h, idx) => `${h}: ${row[idx] ?? ''}`).join(', ') + '.'
    ).join('\n');
  }

  // No headers — just read cells per row
  return dataRows.map(row => row.join(', ') + '.').join('\n');
}

/**
 * Replace markdown table blocks with readable TTS text.
 * A table block = consecutive lines that start/end with `|` or are separators.
 */
function convertTables(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let tableBuffer: string[] = [];

  const isTableLine = (line: string): boolean =>
    /^\s*\|/.test(line) || /^\s*[-|: ]+\s*$/.test(line.trim());

  const flushTable = () => {
    if (tableBuffer.length > 0) {
      const converted = tableToText(tableBuffer);
      if (converted) result.push(converted);
      tableBuffer = [];
    }
  };

  for (const line of lines) {
    if (isTableLine(line)) {
      tableBuffer.push(line);
    } else {
      flushTable();
      result.push(line);
    }
  }
  flushTable();

  return result.join('\n');
}

/**
 * Strip markdown formatting to produce plain text suitable for TTS.
 * Order matters: code blocks first (they may contain markdown-like syntax),
 * then tables (converted to readable text), then inline elements,
 * then structural elements, then non-speakable chars.
 */
export function stripMarkdown(text: string): string {
  let result = text
    // Code blocks (remove entirely — don't read code aloud)
    .replace(/```[\s\S]*?```/g, '');

  // Tables: convert pipe-delimited tables to readable "Header: Value" text
  result = convertTables(result);

  return result
    // Inline code (keep text, just remove backticks — often config names, not real code)
    .replace(/`([^`]+)`/g, '$1')
    // Images (remove entirely)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
    // Links (keep link text)
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Bold+italic combined (***)
    .replace(/\*{3}([^*]+)\*{3}/g, '$1')
    // Bold (**)
    .replace(/\*{2}([^*]+)\*{2}/g, '$1')
    // Italic (*)
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '$1')
    // Headers
    .replace(/^#{1,6}\s+/gm, '')
    // List markers (unordered)
    .replace(/^[-*+]\s+/gm, '')
    // List markers (ordered)
    .replace(/^\d+\.\s+/gm, '')
    // Blockquotes
    .replace(/^>\s+/gm, '')
    // Horizontal rules
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // Emojis — remove all Unicode emoji sequences
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]+/gu, '')
    // Special symbols that TTS reads awkwardly (✅ ❌ ⚠️ → ■ etc.)
    .replace(/[✅❌⚠️▶️⏸⏹🔊📌💡🎉✓✗⬆⬇←→■□●○★☆♦♠♣♥]/gu, '')
    // Collapse multiple spaces/newlines
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    // Remove lines that are now empty or whitespace-only
    .replace(/^\s*\n/gm, '\n')
    .trim();
}
