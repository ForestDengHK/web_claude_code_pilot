/**
 * Markdown -> Intermediate Representation (IR) converter.
 *
 * Uses markdown-it to tokenize, then walks the token stream
 * to produce a platform-agnostic IR tree. Platform-specific
 * renderers (Telegram, Discord, etc.) consume the IR.
 */

import MarkdownIt from 'markdown-it';

// ---------------------------------------------------------------------------
// IR types
// ---------------------------------------------------------------------------

export type IRNodeType =
  | 'text'
  | 'bold'
  | 'italic'
  | 'strikethrough'
  | 'code'
  | 'code_block'
  | 'link'
  | 'heading'
  | 'list_item'
  | 'blockquote'
  | 'paragraph'
  | 'line_break'
  | 'horizontal_rule';

export interface IRNode {
  type: IRNodeType;
  /** Leaf content (text, code, code_block) */
  content?: string;
  /** Child nodes for container types */
  children?: IRNode[];
  /** Code block language annotation */
  language?: string;
  /** Link href */
  url?: string;
  /** Heading level 1-6 */
  level?: number;
  /** Whether this list item belongs to an ordered list */
  ordered?: boolean;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const md = MarkdownIt({ html: false, linkify: false });
// Enable strikethrough (~~text~~)
md.enable('strikethrough');

/**
 * Parse a markdown string into an array of top-level IR nodes.
 */
export function markdownToIR(markdown: string): IRNode[] {
  const tokens = md.parse(markdown, {});
  return walkTokens(tokens, 0, tokens.length).nodes;
}

// ---------------------------------------------------------------------------
// Internal token walker
// ---------------------------------------------------------------------------

interface WalkResult {
  nodes: IRNode[];
  nextIndex: number;
}

function walkTokens(tokens: MarkdownIt.Token[], start: number, end: number): WalkResult {
  const nodes: IRNode[] = [];
  let i = start;

  while (i < end) {
    const token = tokens[i];

    // --- Fence / code block ---
    if (token.type === 'fence' || token.type === 'code_block') {
      nodes.push({
        type: 'code_block',
        content: token.content,
        language: token.info?.trim() || undefined,
      });
      i++;
      continue;
    }

    // --- Inline code (appears inside inline tokens, but also handle solo) ---
    if (token.type === 'code_inline') {
      nodes.push({ type: 'code', content: token.content });
      i++;
      continue;
    }

    // --- Horizontal rule ---
    if (token.type === 'hr') {
      nodes.push({ type: 'horizontal_rule' });
      i++;
      continue;
    }

    // --- Heading open ---
    if (token.type === 'heading_open') {
      const level = Number(token.tag.slice(1)); // h1 -> 1
      const inlineToken = tokens[i + 1]; // heading content
      const children = inlineToken?.children
        ? walkInline(inlineToken.children)
        : [{ type: 'text' as const, content: inlineToken?.content ?? '' }];
      nodes.push({ type: 'heading', level, children });
      i += 3; // heading_open + inline + heading_close
      continue;
    }

    // --- Paragraph open ---
    if (token.type === 'paragraph_open') {
      const inlineToken = tokens[i + 1];
      const children = inlineToken?.children
        ? walkInline(inlineToken.children)
        : inlineToken?.content
          ? [{ type: 'text' as const, content: inlineToken.content }]
          : [];
      nodes.push({ type: 'paragraph', children });
      i += 3; // paragraph_open + inline + paragraph_close
      continue;
    }

    // --- Blockquote ---
    if (token.type === 'blockquote_open') {
      const closeIdx = findClose(tokens, i, 'blockquote_open', 'blockquote_close');
      const inner = walkTokens(tokens, i + 1, closeIdx);
      nodes.push({ type: 'blockquote', children: inner.nodes });
      i = closeIdx + 1;
      continue;
    }

    // --- Ordered / bullet list ---
    if (token.type === 'ordered_list_open' || token.type === 'bullet_list_open') {
      const ordered = token.type === 'ordered_list_open';
      const closeType = ordered ? 'ordered_list_close' : 'bullet_list_close';
      const closeIdx = findClose(tokens, i, token.type, closeType);
      // Walk list items
      let j = i + 1;
      while (j < closeIdx) {
        if (tokens[j].type === 'list_item_open') {
          const itemCloseIdx = findClose(tokens, j, 'list_item_open', 'list_item_close');
          const inner = walkTokens(tokens, j + 1, itemCloseIdx);
          nodes.push({ type: 'list_item', ordered, children: inner.nodes });
          j = itemCloseIdx + 1;
        } else {
          j++;
        }
      }
      i = closeIdx + 1;
      continue;
    }

    // --- Inline token (standalone) ---
    if (token.type === 'inline' && token.children) {
      nodes.push(...walkInline(token.children));
      i++;
      continue;
    }

    // Skip close tokens and others
    i++;
  }

  return { nodes, nextIndex: i };
}

/**
 * Walk inline-level tokens (children of an inline token).
 */
function walkInline(tokens: MarkdownIt.Token[]): IRNode[] {
  const nodes: IRNode[] = [];
  let i = 0;

  while (i < tokens.length) {
    const token = tokens[i];

    if (token.type === 'text') {
      if (token.content) {
        nodes.push({ type: 'text', content: token.content });
      }
      i++;
      continue;
    }

    if (token.type === 'code_inline') {
      nodes.push({ type: 'code', content: token.content });
      i++;
      continue;
    }

    if (token.type === 'softbreak' || token.type === 'hardbreak') {
      nodes.push({ type: 'line_break' });
      i++;
      continue;
    }

    // Bold
    if (token.type === 'strong_open') {
      const closeIdx = findInlineClose(tokens, i, 'strong_open', 'strong_close');
      const children = walkInline(tokens.slice(i + 1, closeIdx));
      nodes.push({ type: 'bold', children });
      i = closeIdx + 1;
      continue;
    }

    // Italic
    if (token.type === 'em_open') {
      const closeIdx = findInlineClose(tokens, i, 'em_open', 'em_close');
      const children = walkInline(tokens.slice(i + 1, closeIdx));
      nodes.push({ type: 'italic', children });
      i = closeIdx + 1;
      continue;
    }

    // Strikethrough
    if (token.type === 's_open') {
      const closeIdx = findInlineClose(tokens, i, 's_open', 's_close');
      const children = walkInline(tokens.slice(i + 1, closeIdx));
      nodes.push({ type: 'strikethrough', children });
      i = closeIdx + 1;
      continue;
    }

    // Link
    if (token.type === 'link_open') {
      const url = token.attrGet('href') ?? '';
      const closeIdx = findInlineClose(tokens, i, 'link_open', 'link_close');
      const children = walkInline(tokens.slice(i + 1, closeIdx));
      nodes.push({ type: 'link', url, children });
      i = closeIdx + 1;
      continue;
    }

    // Fallback: skip unknown tokens
    i++;
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find the matching close token for a block-level open token. */
function findClose(
  tokens: MarkdownIt.Token[],
  openIdx: number,
  openType: string,
  closeType: string,
): number {
  let depth = 1;
  for (let j = openIdx + 1; j < tokens.length; j++) {
    if (tokens[j].type === openType) depth++;
    if (tokens[j].type === closeType) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return tokens.length - 1;
}

/** Find the matching close token within an inline token array. */
function findInlineClose(
  tokens: MarkdownIt.Token[],
  openIdx: number,
  openType: string,
  closeType: string,
): number {
  let depth = 1;
  for (let j = openIdx + 1; j < tokens.length; j++) {
    if (tokens[j].type === openType) depth++;
    if (tokens[j].type === closeType) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return tokens.length - 1;
}
