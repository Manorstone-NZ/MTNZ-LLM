import { createHash } from 'crypto';
import { get_encoding } from 'tiktoken';
import type { ExtractedSection, PreparedChunk } from '@/lib/types';

const enc = get_encoding('cl100k_base');

function countTokens(text: string): number {
  return enc.encode(text).length;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Split text at sentence boundaries.
 * A sentence boundary is ". " followed by an uppercase letter, or a newline.
 */
function splitSentences(text: string): string[] {
  // Split on ". " followed by uppercase, or on newlines
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Look for ". " followed by uppercase letter, or newline
    const match = remaining.match(/\. (?=[A-Z])|\n/);
    if (match && match.index !== undefined) {
      const end = match.index + match[0].length;
      parts.push(remaining.slice(0, end));
      remaining = remaining.slice(end);
    } else {
      parts.push(remaining);
      break;
    }
  }

  return parts.filter((s) => s.length > 0);
}

/**
 * Build a citation label for a chunk.
 */
function buildCitationLabel(
  docTitle: string,
  sectionTitle: string | null,
  page: number | null,
  chunkIndex: number,
): string {
  if (sectionTitle) {
    return `${docTitle}, ${sectionTitle}`;
  }
  if (page != null) {
    return `${docTitle}, p.${page}`;
  }
  return `${docTitle}, chunk ${chunkIndex}`;
}

/**
 * Build a PreparedChunk from content and context.
 */
function makeChunk(
  content: string,
  index: number,
  sectionTitle: string | null,
  page: number | null,
  docTitle: string,
): PreparedChunk {
  return {
    content,
    content_preview: content.slice(0, 200),
    chunk_index: index,
    chunk_hash: sha256(content),
    token_count: countTokens(content),
    page_number: page,
    section_title: sectionTitle,
    sheet_name: null,
    range_ref: null,
    citation_label: buildCitationLabel(docTitle, sectionTitle, page, index),
    metadata: {},
  };
}

/**
 * Structure-aware prose chunker for PDF, DOCX, and TXT extracted content.
 *
 * - Tables and lists are always atomic (never split)
 * - Small adjacent sections are merged up to maxTokens
 * - Large sections are split at sentence boundaries with overlap
 * - Overlap is ONLY applied at artificial splits within a section
 */
export function chunkProse(
  sections: ExtractedSection[],
  docTitle: string,
  options?: { maxTokens?: number; overlapTokens?: number },
): PreparedChunk[] {
  const maxTokens = options?.maxTokens ?? 800;
  const overlapTokens = options?.overlapTokens ?? 120;
  const chunks: PreparedChunk[] = [];

  let currentSectionTitle: string | null = null;
  // Buffer for merging small sections
  let buffer = '';
  let bufferTokens = 0;
  let bufferPage: number | null = null;
  let bufferSectionTitle: string | null = null;

  function flushBuffer() {
    if (buffer.trim().length === 0) return;
    chunks.push(
      makeChunk(buffer.trim(), chunks.length, bufferSectionTitle, bufferPage, docTitle),
    );
    buffer = '';
    bufferTokens = 0;
    bufferPage = null;
    bufferSectionTitle = null;
  }

  for (const section of sections) {
    // Track heading as current section title
    if (section.type === 'heading' && section.title) {
      currentSectionTitle = section.title;
    }

    const sectionTitle = currentSectionTitle;
    const page = section.page ?? null;

    // Atomic types: table and list are never split
    if (section.type === 'table' || section.type === 'list') {
      // Flush any pending buffer first
      flushBuffer();
      // Emit as its own chunk regardless of size
      chunks.push(
        makeChunk(section.content, chunks.length, sectionTitle, page, docTitle),
      );
      continue;
    }

    const sectionTokens = countTokens(section.content);

    // Large section: needs splitting at sentence boundaries
    if (sectionTokens > maxTokens) {
      flushBuffer();

      const sentences = splitSentences(section.content);
      let currentChunkSentences: string[] = [];
      let currentTokens = 0;

      for (const sentence of sentences) {
        const sentenceTokens = countTokens(sentence);

        if (currentTokens + sentenceTokens > maxTokens && currentChunkSentences.length > 0) {
          // Emit current chunk
          const chunkContent = currentChunkSentences.join('').trim();
          chunks.push(
            makeChunk(chunkContent, chunks.length, sectionTitle, page, docTitle),
          );

          // Build overlap from the end of the current chunk
          let overlapSentences: string[] = [];
          let overlapCount = 0;
          for (let i = currentChunkSentences.length - 1; i >= 0; i--) {
            const st = countTokens(currentChunkSentences[i]);
            if (overlapCount + st > overlapTokens && overlapSentences.length > 0) break;
            overlapSentences.unshift(currentChunkSentences[i]);
            overlapCount += st;
          }

          currentChunkSentences = [...overlapSentences, sentence];
          currentTokens = overlapCount + sentenceTokens;
        } else {
          currentChunkSentences.push(sentence);
          currentTokens += sentenceTokens;
        }
      }

      // Emit remaining
      if (currentChunkSentences.length > 0) {
        const chunkContent = currentChunkSentences.join('').trim();
        if (chunkContent.length > 0) {
          chunks.push(
            makeChunk(chunkContent, chunks.length, sectionTitle, page, docTitle),
          );
        }
      }
      continue;
    }

    // Small section: try to merge into buffer
    if (bufferTokens + sectionTokens > maxTokens && buffer.length > 0) {
      flushBuffer();
    }

    if (buffer.length > 0) {
      buffer += '\n\n' + section.content;
    } else {
      buffer = section.content;
      bufferPage = page;
      bufferSectionTitle = sectionTitle;
    }
    bufferTokens = countTokens(buffer);

    // Update buffer metadata - keep first page, update section title
    if (bufferPage === null) {
      bufferPage = page;
    }
    if (bufferSectionTitle === null) {
      bufferSectionTitle = sectionTitle;
    }
  }

  // Flush remaining buffer
  flushBuffer();

  return chunks;
}
