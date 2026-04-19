import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDocumentPreviewPath, groupChunksByDocument, isPreviewableImageSourceType } from './citations';
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