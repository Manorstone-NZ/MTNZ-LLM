import { PDFParse } from 'pdf-parse';
import type { ExtractedContent, ExtractedSection } from '../types';

/** Minimum characters of extracted text before we consider the PDF "scanned" */
const MIN_TEXT_CHARS = 100;

/**
 * Extract text and structured sections from a PDF buffer.
 */
export async function extractPdf(
  buffer: Buffer,
  filename: string,
): Promise<ExtractedContent> {
  let parser: PDFParse | null = null;

  try {
    // pdf-parse v2 uses a class-based API
    parser = new PDFParse({ data: new Uint8Array(buffer) });

    // Use a page joiner that we can split on later to get per-page text
    const textResult = await parser.getText({
      pageJoiner: '\n---PAGE_BREAK---\n',
    });

    const fullText = textResult.text;
    const pageCount = textResult.total;

    // Retrieve document info for metadata
    let title: string | null = null;
    let author: string | null = null;
    try {
      const info = await parser.getInfo();
      title = info.info?.Title ?? null;
      author = info.info?.Author ?? null;
    } catch {
      // Info extraction is non-critical
    }

    // OCR detection: if very little text was extracted, it's likely a scanned PDF
    if (fullText.trim().length < MIN_TEXT_CHARS) {
      return handleScannedPdf(fullText, filename, pageCount);
    }

    // Split text by page markers
    const pages = splitByPages(fullText);

    // Detect sections across all pages
    const sections = detectSections(pages);

    return {
      text: fullText,
      sections,
      metadata: {
        filename,
        pages: pageCount,
        title,
        author,
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      text: '',
      sections: [],
      metadata: {
        filename,
        error: `PDF parse failed: ${message}`,
        pages: 0,
      },
    };
  } finally {
    if (parser) {
      try {
        await parser.destroy();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Scanned / OCR path
// ---------------------------------------------------------------------------

function handleScannedPdf(
  text: string,
  filename: string,
  pages: number,
): ExtractedContent {
  const ocrEnabled = process.env.OCR_ENABLED === 'true';

  if (ocrEnabled) {
    // TODO: integrate tesseract.js here when OCR support is ready
    return {
      text,
      sections: [],
      metadata: {
        filename,
        pages,
        ocr_used: false,
        ocr_needed: true,
        error: 'Scanned PDF requires OCR. Tesseract integration deferred.',
      },
      ocr_used: false,
    };
  }

  return {
    text,
    sections: [],
    metadata: {
      filename,
      pages,
      ocr_used: false,
      ocr_needed: true,
      error: 'Scanned PDF requires OCR. OCR_ENABLED=false.',
    },
    ocr_used: false,
  };
}

// ---------------------------------------------------------------------------
// Page splitting
// ---------------------------------------------------------------------------

function splitByPages(text: string): string[] {
  const parts = text.split(/---PAGE_BREAK---/);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ---------------------------------------------------------------------------
// Section detection
// ---------------------------------------------------------------------------

/** Patterns for numbered section headings like "1.0 PURPOSE", "3.2 Procedure", "Section 4:" */
const NUMBERED_HEADING_RE =
  /^(?:section\s+)?\d+(?:\.\d+)*\.?\s+[A-Z][A-Za-z\s,/&()-]+$/;

/** All-caps line (at least 4 chars, not just numbers/punctuation) */
function isAllCapsHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 4) return false;
  // Must contain at least 2 letter characters
  const letters = trimmed.replace(/[^A-Za-z]/g, '');
  if (letters.length < 2) return false;
  // Check all letters are uppercase
  return letters === letters.toUpperCase() && /[A-Z]/.test(letters);
}

/** Lines that look like headings but are actually noise (watermarks, footers) */
const NOISE_PATTERNS = [
  /CONTROLLED COPY/i,
  /IF THIS LINE IS GREEN/i,
  /THIS DOCUMENT IS UNCONTROLLED/i,
  /PAGE \d+ OF \d+/i,
  /^\s*\d+\s*$/,  // page numbers only
];

function isNoiseLine(line: string): boolean {
  return NOISE_PATTERNS.some(p => p.test(line.trim()));
}

/** Detect if a line is a heading */
function isHeading(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (isNoiseLine(trimmed)) return false;
  if (isAllCapsHeading(trimmed)) return true;
  if (NUMBERED_HEADING_RE.test(trimmed)) return true;
  return false;
}

/** Detect list item lines */
const LIST_PATTERNS = [
  /^\s*\d+[.)]\s/,           // 1. or 1)
  /^\s*[a-z][.)]\s/,         // a. or a)
  /^\s*(?:i{1,3}|iv|vi{0,3}|ix|x)[.)]\s/i, // Roman numerals
  /^\s*[•●○▪▸►-]\s/,        // Bullet characters
  /^\s*\*\s/,                // Markdown-style bullets
];

function isListItem(line: string): boolean {
  return LIST_PATTERNS.some((re) => re.test(line));
}

/**
 * Detect table-like content: 3+ consecutive lines with consistent column
 * alignment (multiple internal whitespace gaps).
 */
function isTableBlock(lines: string[]): boolean {
  if (lines.length < 3) return false;
  let alignedCount = 0;
  for (const line of lines) {
    // A "columnar" line has 2+ stretches of 3+ spaces between non-space content,
    // or tab-separated columns
    const gaps = line.match(/\S\s{3,}\S/g) || line.match(/\S\t\S/g);
    if (gaps && gaps.length >= 1) {
      alignedCount++;
    }
  }
  return alignedCount >= 3 && alignedCount / lines.length >= 0.5;
}

/** Infer heading level from numbered patterns */
function headingLevel(line: string): number {
  const match = line.trim().match(/^(?:section\s+)?(\d+(?:\.\d+)*)/i);
  if (match) {
    const parts = match[1].split('.');
    return parts.length;
  }
  return 1;
}

function detectSections(pages: string[]): ExtractedSection[] {
  const sections: ExtractedSection[] = [];

  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const pageNum = pageIdx + 1;
    const lines = pages[pageIdx].split('\n');

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // Skip empty lines
      if (!trimmed) {
        i++;
        continue;
      }

      // --- Heading ---
      if (isHeading(trimmed)) {
        sections.push({
          title: trimmed,
          content: trimmed,
          page: pageNum,
          level: headingLevel(trimmed),
          type: 'heading',
        });
        i++;
        continue;
      }

      // --- List block ---
      if (isListItem(trimmed)) {
        const listLines: string[] = [];
        while (
          i < lines.length &&
          (isListItem(lines[i].trim()) ||
            (lines[i].trim() &&
              !isHeading(lines[i].trim()) &&
              listLines.length > 0 &&
              !isListItem(lines[i].trim()) &&
              /^\s{2,}/.test(lines[i])))
        ) {
          listLines.push(lines[i]);
          i++;
        }
        sections.push({
          title: null,
          content: listLines.join('\n').trim(),
          page: pageNum,
          type: 'list',
        });
        continue;
      }

      // --- Table detection: look ahead for columnar blocks ---
      const lookahead: string[] = [];
      let j = i;
      while (j < lines.length && lines[j].trim()) {
        lookahead.push(lines[j]);
        j++;
      }
      if (isTableBlock(lookahead)) {
        sections.push({
          title: null,
          content: lookahead.join('\n').trim(),
          page: pageNum,
          type: 'table',
        });
        i = j;
        continue;
      }

      // --- Paragraph: collect contiguous non-empty, non-heading, non-list lines ---
      const paraLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !isHeading(lines[i].trim()) &&
        !isListItem(lines[i].trim())
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      if (paraLines.length > 0) {
        sections.push({
          title: null,
          content: paraLines.join('\n').trim(),
          page: pageNum,
          type: 'paragraph',
        });
      }
    }
  }

  return sections;
}
