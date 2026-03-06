/**
 * Base IR renderer — outputs plain text (strips all formatting).
 *
 * Platform-specific renderers (Telegram, Discord, etc.) extend this
 * and override individual methods.
 */

import type { IRNode } from './ir';

// ---------------------------------------------------------------------------
// Renderer interface
// ---------------------------------------------------------------------------

export interface IRRenderer {
  renderNodes(nodes: IRNode[]): string;
  renderNode(node: IRNode): string;
  text(content: string): string;
  bold(children: string): string;
  italic(children: string): string;
  strikethrough(children: string): string;
  code(content: string): string;
  codeBlock(content: string, language?: string): string;
  link(text: string, url: string): string;
  heading(text: string, level: number): string;
  listItem(text: string, ordered: boolean): string;
  blockquote(text: string): string;
  paragraph(text: string): string;
  lineBreak(): string;
  horizontalRule(): string;
}

// ---------------------------------------------------------------------------
// Base implementation — plain text output
// ---------------------------------------------------------------------------

export class BaseIRRenderer implements IRRenderer {
  renderNodes(nodes: IRNode[]): string {
    return nodes.map((n) => this.renderNode(n)).join('');
  }

  renderNode(node: IRNode): string {
    switch (node.type) {
      case 'text':
        return this.text(node.content ?? '');
      case 'bold':
        return this.bold(this.renderChildren(node));
      case 'italic':
        return this.italic(this.renderChildren(node));
      case 'strikethrough':
        return this.strikethrough(this.renderChildren(node));
      case 'code':
        return this.code(node.content ?? '');
      case 'code_block':
        return this.codeBlock(node.content ?? '', node.language);
      case 'link':
        return this.link(this.renderChildren(node), node.url ?? '');
      case 'heading':
        return this.heading(this.renderChildren(node), node.level ?? 1);
      case 'list_item':
        return this.listItem(this.renderChildren(node), node.ordered ?? false);
      case 'blockquote':
        return this.blockquote(this.renderChildren(node));
      case 'paragraph':
        return this.paragraph(this.renderChildren(node));
      case 'line_break':
        return this.lineBreak();
      case 'horizontal_rule':
        return this.horizontalRule();
      default:
        return this.renderChildren(node);
    }
  }

  /** Render all children of a container node. */
  protected renderChildren(node: IRNode): string {
    if (!node.children || node.children.length === 0) {
      return node.content ?? '';
    }
    return this.renderNodes(node.children);
  }

  // --- Plain text implementations (override in subclasses) ---

  text(content: string): string {
    return content;
  }

  bold(children: string): string {
    return children;
  }

  italic(children: string): string {
    return children;
  }

  strikethrough(children: string): string {
    return children;
  }

  code(content: string): string {
    return content;
  }

  codeBlock(content: string, _language?: string): string {
    return content + '\n';
  }

  link(text: string, url: string): string {
    return url ? `${text} (${url})` : text;
  }

  heading(text: string, _level: number): string {
    return text + '\n';
  }

  listItem(text: string, _ordered: boolean): string {
    // Strip inner paragraph newlines for cleaner list output
    const clean = text.replace(/\n$/, '');
    return `- ${clean}\n`;
  }

  blockquote(text: string): string {
    return text
      .split('\n')
      .map((line) => `> ${line}`)
      .join('\n') + '\n';
  }

  paragraph(text: string): string {
    return text + '\n\n';
  }

  lineBreak(): string {
    return '\n';
  }

  horizontalRule(): string {
    return '---\n';
  }
}
