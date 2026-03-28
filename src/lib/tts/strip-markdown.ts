/**
 * Strip markdown formatting to produce plain text suitable for TTS.
 * Order matters: code blocks first (they may contain markdown-like syntax),
 * then inline elements, then structural elements.
 */
export function stripMarkdown(text: string): string {
  return text
    // Code blocks (remove entirely — don't read code aloud)
    .replace(/```[\s\S]*?```/g, '')
    // Inline code (keep the text content)
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
    // Collapse multiple newlines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
