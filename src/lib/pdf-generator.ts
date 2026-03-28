import { readFileSync } from 'fs';
import { join } from 'path';
import { chromium, type Browser } from 'playwright';
import MarkdownIt from 'markdown-it';
import { fromHighlighter } from '@shikijs/markdown-it';
import { createHighlighter } from 'shiki';

// Read github-markdown-css at module load time.
// Using readFileSync because Next.js server context doesn't support ?raw imports.
const githubCss = readFileSync(
  join(process.cwd(), 'node_modules', 'github-markdown-css', 'github-markdown.css'),
  'utf-8',
);

// ── Shared browser instance (lazy, auto-reconnect) ──

let browser: Browser | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch();
  }
  return browser;
}

// ── Shiki highlighter + markdown-it (lazy init) ──

let mdInstance: MarkdownIt | null = null;

async function getMd(): Promise<MarkdownIt> {
  if (mdInstance) return mdInstance;

  const highlighter = await createHighlighter({
    themes: ['github-dark'],
    langs: [
      'javascript', 'typescript', 'jsx', 'tsx',
      'python', 'bash', 'sh', 'shell',
      'json', 'yaml', 'toml', 'xml', 'html', 'css',
      'sql', 'go', 'rust', 'java', 'c', 'cpp',
      'markdown', 'diff', 'plaintext',
    ],
  });

  mdInstance = MarkdownIt({ html: true, linkify: true });
  mdInstance.use(fromHighlighter(highlighter, { theme: 'github-dark' }));

  return mdInstance;
}

// ── HTML template ──

const CUSTOM_CSS = `
  body {
    max-width: 800px;
    margin: 0 auto;
    padding: 0;
    font-family: system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .markdown-body {
    font-size: 14px;
    line-height: 1.6;
  }
  /* Ensure code blocks don't overflow */
  .markdown-body pre {
    overflow-x: auto;
    max-width: 100%;
  }
  /* Print-friendly: no background on body, keep code block backgrounds */
  @media print {
    body { margin: 0; }
  }
`;

function buildHtml(markdownHtml: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>${githubCss}</style>
  <style>${CUSTOM_CSS}</style>
</head>
<body class="markdown-body">
  ${markdownHtml}
</body>
</html>`;
}

// ── Public API ──

export async function generatePdf(markdown: string): Promise<Buffer> {
  const md = await getMd();
  const html = buildHtml(md.render(markdown));

  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    const pdf = await page.pdf({
      format: 'A4',
      margin: { top: '2cm', bottom: '2cm', left: '2cm', right: '2cm' },
      printBackground: true, // needed for code block dark backgrounds
    });
    return Buffer.from(pdf);
  } finally {
    await page.close();
  }
}
