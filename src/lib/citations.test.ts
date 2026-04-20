import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDocumentPreviewPath,
  buildReferencesSuffix,
  groupChunksByDocument,
  isPreviewableImageSourceType,
  normalizeAnswerWithReferences,
} from './citations';
import type { CitedChunk } from './types';

test('identifies previewable image source types', () => {
  assert.equal(isPreviewableImageSourceType('png'), true);
  assert.equal(isPreviewableImageSourceType('JPEG'), true);
  assert.equal(isPreviewableImageSourceType('pdf'), false);
  assert.equal(isPreviewableImageSourceType(undefined), false);
});

test('builds a document preview path for previewable image documents only', () => {
  assert.equal(buildDocumentPreviewPath('doc-123', 'png'), '/api/documents/doc-123/preview');
  assert.equal(buildDocumentPreviewPath('doc-123', 'pdf'), null);
  assert.equal(buildDocumentPreviewPath(undefined, 'png'), null);
});

test('groupChunksByDocument carries image preview metadata for image sources', () => {
  const chunks: CitedChunk[] = [
    {
      chunk_id: 'chunk-1',
      document_id: 'doc-image',
      source_type: 'png',
      citation_label: 'WebsiteVialRequestForm, screenshot',
      doc_title: 'WebsiteVialRequestForm',
      folder: 'Forms',
      page: null,
      section_title: 'WebsiteVialRequestForm',
      sheet_name: null,
      content_preview: 'A screenshot of the form.',
    },
  ];

  const groups = groupChunksByDocument(chunks);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].document_id, 'doc-image');
  assert.equal(groups[0].source_type, 'png');
  assert.equal(groups[0].preview_image_url, '/api/documents/doc-image/preview');
});

test('buildReferencesSuffix returns a separate References block', () => {
  const suffix = buildReferencesSuffix([
    'LOP-QM 001 (V9) Proficiency Testing Manual, 2',
    'LOP-MC 001 (V1) MADCAP Procedures Manual, 1',
  ]);

  assert.ok(suffix.startsWith('\n\nReferences:\n'));
  assert.match(suffix, /- \[Source: LOP-QM 001 \(V9\) Proficiency Testing Manual, 2\]/);
  assert.match(suffix, /- \[Source: LOP-MC 001 \(V1\) MADCAP Procedures Manual, 1\]/);
});

test('buildReferencesSuffix returns empty string when no labels are provided', () => {
  assert.equal(buildReferencesSuffix([]), '');
});

test('normalizeAnswerWithReferences removes inline citations and appends References section', () => {
  const out = normalizeAnswerWithReferences(
    'Test types are colour-coded [Source: LOP-QM 001, 2]. Setup can be added [Source: LOP-MC 001, 1].',
  );

  assert.doesNotMatch(out.answerText.split('References:')[0] ?? out.answerText, /\[Source:\s*[^\]]+\]/);
  assert.match(out.answerText, /\n\nReferences:\n/);
  assert.match(out.answerText, /- \[Source: LOP-QM 001, 2\]/);
  assert.match(out.answerText, /- \[Source: LOP-MC 001, 1\]/);
  assert.equal(out.references.length, 2);
});

test('normalizeAnswerWithReferences uses fallback labels when inline citations are absent', () => {
  const out = normalizeAnswerWithReferences('Short grounded answer.', {
    fallbackLabels: ['LOP-QM 001, 2'],
    noEvidenceMessage: 'No grounded evidence found in the document corpus for this question.',
  });

  assert.match(out.answerText, /\n\nReferences:\n- \[Source: LOP-QM 001, 2\]/);
});