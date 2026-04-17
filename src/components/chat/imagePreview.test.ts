import { buildInlineImagePreviews } from './imagePreview';
import type { CitedChunk } from '@/lib/types';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

function makeChunk(overrides: Partial<CitedChunk> = {}): CitedChunk {
  return {
    chunk_id: 'chunk-1',
    citation_label: 'SUP 001, Section 1',
    doc_title: 'Image Doc',
    folder: 'Supporting',
    page: null,
    section_title: null,
    sheet_name: null,
    content_preview: 'Preview text',
    document_id: 'doc-1',
    source_type: 'png',
    ...overrides,
  };
}

function testBuildsPreviewForImageSources(): void {
  console.log('\nTest 1: builds previews from image-cited sources');
  const previews = buildInlineImagePreviews([
    makeChunk({ document_id: 'doc-a', source_type: 'png', doc_title: 'Flow Diagram' }),
    makeChunk({ document_id: 'doc-b', source_type: 'jpg', doc_title: 'Request Form' }),
  ]);

  assert(previews.length === 2, 'Creates two image previews');
  assert(previews[0].previewUrl === '/api/documents/doc-a/preview', 'Builds preview URL by document id');
}

function testSkipsNonImageSources(): void {
  console.log('\nTest 2: skips non-image sources');
  const previews = buildInlineImagePreviews([
    makeChunk({ document_id: 'doc-a', source_type: 'pdf' }),
    makeChunk({ document_id: 'doc-b', source_type: 'docx' }),
  ]);

  assert(previews.length === 0, 'No previews returned for non-image source types');
}

function testDeduplicatesByDocumentId(): void {
  console.log('\nTest 3: deduplicates previews by document id');
  const previews = buildInlineImagePreviews([
    makeChunk({ document_id: 'doc-a', section_title: 'Short', content_preview: 'short' }),
    makeChunk({ document_id: 'doc-a', section_title: 'Long', content_preview: 'this is longer preview text' }),
  ]);

  assert(previews.length === 1, 'Returns one preview per image document');
  assert(previews[0].sectionTitle === 'Long', 'Uses best section title from most informative chunk');
}

function main(): void {
  console.log('=== inline image preview tests ===');
  testBuildsPreviewForImageSources();
  testSkipsNonImageSources();
  testDeduplicatesByDocumentId();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();