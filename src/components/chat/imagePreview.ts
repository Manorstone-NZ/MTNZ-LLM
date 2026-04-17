import type { CitedChunk } from '@/lib/types';

export interface InlineImagePreview {
  documentId: string;
  title: string;
  sectionTitle: string | null;
  previewUrl: string;
}

const IMAGE_SOURCE_TYPES = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'bmp',
  'webp',
  'tif',
  'tiff',
]);

export function buildInlineImagePreviews(sources: CitedChunk[] | undefined): InlineImagePreview[] {
  if (!sources || sources.length === 0) return [];

  const grouped = new Map<string, CitedChunk[]>();
  for (const source of sources) {
    const docId = source.document_id;
    if (!docId) continue;
    const existing = grouped.get(docId) ?? [];
    grouped.set(docId, [...existing, source]);
  }

  const previews: InlineImagePreview[] = [];
  for (const [docId, chunks] of grouped.entries()) {
    const first = chunks[0];
    if (!first.source_type || !IMAGE_SOURCE_TYPES.has(first.source_type.toLowerCase())) continue;

    const bestSection = [...chunks].sort(
      (a, b) => (b.content_preview?.length ?? 0) - (a.content_preview?.length ?? 0)
    )[0]?.section_title ?? null;

    previews.push({
      documentId: docId,
      title: first.doc_title || 'Untitled image',
      sectionTitle: bestSection,
      previewUrl: `/api/documents/${docId}/preview`,
    });
  }

  return previews;
}