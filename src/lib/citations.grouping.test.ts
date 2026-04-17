import type { CitedChunk } from './types';
import { groupChunksByDocument } from './citations';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

function makeChunk(overrides: Partial<CitedChunk> & { chunk_id: string }): CitedChunk {
  return {
    citation_label: 'LOP-MC 001 (V1), Section 1',
    doc_title: 'Test Manual',
    folder: 'LOP',
    page: null,
    section_title: null,
    sheet_name: null,
    content_preview: 'Some content.',
    ...overrides,
    chunk_id: overrides.chunk_id,
  };
}

function testGroupsSameDocument(): void {
  const chunks = [
    makeChunk({ chunk_id: 'a', content_preview: 'Content A.' }),
    makeChunk({ chunk_id: 'b', content_preview: 'Content B.' }),
  ];
  const result = groupChunksByDocument(chunks);
  assert(result.length === 1, 'groups chunks from same document into one entry');
  assert(result[0].chunks.length === 2, 'keeps both chunks in same group');
}

function testKeepsDifferentDocumentsSeparate(): void {
  const chunks = [
    makeChunk({ chunk_id: 'a', doc_title: 'Manual A', citation_label: 'LOP-MC 001 (V1)' }),
    makeChunk({ chunk_id: 'b', doc_title: 'Manual B', citation_label: 'LOP-MC 002 (V1)' }),
  ];
  const result = groupChunksByDocument(chunks);
  assert(result.length === 2, 'keeps different documents separate');
}

function testNoMergeDifferentVersions(): void {
  const chunks = [
    makeChunk({ chunk_id: 'a', citation_label: 'LOP-MC 001 (V1), Section 1' }),
    makeChunk({ chunk_id: 'b', citation_label: 'LOP-MC 001 (V2), Section 1' }),
  ];
  const result = groupChunksByDocument(chunks);
  assert(result.length === 2, 'does not merge different versions of same document');
}

function testNoMergeDifferentFolders(): void {
  const chunks = [
    makeChunk({ chunk_id: 'a', folder: 'LOP' }),
    makeChunk({ chunk_id: 'b', folder: 'EOP' }),
  ];
  const result = groupChunksByDocument(chunks);
  assert(result.length === 2, 'does not merge same title when folders differ');
}

function testSelectsSectionFromLongestPreview(): void {
  const chunks = [
    makeChunk({ chunk_id: 'a', section_title: 'Short', content_preview: 'Short.' }),
    makeChunk({
      chunk_id: 'b',
      section_title: 'Long',
      content_preview: 'This is a much longer preview with more content.',
    }),
  ];
  const result = groupChunksByDocument(chunks);
  assert(result[0].section_title === 'Long', 'selects section from longest preview chunk');
}

function testSectionNullWhenMissing(): void {
  const chunks = [makeChunk({ chunk_id: 'a', section_title: null })];
  const result = groupChunksByDocument(chunks);
  assert(result[0].section_title === null, 'section_title is null when none is available');
}

function testPreviewSnippetLimit(): void {
  const chunks = [
    makeChunk({ chunk_id: 'a', content_preview: 'Alpha content here.' }),
    makeChunk({ chunk_id: 'b', content_preview: 'Beta content here, longer text.' }),
    makeChunk({ chunk_id: 'c', content_preview: 'Gamma content here, even longer text now.' }),
    makeChunk({ chunk_id: 'd', content_preview: 'Delta content here, the fourth distinct snippet.' }),
  ];
  const result = groupChunksByDocument(chunks);
  const snippetCount = (result[0].preview.match(/ \.\.\. /g) ?? []).length + 1;
  assert(snippetCount <= 3, 'preview includes at most 3 snippets');
}

function testPreviewLengthClamp(): void {
  const chunks = [
    makeChunk({ chunk_id: 'a', content_preview: 'A'.repeat(120) }),
    makeChunk({ chunk_id: 'b', content_preview: 'B'.repeat(120) }),
    makeChunk({ chunk_id: 'c', content_preview: 'C'.repeat(120) }),
  ];
  const result = groupChunksByDocument(chunks);
  assert(result[0].preview.length <= 280, 'preview is clamped to 280 chars');
}

function testDeduplicatesExactPreviews(): void {
  const chunks = [
    makeChunk({ chunk_id: 'a', content_preview: 'Same content.' }),
    makeChunk({ chunk_id: 'b', content_preview: 'Same content.' }),
  ];
  const result = groupChunksByDocument(chunks);
  assert(result[0].preview === 'Same content.', 'deduplicates exact duplicate previews');
}

function testFallbackPreviewWhenEmpty(): void {
  const chunks = [makeChunk({ chunk_id: 'a', content_preview: '' })];
  const result = groupChunksByDocument(chunks);
  assert(
    result[0].preview === 'No preview available from matched sections.',
    'uses fallback preview text when all previews are empty'
  );
}

function testUnknownDocumentFallback(): void {
  const chunks = [makeChunk({ chunk_id: 'a', doc_title: '' })];
  const result = groupChunksByDocument(chunks);
  assert(result[0].doc_title === 'Unknown document', 'uses fallback title for missing doc_title');
}

function testStableOrdering(): void {
  const chunks = [
    makeChunk({ chunk_id: 'a', doc_title: 'Doc A', citation_label: 'LOP-MC 001 (V1)', content_preview: 'A' }),
    makeChunk({ chunk_id: 'b', doc_title: 'Doc A', citation_label: 'LOP-MC 001 (V1)', content_preview: 'AA' }),
    makeChunk({ chunk_id: 'c', doc_title: 'Doc B', citation_label: 'LOP-MC 002 (V1)', content_preview: 'BBBBBBBB' }),
  ];
  const result = groupChunksByDocument(chunks);
  assert(result[0].doc_title === 'Doc A', 'orders groups by chunk count first');
}

function main(): void {
  console.log('=== citations grouping tests ===');
  testGroupsSameDocument();
  testKeepsDifferentDocumentsSeparate();
  testNoMergeDifferentVersions();
  testNoMergeDifferentFolders();
  testSelectsSectionFromLongestPreview();
  testSectionNullWhenMissing();
  testPreviewSnippetLimit();
  testPreviewLengthClamp();
  testDeduplicatesExactPreviews();
  testFallbackPreviewWhenEmpty();
  testUnknownDocumentFallback();
  testStableOrdering();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
