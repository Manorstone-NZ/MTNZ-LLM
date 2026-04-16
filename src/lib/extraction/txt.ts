import type { ExtractedContent, ExtractedSection } from '@/lib/types';

/**
 * Extract structured sections from plain-text content.
 * Splits on blank lines into paragraph sections.
 */
export async function extractTxt(
  content: string,
  filename: string,
): Promise<ExtractedContent> {
  const trimmed = content.trim();

  if (!trimmed) {
    return {
      text: '',
      sections: [],
      metadata: { filename, format: 'txt' },
    };
  }

  // Split on one or more blank lines (two+ consecutive newlines)
  const paragraphs = trimmed
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const sections: ExtractedSection[] = paragraphs.map((para) => ({
    title: null,
    content: para,
    type: 'paragraph' as const,
  }));

  return {
    text: trimmed,
    sections,
    metadata: {
      filename,
      format: 'txt',
      paragraph_count: sections.length,
    },
  };
}
