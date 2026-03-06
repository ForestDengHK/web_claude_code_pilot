/**
 * Telegram HTML renderer + chunking.
 *
 * Renders the platform-agnostic IR tree into Telegram-compatible HTML
 * (using Telegram's supported subset of HTML tags).
 */

import { escapeHtml, splitMessage } from '../adapters/telegram-utils';
import { markdownToIR } from './ir';
import type { IRNode } from './ir';
import { BaseIRRenderer } from './render';

// ---------------------------------------------------------------------------
// Telegram renderer
// ---------------------------------------------------------------------------

export class TelegramRenderer extends BaseIRRenderer {
  text(content: string): string {
    return escapeHtml(content);
  }

  bold(children: string): string {
    return `<b>${children}</b>`;
  }

  italic(children: string): string {
    return `<i>${children}</i>`;
  }

  strikethrough(children: string): string {
    return `<s>${children}</s>`;
  }

  code(content: string): string {
    return `<code>${escapeHtml(content)}</code>`;
  }

  codeBlock(content: string, language?: string): string {
    const lang = language ? ` class="language-${escapeHtml(language)}"` : '';
    return `<pre><code${lang}>${escapeHtml(content)}</code></pre>\n`;
  }

  link(text: string, url: string): string {
    return `<a href="${escapeHtml(url)}">${text}</a>`;
  }

  heading(text: string, _level: number): string {
    return `<b>${text}</b>\n`;
  }

  listItem(text: string, _ordered: boolean): string {
    const clean = text.replace(/\n$/, '');
    return `\u2022 ${clean}\n`;
  }

  blockquote(text: string): string {
    return `<blockquote>${text.replace(/\n$/, '')}</blockquote>\n`;
  }

  paragraph(text: string): string {
    return text + '\n\n';
  }

  lineBreak(): string {
    return '\n';
  }

  horizontalRule(): string {
    return '\n';
  }
}

// ---------------------------------------------------------------------------
// Chunking entry point
// ---------------------------------------------------------------------------

const DEFAULT_MAX_LENGTH = 4096;

/**
 * Convert markdown to an array of Telegram HTML chunks, each within maxLength.
 *
 * Strategy:
 *  1. Parse markdown to IR
 *  2. Render each top-level IR node individually
 *  3. Accumulate rendered nodes into chunks, splitting at maxLength
 *  4. If a single node exceeds maxLength, hard-split with splitMessage()
 */
export function markdownToTelegramChunks(
  markdown: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string[] {
  const ir = markdownToIR(markdown);

  if (ir.length === 0) return [''];

  const renderer = new TelegramRenderer();
  const renderedNodes = ir.map((node) => renderer.renderNode(node));

  const chunks: string[] = [];
  let current = '';

  for (const rendered of renderedNodes) {
    // If this single node is already too long, flush current and hard-split
    if (rendered.length > maxLength) {
      if (current.length > 0) {
        chunks.push(current);
        current = '';
      }
      chunks.push(...splitMessage(rendered, maxLength));
      continue;
    }

    // Would adding this node exceed the limit?
    if (current.length + rendered.length > maxLength) {
      chunks.push(current);
      current = rendered;
    } else {
      current += rendered;
    }
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [''];
}
