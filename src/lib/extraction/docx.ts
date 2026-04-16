import mammoth from 'mammoth';
import type { ExtractedContent, ExtractedSection } from '../types';

/**
 * Extract structured content from a DOCX file buffer.
 *
 * Uses mammoth.js to convert to HTML, then parses the predictable HTML
 * output into heading-hierarchy-aware sections.
 */
export async function extractDocx(
  buffer: Buffer,
  filename: string,
): Promise<ExtractedContent> {
  const result = await mammoth.convertToHtml({ buffer });
  const html = result.value;

  const sections = parseHtmlToSections(html);
  const text = stripHtml(html);

  const metadata: Record<string, unknown> = {
    filename,
    mammoth_messages: result.messages,
  };

  return {
    text,
    sections,
    metadata,
  };
}

// ── HTML parsing ──────────────────────────────────────────────────────

/**
 * Parse mammoth's clean HTML output into ExtractedSection[].
 *
 * Mammoth produces a flat sequence of block-level elements:
 *   <h1>…</h1>, <h2>…</h2>, <p>…</p>, <table>…</table>, <ul>…</ul>, <ol>…</ol>
 */
function parseHtmlToSections(html: string): ExtractedSection[] {
  const sections: ExtractedSection[] = [];

  // Heading stack: index 0 = h1, index 1 = h2, … index 5 = h6
  const headingStack: (string | null)[] = [null, null, null, null, null, null];

  // Regex to match top-level block elements produced by mammoth
  const blockRe =
    /<(h[1-6]|p|table|ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi;

  let match: RegExpExecArray | null;
  while ((match = blockRe.exec(html)) !== null) {
    const tag = match[1].toLowerCase();
    const innerHtml = match[2];

    if (/^h[1-6]$/.test(tag)) {
      const level = parseInt(tag[1], 10);
      const headingText = stripHtml(innerHtml).trim();

      // Update heading stack: set this level and clear deeper levels
      headingStack[level - 1] = headingText;
      for (let i = level; i < 6; i++) {
        headingStack[i] = null;
      }

      sections.push({
        title: buildHeadingPath(headingStack, level),
        content: headingText,
        level,
        type: 'heading',
      });
    } else if (tag === 'table') {
      const tableContent = parseTable(match[0]); // pass full match including <table> wrapper
      if (tableContent.trim()) {
        sections.push({
          title: currentHeadingPath(headingStack),
          content: tableContent,
          type: 'table',
        });
      }
    } else if (tag === 'ul' || tag === 'ol') {
      const listContent = parseList(innerHtml, tag === 'ol');
      if (listContent.trim()) {
        sections.push({
          title: currentHeadingPath(headingStack),
          content: listContent,
          type: 'list',
        });
      }
    } else if (tag === 'p') {
      const text = stripHtml(innerHtml).trim();
      if (text) {
        sections.push({
          title: currentHeadingPath(headingStack),
          content: text,
          type: 'paragraph',
        });
      }
    }
  }

  return sections;
}

// ── Heading hierarchy helpers ─────────────────────────────────────────

/** Build the heading path string for a heading at the given level. */
function buildHeadingPath(
  stack: (string | null)[],
  level: number,
): string {
  const parts: string[] = [];
  for (let i = 0; i < level; i++) {
    if (stack[i]) parts.push(stack[i]!);
  }
  return parts.join(' > ') || null as unknown as string;
}

/** Get the current heading path for a non-heading section. */
function currentHeadingPath(stack: (string | null)[]): string | null {
  const parts: string[] = [];
  for (const h of stack) {
    if (h) parts.push(h);
  }
  return parts.length > 0 ? parts.join(' > ') : null;
}

// ── Table parsing ─────────────────────────────────────────────────────

function parseTable(tableHtml: string): string {
  const rows: string[][] = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;

  while ((rowMatch = rowRe.exec(tableHtml)) !== null) {
    const cells: string[] = [];
    const cellRe = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      cells.push(stripHtml(cellMatch[1]).trim());
    }
    if (cells.length > 0) {
      rows.push(cells);
    }
  }

  if (rows.length === 0) return '';

  const lines: string[] = [];
  lines.push(rows[0].join(' | '));
  if (rows.length > 1) {
    lines.push('---');
    for (let i = 1; i < rows.length; i++) {
      lines.push(rows[i].join(' | '));
    }
  }
  return lines.join('\n');
}

// ── List parsing ──────────────────────────────────────────────────────

function parseList(innerHtml: string, ordered: boolean): string {
  const items: string[] = [];
  const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let liMatch: RegExpExecArray | null;
  let idx = 1;

  while ((liMatch = liRe.exec(innerHtml)) !== null) {
    const text = stripHtml(liMatch[1]).trim();
    if (text) {
      const prefix = ordered ? `${idx}. ` : '- ';
      items.push(`${prefix}${text}`);
      idx++;
    }
  }

  return items.join('\n');
}

// ── Strip HTML tags ───────────────────────────────────────────────────

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}
