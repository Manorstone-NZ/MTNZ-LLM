import { createHash } from 'crypto';
import { get_encoding } from 'tiktoken';
import type { ExtractedSection, NormalisedSection, PreparedChunk, SectionType } from '@/lib/types';

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
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
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

/** Section types that must never be merged into unrelated content */
const BREAK_BEFORE_TYPES: Set<string> = new Set([
  'procedure_step',
  'instruction_block',
]);

/** Section types that must be kept as their own distinct chunk */
const DISTINCT_TYPES: Set<string> = new Set([
  'warning',
  'note',
]);

/** Section types exempt from the minimum-token guardrail */
const MIN_TOKEN_EXEMPT_TYPES: Set<string> = new Set([
  'table',
  'procedure_step',
  'instruction_block',
  'warning',
  'note',
]);

/**
 * Coerce an input section to NormalisedSection shape.
 * If v2 fields are missing (backward-compat with ExtractedSection[]), defaults are applied.
 */
function asNormalised(section: Partial<NormalisedSection>): NormalisedSection {
  return {
    title: section.title ?? null,
    content: section.content ?? '',
    page: section.page,
    level: section.level,
    type: section.type ?? 'paragraph',
    section_type: (section as NormalisedSection).section_type ?? (section.type as SectionType) ?? 'paragraph',
    section_type_confidence: (section as NormalisedSection).section_type_confidence ?? 0,
    retrieval_excluded: (section as NormalisedSection).retrieval_excluded ?? false,
    retrieval_downranked: (section as NormalisedSection).retrieval_downranked ?? false,
    is_boilerplate: (section as NormalisedSection).is_boilerplate ?? false,
    boilerplate_hash: (section as NormalisedSection).boilerplate_hash ?? null,
    normalisation_reason: (section as NormalisedSection).normalisation_reason ?? null,
  };
}

/**
 * Build a PreparedChunk from content, context, and v2 fields.
 */
function makeChunk(
  content: string,
  index: number,
  sectionTitle: string | null,
  page: number | null,
  docTitle: string,
  v2: {
    section_type?: SectionType | null;
    section_types?: SectionType[];
    is_boilerplate?: boolean;
    retrieval_excluded?: boolean;
    retrieval_downranked?: boolean;
    boilerplate_hash?: string | null;
    normalisation_reason?: Record<string, unknown> | null;
  },
): PreparedChunk {
  const excluded = v2.retrieval_excluded ?? false;
  const metadata: Record<string, unknown> = {};
  if (v2.section_types && v2.section_types.length > 1) {
    metadata.section_types = v2.section_types;
  }

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
    metadata,
    section_type: v2.section_type ?? null,
    is_boilerplate: v2.is_boilerplate ?? false,
    retrieval_excluded: excluded,
    retrieval_downranked: v2.retrieval_downranked ?? false,
    boilerplate_hash: v2.boilerplate_hash ?? null,
    normalisation_reason: v2.normalisation_reason ?? null,
    embedding_status: excluded ? 'skipped_excluded' : 'pending',
  };
}

/**
 * Split a chunk that exceeds maxTokens at sentence boundaries with overlap.
 * Returns one or more PreparedChunks.
 */
function splitLargeChunk(
  chunk: PreparedChunk,
  maxTokens: number,
  overlapTokens: number,
  docTitle: string,
  startIndex: number,
): PreparedChunk[] {
  const sentences = splitSentences(chunk.content);
  const results: PreparedChunk[] = [];
  let currentSentences: string[] = [];
  let currentTokens = 0;

  for (const sentence of sentences) {
    const sentenceTokens = countTokens(sentence);

    if (currentTokens + sentenceTokens > maxTokens && currentSentences.length > 0) {
      const chunkContent = currentSentences.join('').trim();
      results.push({
        ...chunk,
        content: chunkContent,
        content_preview: chunkContent.slice(0, 200),
        chunk_index: startIndex + results.length,
        chunk_hash: sha256(chunkContent),
        token_count: countTokens(chunkContent),
        citation_label: buildCitationLabel(docTitle, chunk.section_title, chunk.page_number, startIndex + results.length),
      });

      // Build overlap
      let overlapSentences: string[] = [];
      let overlapCount = 0;
      for (let i = currentSentences.length - 1; i >= 0; i--) {
        const st = countTokens(currentSentences[i]);
        if (overlapCount + st > overlapTokens && overlapSentences.length > 0) break;
        overlapSentences.unshift(currentSentences[i]);
        overlapCount += st;
      }

      currentSentences = [...overlapSentences, sentence];
      currentTokens = overlapCount + sentenceTokens;
    } else {
      currentSentences.push(sentence);
      currentTokens += sentenceTokens;
    }
  }

  if (currentSentences.length > 0) {
    const chunkContent = currentSentences.join('').trim();
    if (chunkContent.length > 0) {
      results.push({
        ...chunk,
        content: chunkContent,
        content_preview: chunkContent.slice(0, 200),
        chunk_index: startIndex + results.length,
        chunk_hash: sha256(chunkContent),
        token_count: countTokens(chunkContent),
        citation_label: buildCitationLabel(docTitle, chunk.section_title, chunk.page_number, startIndex + results.length),
      });
    }
  }

  return results;
}

/**
 * Post-compose guardrails:
 * 1. Drop retrieval-bearing chunks under 30 tokens (unless exempt type)
 * 2. Split chunks over 1,000 tokens at sentence boundaries
 */
