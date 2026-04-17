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
 * Build a citation label for a spreadsheet chunk.
 */
function buildCitationLabel(
  docTitle: string,
  sheetName: string | null,
  rangeRef: string | null,
): string {
  if (sheetName && rangeRef) {
    return `${docTitle}, Sheet: ${sheetName}, ${rangeRef}`;
  }
  if (sheetName) {
    return `${docTitle}, Sheet: ${sheetName}`;
  }
  return docTitle;
}

/**
 * Extract v2 fields from a section, with backward-compatible defaults.
 */
function extractV2Fields(section: Partial<NormalisedSection>) {
  const ns = section as NormalisedSection;
  const excluded = ns.retrieval_excluded ?? false;
  return {
    section_type: (ns.section_type ?? 'table') as SectionType,
    is_boilerplate: ns.is_boilerplate ?? false,
    retrieval_excluded: excluded,
    retrieval_downranked: ns.retrieval_downranked ?? false,
    boilerplate_hash: ns.boilerplate_hash ?? null,
    normalisation_reason: ns.normalisation_reason ?? null,
    embedding_status: (excluded ? 'skipped_excluded' : 'pending') as PreparedChunk['embedding_status'],
  };
}

/**
 * Spreadsheet-aware chunker for XLSX extracted content.
 *
 * - Each section from XLSX extraction is a candidate chunk
 * - Large sections are split by row groups, preserving column headers
 * - Sheet name and range references are tracked in metadata
 * - V2 fields (section_type, retrieval flags) are passed through
 *
 * Accepts NormalisedSection[] (v2) or ExtractedSection[] (backward-compatible).
 */
export function chunkSpreadsheet(
  sections: (NormalisedSection | ExtractedSection)[],
  docTitle: string,
  options?: { maxTokens?: number },
): PreparedChunk[] {
  const maxTokens = options?.maxTokens ?? 1000;
  const chunks: PreparedChunk[] = [];

  for (const section of sections) {
    const meta = (section as NormalisedSection & { metadata?: Record<string, unknown> }).metadata ?? {};
    const sheetName = (meta.sheet_name as string) ?? section.title ?? null;
    const rangeRef = (meta.range_ref as string) ?? null;
    const columnHeaders = (meta.column_headers as string) ?? null;
    const formulaPresent = (meta.formula_present as boolean) ?? false;

    const v2 = extractV2Fields(section);
    const sectionTokens = countTokens(section.content);

    if (sectionTokens <= maxTokens) {
      // Section fits in one chunk
      const content = section.content;
      chunks.push({
        content,
        content_preview: content.slice(0, 200),
        chunk_index: chunks.length,
        chunk_hash: sha256(content),
        token_count: sectionTokens,
        page_number: null,
        section_title: section.title,
        sheet_name: sheetName,
        range_ref: rangeRef,
        citation_label: buildCitationLabel(docTitle, sheetName, rangeRef),
        metadata: {
          ...(columnHeaders ? { column_headers: columnHeaders } : {}),
          formula_present: formulaPresent,
        },
        section_type: v2.section_type,
        is_boilerplate: v2.is_boilerplate,
        retrieval_excluded: v2.retrieval_excluded,
        retrieval_downranked: v2.retrieval_downranked,
        boilerplate_hash: v2.boilerplate_hash,
        normalisation_reason: v2.normalisation_reason,
        embedding_status: v2.embedding_status,
      });
      continue;
    }

    // Section exceeds maxTokens — split by row groups, keeping headers
    const lines = section.content.split('\n');

    // First line is typically the header row for table sections
    const headerLine = columnHeaders ?? (lines.length > 0 ? lines[0] : '');
    const headerTokens = countTokens(headerLine + '\n');
    const dataLines = columnHeaders ? lines : lines.slice(1);
    const availableTokens = maxTokens - headerTokens;

    let currentLines: string[] = [];
    let currentTokens = 0;
    let splitIndex = 0;

    for (const line of dataLines) {
      const lineTokens = countTokens(line + '\n');

      if (currentTokens + lineTokens > availableTokens && currentLines.length > 0) {
        // Emit chunk with headers prepended
        const content = (headerLine + '\n' + currentLines.join('\n')).trim();
        const splitRange = rangeRef ? `${rangeRef} (part ${splitIndex + 1})` : `part ${splitIndex + 1}`;
        chunks.push({
          content,
          content_preview: content.slice(0, 200),
          chunk_index: chunks.length,
          chunk_hash: sha256(content),
          token_count: countTokens(content),
          page_number: null,
          section_title: section.title,
          sheet_name: sheetName,
          range_ref: splitRange,
          citation_label: buildCitationLabel(docTitle, sheetName, splitRange),
          metadata: {
            ...(columnHeaders ? { column_headers: columnHeaders } : {}),
            formula_present: formulaPresent,
          },
          section_type: v2.section_type,
          is_boilerplate: v2.is_boilerplate,
          retrieval_excluded: v2.retrieval_excluded,
          retrieval_downranked: v2.retrieval_downranked,
          boilerplate_hash: v2.boilerplate_hash,
          normalisation_reason: v2.normalisation_reason,
          embedding_status: v2.embedding_status,
        });
        currentLines = [];
        currentTokens = 0;
        splitIndex++;
      }

      currentLines.push(line);
      currentTokens += lineTokens;
    }

    // Emit remaining rows
    if (currentLines.length > 0) {
      const content = (headerLine + '\n' + currentLines.join('\n')).trim();
      const splitRange = splitIndex > 0
        ? (rangeRef ? `${rangeRef} (part ${splitIndex + 1})` : `part ${splitIndex + 1}`)
        : rangeRef;
      chunks.push({
        content,
        content_preview: content.slice(0, 200),
        chunk_index: chunks.length,
        chunk_hash: sha256(content),
        token_count: countTokens(content),
        page_number: null,
        section_title: section.title,
        sheet_name: sheetName,
        range_ref: splitRange,
        citation_label: buildCitationLabel(docTitle, sheetName, splitRange),
        metadata: {
          ...(columnHeaders ? { column_headers: columnHeaders } : {}),
          formula_present: formulaPresent,
        },
        section_type: v2.section_type,
        is_boilerplate: v2.is_boilerplate,
        retrieval_excluded: v2.retrieval_excluded,
        retrieval_downranked: v2.retrieval_downranked,
        boilerplate_hash: v2.boilerplate_hash,
        normalisation_reason: v2.normalisation_reason,
        embedding_status: v2.embedding_status,
      });
    }
  }

  return chunks;
}
