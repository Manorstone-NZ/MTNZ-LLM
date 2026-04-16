import type { ScoredChunk, CitedChunk } from './types';

export function formatChunksForPrompt(chunks: ScoredChunk[]): CitedChunk[] {
  return chunks.map(chunk => ({
    chunk_id: chunk.id,
    citation_label: chunk.citation_label,
    doc_title: chunk.doc_title,
    folder: chunk.folder,
    page: chunk.page_number,
    section_title: chunk.section_title,
    sheet_name: chunk.sheet_name,
    content_preview: chunk.content_preview,
  }));
}

export function formatChunksWithContent(chunks: ScoredChunk[]): Array<CitedChunk & { content: string }> {
  // Same as above but includes the full content field for the answer model
  return chunks.map(chunk => ({
    chunk_id: chunk.id,
    citation_label: chunk.citation_label,
    doc_title: chunk.doc_title,
    folder: chunk.folder,
    page: chunk.page_number,
    section_title: chunk.section_title,
    sheet_name: chunk.sheet_name,
    content_preview: chunk.content_preview,
    content: chunk.content,
  }));
}

export function validateCitations(answer: string, providedLabels: string[]): {
  valid: string[];
  invalid: string[];
} {
  // Extract all [Source: ...] patterns from the answer text
  const citationRegex = /\[Source:\s*([^\]]+)\]/g;
  const cited: string[] = [];
  let match;
  while ((match = citationRegex.exec(answer)) !== null) {
    cited.push(match[1].trim());
  }

  const valid = cited.filter(c => providedLabels.includes(c));
  const invalid = cited.filter(c => !providedLabels.includes(c));

  return { valid, invalid };
}