function applyGuardrails(
  chunks: PreparedChunk[],
  docTitle: string,
  overlapTokens: number,
): PreparedChunk[] {
  const MAX_GUARDRAIL_TOKENS = 1000;
  const MIN_GUARDRAIL_TOKENS = 30;
  const result: PreparedChunk[] = [];

  for (const chunk of chunks) {
    // Minimum size filter: only for retrieval-bearing, non-exempt chunks
    if (
      !chunk.retrieval_excluded &&
      chunk.token_count < MIN_GUARDRAIL_TOKENS &&
      !MIN_TOKEN_EXEMPT_TYPES.has(chunk.section_type ?? '')
    ) {
      continue; // drop
    }

    // Maximum size enforcement
    if (chunk.token_count > MAX_GUARDRAIL_TOKENS) {
      const splits = splitLargeChunk(chunk, MAX_GUARDRAIL_TOKENS, overlapTokens, docTitle, result.length);
      result.push(...splits);
    } else {
      result.push({ ...chunk, chunk_index: result.length });
    }
  }

  // Re-index
  for (let i = 0; i < result.length; i++) {
    result[i].chunk_index = i;
  }

  return result;
}

/**
 * Structure-aware prose chunker for PDF, DOCX, and TXT extracted content.
 *
 * - Tables and lists are always atomic (never split)
 * - procedure_step / instruction_block: never merged into unrelated text
 * - warning / note: kept as distinct chunks
 * - Small adjacent sections are merged up to maxTokens
 * - Large sections are split at sentence boundaries with overlap
 * - Overlap is ONLY applied at artificial splits within a section
 * - Post-compose guardrails enforce min/max token limits
 *
 * Accepts NormalisedSection[] (v2) or ExtractedSection[] (backward-compatible).
 */
export function chunkProse(
  sections: (NormalisedSection | ExtractedSection)[],
  docTitle: string,
  options?: { maxTokens?: number; overlapTokens?: number },
): PreparedChunk[] {
  const maxTokens = options?.maxTokens ?? 800;
  const overlapTokens = options?.overlapTokens ?? 120;
  const chunks: PreparedChunk[] = [];

  let currentSectionTitle: string | null = null;

  // Buffer state for merging small sections
  let buffer = '';
  let bufferTokens = 0;
  let bufferPage: number | null = null;
  let bufferSectionTitle: string | null = null;
  let bufferSections: NormalisedSection[] = [];
  let bufferType: string | null = null;

  function bufferV2() {
    if (bufferSections.length === 0) {
      return {
        section_type: 'paragraph' as SectionType,
        section_types: [] as SectionType[],
        is_boilerplate: false,
        retrieval_excluded: false,
        retrieval_downranked: false,
        boilerplate_hash: null as string | null,
        normalisation_reason: null as Record<string, unknown> | null,
      };
    }
    const first = bufferSections[0];
    const types = bufferSections.map((s) => s.section_type);
    return {
      section_type: first.section_type,
      section_types: types,
      is_boilerplate: first.is_boilerplate,
      retrieval_excluded: bufferSections.some((s) => s.retrieval_excluded),
      retrieval_downranked: bufferSections.some((s) => s.retrieval_downranked),
      boilerplate_hash: first.boilerplate_hash,
      normalisation_reason: first.normalisation_reason,
    };
  }

  function flushBuffer() {
    if (buffer.trim().length === 0) {
      bufferSections = [];
      return;
    }
    const v2 = bufferV2();
    chunks.push(
      makeChunk(buffer.trim(), chunks.length, bufferSectionTitle, bufferPage, docTitle, v2),
    );
    buffer = '';
    bufferTokens = 0;
    bufferPage = null;
    bufferSectionTitle = null;
    bufferType = null;
    bufferSections = [];
  }

  for (const rawSection of sections) {
    const section = asNormalised(rawSection);

    // Track heading as current section title
    if (section.type === 'heading' && section.title) {
      currentSectionTitle = section.title;
    }

    const sectionTitle = currentSectionTitle;
    const page = section.page ?? null;
    const sType = section.section_type;

    const v2Fields = {
      section_type: section.section_type,
      section_types: [section.section_type],
      is_boilerplate: section.is_boilerplate,
      retrieval_excluded: section.retrieval_excluded,
      retrieval_downranked: section.retrieval_downranked,
      boilerplate_hash: section.boilerplate_hash,
      normalisation_reason: section.normalisation_reason,
    };

    // Atomic types: table and list are never split
    if (section.type === 'table' || section.type === 'list') {
      flushBuffer();
      chunks.push(
        makeChunk(section.content, chunks.length, sectionTitle, page, docTitle, v2Fields),
      );
      continue;
    }

    // Distinct types: warning/note get their own chunk
    if (DISTINCT_TYPES.has(sType)) {
      flushBuffer();
      chunks.push(
        makeChunk(section.content, chunks.length, sectionTitle, page, docTitle, v2Fields),
      );
      continue;
    }

    // Break-before types: procedure_step/instruction_block must not merge with
    // unrelated content. But adjacent same-type sections CAN merge.
    if (BREAK_BEFORE_TYPES.has(sType) && bufferType !== sType) {
      flushBuffer();
      // Fall through to normal buffering — buffer is now empty so it starts fresh
    }

    // Excluded sections must not merge with non-excluded content (and vice versa)
    if (
      bufferSections.length > 0 &&
      section.retrieval_excluded !== bufferSections[0].retrieval_excluded
    ) {
      flushBuffer();
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
          const chunkContent = currentChunkSentences.join('').trim();
          chunks.push(
            makeChunk(chunkContent, chunks.length, sectionTitle, page, docTitle, v2Fields),
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
            makeChunk(chunkContent, chunks.length, sectionTitle, page, docTitle, v2Fields),
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
    bufferSections.push(section);
    bufferTokens = countTokens(buffer);
    if (bufferType === null) bufferType = sType;

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

  // Apply post-compose guardrails
  return applyGuardrails(chunks, docTitle, overlapTokens);
}
