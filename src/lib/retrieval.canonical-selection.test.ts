import test from 'node:test';
import assert from 'node:assert/strict';

import { pickSynthesisResults } from './retrieval';
import type { ScoredChunk } from './types';

function makeChunk(overrides: Partial<ScoredChunk> = {}): ScoredChunk {
  return {
    id: overrides.id ?? 'chunk-1',
    document_id: overrides.document_id ?? 'doc-1',
    source_type: overrides.source_type ?? 'pdf',
    content: overrides.content ?? 'content',
    content_preview: overrides.content_preview ?? overrides.content ?? 'preview',
    citation_label: overrides.citation_label ?? 'Source 1',
    section_title: overrides.section_title ?? null,
    sheet_name: overrides.sheet_name ?? null,
    page_number: overrides.page_number ?? null,
    doc_title: overrides.doc_title ?? 'Document',
    folder: overrides.folder ?? 'LOP',
    score: overrides.score ?? 1,
    vector_score: overrides.vector_score,
    fts_score: overrides.fts_score,
    trigram_score: overrides.trigram_score,
    retrieval_downranked: overrides.retrieval_downranked,
  };
}

test('pickSynthesisResults preserves one authoritative structured source for canonical queries', () => {
  const ranked: ScoredChunk[] = [
    makeChunk({ id: 'pdf-1', document_id: 'doc-pdf-1', doc_title: 'Procedure Manual A', score: 0.99 }),
    makeChunk({ id: 'pdf-2', document_id: 'doc-pdf-2', doc_title: 'Procedure Manual B', score: 0.98 }),
    makeChunk({ id: 'pdf-3', document_id: 'doc-pdf-3', doc_title: 'Procedure Manual C', score: 0.97 }),
    makeChunk({
      id: 'xlsx-1',
      document_id: 'doc-xlsx-1',
      source_type: 'xlsx',
      doc_title: 'Customer Test Mapping Matrix',
      section_title: 'Customer mapping',
      score: 0.9,
    }),
  ];

  const selected = pickSynthesisResults(ranked, 3, 1, {
    preserveAuthoritativeStructuredSource: true,
  });

  assert.equal(selected.length, 3);
  assert.equal(selected.some((chunk) => chunk.source_type === 'xlsx'), true);
});

test('pickSynthesisResults does not invent authoritative sources when none exist', () => {
  const ranked: ScoredChunk[] = [
    makeChunk({ id: 'pdf-1', document_id: 'doc-pdf-1', doc_title: 'Procedure Manual A', score: 0.99 }),
    makeChunk({ id: 'pdf-2', document_id: 'doc-pdf-2', doc_title: 'Procedure Manual B', score: 0.98 }),
    makeChunk({ id: 'pdf-3', document_id: 'doc-pdf-3', doc_title: 'Procedure Manual C', score: 0.97 }),
  ];

  const selected = pickSynthesisResults(ranked, 2, 1, {
    preserveAuthoritativeStructuredSource: true,
  });

  assert.equal(selected.length, 2);
  assert.equal(selected.some((chunk) => chunk.source_type === 'xlsx' || chunk.source_type === 'csv'), false);
});