import type { CitedChunk } from './types';

export interface SynthesisContext {
  groupedSources: Array<{
    docTitle: string;
    citationLabels: string[];
    sectionTitles: string[];
    snippets: string[];
  }>;
}

function lineLooksListLike(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^[-*]\s+/.test(trimmed)) return true;
  if (/^\d+[\.)]\s+/.test(trimmed)) return true;
  if (/\b(code|codes|test type|program|programme|sample type|result code)\b/i.test(trimmed)) {
    return true;
  }
  if (/\b\d{2,3}\s+[A-Za-z]/.test(trimmed)) return true;
  return false;
}

function extractSnippetCandidates(contentPreview: string): string[] {
  return contentPreview
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => lineLooksListLike(line))
    .slice(0, 3);
}

export function buildSynthesisContext(chunks: CitedChunk[]): SynthesisContext {
  const grouped = new Map<string, {
    docTitle: string;
    citationLabels: Set<string>;
    sectionTitles: Set<string>;
    snippets: Set<string>;
  }>();

  for (const chunk of chunks) {
    const key = chunk.document_id ?? `${chunk.doc_title}|||${chunk.folder}`;
    const existing = grouped.get(key) ?? {
      docTitle: chunk.doc_title,
      citationLabels: new Set<string>(),
      sectionTitles: new Set<string>(),
      snippets: new Set<string>(),
    };

    if (chunk.citation_label) existing.citationLabels.add(chunk.citation_label);
    if (chunk.section_title) existing.sectionTitles.add(chunk.section_title);
    if (chunk.content_preview) {
      for (const snippet of extractSnippetCandidates(chunk.content_preview)) {
        existing.snippets.add(snippet);
      }
    }

    grouped.set(key, existing);
  }

  const groupedSources = Array.from(grouped.values())
    .map((entry) => ({
      docTitle: entry.docTitle,
      citationLabels: Array.from(entry.citationLabels).slice(0, 6),
      sectionTitles: Array.from(entry.sectionTitles).slice(0, 6),
      snippets: Array.from(entry.snippets).slice(0, 8),
    }))
    .sort((a, b) => b.citationLabels.length - a.citationLabels.length)
    .slice(0, 16);

  return { groupedSources };
}
