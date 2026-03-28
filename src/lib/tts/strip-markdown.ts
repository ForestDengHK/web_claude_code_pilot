/**
 * Strip markdown formatting to produce plain text suitable for TTS.
 * Order matters: code blocks first (they may contain markdown-like syntax),
 * then inline elements, then structural elements, then non-speakable chars.
 */
export function stripMarkdown(text: string): string {
  return text
    // Code blocks (remove entirely — don't read code aloud)
    .replace(/```[\s\S]*?```/g, '')
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
    // Tables: remove pipe-delimited table syntax
    .replace(/^\|.*\|$/gm, '')
    .replace(/^[-|: ]+$/gm, '')
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
