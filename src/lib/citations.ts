import type { ScoredChunk, CitedChunk } from './types';

export interface GroupedSource {
  groupKey: string;
  doc_title: string;
  folder: string;
  section_title: string | null;
  preview: string;
  chunks: CitedChunk[];
}

const PREVIEW_MAX_CHARS = 280;
const PREVIEW_MAX_SNIPPETS = 3;
const NO_EVIDENCE_TEXT = 'No grounded evidence found in the document corpus for this question.';

export function shouldShowSources(answer: string, sources?: CitedChunk[]): boolean {
  if (!sources || sources.length === 0) return false;
  const normalizedAnswer = answer.trim();
  if (!normalizedAnswer) return true;
  return !normalizedAnswer.includes(NO_EVIDENCE_TEXT);
}

function deriveFamilyKey(citationLabel: string): string {
  const prefixRegex = /^([A-Z]+(?:-[A-Z]+)?\s*\d{3}\s*(?:\(?V\d+\)?))/i;
  const match = citationLabel.match(prefixRegex);
  if (match) return match[1].trim();

  const commaIdx = citationLabel.indexOf(',');
  return commaIdx !== -1 ? citationLabel.slice(0, commaIdx).trim() : citationLabel.trim();
}

function buildPreview(chunks: CitedChunk[]): string {
  const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

  // Keep only the most informative candidates before distinctness checks.
  const sorted = [...chunks]
    .sort((a, b) => (b.content_preview?.length ?? 0) - (a.content_preview?.length ?? 0))
    .slice(0, 10);

  const selected: string[] = [];
  for (const chunk of sorted) {
    if (!chunk.content_preview) continue;
    const candidate = chunk.content_preview.replace(/\s+/g, ' ').trim();
    if (!candidate) continue;

    const norm = normalise(candidate);
    const isDuplicate = selected.some((s) => {
      const normSelected = normalise(s);
      return normSelected === norm || normSelected.includes(norm) || norm.includes(normSelected);
    });

    if (!isDuplicate) selected.push(candidate);
    if (selected.length >= PREVIEW_MAX_SNIPPETS) break;
  }

  const joined = selected.join(' ... ');
  if (!joined.trim()) return 'No preview available from matched sections.';
  if (joined.length <= PREVIEW_MAX_CHARS) return joined;
  return joined.slice(0, PREVIEW_MAX_CHARS - 3) + '...';
}

export function groupChunksByDocument(chunks: CitedChunk[]): GroupedSource[] {
  const groups = new Map<string, CitedChunk[]>();

  for (const chunk of chunks) {
    const familyKey = deriveFamilyKey(chunk.citation_label);
    const folder = chunk.folder ?? '';
    const groupKey = `${chunk.doc_title}|||${folder}|||${familyKey}`;
    const existing = groups.get(groupKey) ?? [];
    groups.set(groupKey, [...existing, chunk]);
  }

  return Array.from(groups.entries())
    .map(([groupKey, groupChunks]) => {
      const first = groupChunks[0];
      const cappedChunks = groupChunks.slice(0, 10);

      const bestChunk = cappedChunks.reduce((a, b) => {
        const lenA = a.content_preview?.length ?? 0;
        const lenB = b.content_preview?.length ?? 0;
        if (lenB !== lenA) return lenB > lenA ? b : a;

        const uniqueA = new Set((a.content_preview ?? '').toLowerCase().match(/\b\w+\b/g) ?? []).size;
        const uniqueB = new Set((b.content_preview ?? '').toLowerCase().match(/\b\w+\b/g) ?? []).size;
        return uniqueB > uniqueA ? b : a;
      });

      return {
        groupKey,
        doc_title: first.doc_title || 'Unknown document',
        folder: first.folder,
        section_title: bestChunk.section_title ?? null,
        preview: buildPreview(cappedChunks),
        chunks: groupChunks,
      };
    })
    .sort((a, b) => b.chunks.length - a.chunks.length || b.preview.length - a.preview.length);
}

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
