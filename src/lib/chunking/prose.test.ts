/**
 * Synthetic test for type-aware prose chunker with post-compose guardrails (Task 8).
 * Run: npx tsx src/lib/chunking/prose.test.ts
 */
import type { NormalisedSection } from '../types';
import { chunkProse } from './prose';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSection(
  overrides: Partial<NormalisedSection> & { content: string },
): NormalisedSection {
  const {
    title = null,
    content,
    type = 'paragraph',
    section_type = 'paragraph',
    section_type_confidence = 1,
    retrieval_excluded = false,
    retrieval_downranked = false,
    is_boilerplate = false,
    boilerplate_hash = null,
    normalisation_reason = null,
    ...rest
  } = overrides;
  return {
    title,
    content,
    type,
    section_type,
    section_type_confidence,
    retrieval_excluded,
    retrieval_downranked,
    is_boilerplate,
    boilerplate_hash,
    normalisation_reason,
    ...rest,
  };
}

/** Generate a string of roughly N tokens (approx 4 chars per token). */
function loremTokens(n: number): string {
  const word = 'Lorem ';
  return word.repeat(Math.ceil(n)).slice(0, n * 4);
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL: ${msg}`);
  }
}

// ---------------------------------------------------------------------------
// Test sections
// ---------------------------------------------------------------------------

const sections: NormalisedSection[] = [
  makeSection({
    title: 'Introduction',
    type: 'heading',
    section_type: 'heading',
    content: 'Introduction',
  }),
  makeSection({
    content: 'This is the first paragraph with some content about industrial safety procedures and equipment maintenance protocols that need to be followed carefully.',
    section_type: 'paragraph',
  }),
  makeSection({
    content: 'Second small paragraph that should merge with the first because they are both regular paragraph sections and fit within the token budget for a single chunk.',
    section_type: 'paragraph',
  }),
  makeSection({
    content: 'Step 1: Open the valve. Turn clockwise until locked.',
    section_type: 'procedure_step',
    type: 'paragraph',
  }),
  makeSection({
    content: 'WARNING: High pressure system. Do not open without safety gear.',
    section_type: 'warning',
    type: 'paragraph',
  }),
  makeSection({
    content: 'Continue with the next procedure after the warning. Ensure all safety checks have been completed before proceeding to the next operational phase of the maintenance schedule.',
    section_type: 'paragraph',
  }),
  makeSection({
    content: 'This section is excluded boilerplate for audit only.',
    section_type: 'boilerplate',
    is_boilerplate: true,
    retrieval_excluded: true,
    boilerplate_hash: 'abc123',
  }),
  makeSection({
    content: 'This is downranked content that should still be chunked normally by the prose chunker. It contains enough words to exceed the thirty token minimum threshold for the post-compose guardrail.',
    section_type: 'paragraph',
    retrieval_downranked: true,
  }),
];

// ---------------------------------------------------------------------------
// Run tests
// ---------------------------------------------------------------------------

console.log('=== Type-aware prose chunker tests ===\n');

const chunks = chunkProse(sections, 'Test Document');

console.log(`Produced ${chunks.length} chunks\n`);
for (const c of chunks) {
  console.log(`  [${c.chunk_index}] type=${c.section_type} excl=${c.retrieval_excluded} embed=${c.embedding_status} tokens=${c.token_count} preview="${c.content_preview.slice(0, 60)}..."`);
}
console.log();

// 1. Procedure step should NOT be merged with the paragraphs before it
const procChunk = chunks.find((c) => c.content.includes('Step 1: Open the valve'));
assert(!!procChunk, 'Procedure step exists as a chunk');
if (procChunk) {
  assert(
    !procChunk.content.includes('Second small paragraph'),
    'Procedure step is NOT merged with preceding paragraph',
  );
  assert(
    procChunk.section_type === 'procedure_step',
    'Procedure step chunk has correct section_type',
  );
}

// 2. Warning should be its own distinct chunk
const warnChunk = chunks.find((c) => c.content.includes('WARNING: High pressure'));
assert(!!warnChunk, 'Warning exists as a chunk');
if (warnChunk) {
  assert(
    !warnChunk.content.includes('Step 1'),
    'Warning is NOT merged with procedure step',
  );
  assert(
    !warnChunk.content.includes('Continue with the next'),
    'Warning is NOT merged with following paragraph',
  );
  assert(warnChunk.section_type === 'warning', 'Warning chunk has correct section_type');
}

// 3. Excluded section should be chunked but marked
const exclChunk = chunks.find((c) => c.content.includes('excluded boilerplate'));
assert(!!exclChunk, 'Excluded section produces a chunk');
if (exclChunk) {
  assert(exclChunk.retrieval_excluded === true, 'Excluded chunk has retrieval_excluded=true');
  assert(exclChunk.embedding_status === 'skipped_excluded', 'Excluded chunk has embedding_status=skipped_excluded');
  assert(exclChunk.is_boilerplate === true, 'Excluded chunk has is_boilerplate=true');
}

// 4. Downranked section
const downChunk = chunks.find((c) => c.content.includes('downranked content'));
assert(!!downChunk, 'Downranked section produces a chunk');
if (downChunk) {
  assert(downChunk.retrieval_downranked === true, 'Downranked chunk has retrieval_downranked=true');
  assert(downChunk.embedding_status === 'pending', 'Downranked chunk has embedding_status=pending');
}

// 5. Merged paragraphs should have metadata.section_types
const mergedChunk = chunks.find(
  (c) => c.content.includes('first paragraph') && c.content.includes('Second small paragraph'),
);
if (mergedChunk) {
  assert(
    Array.isArray(mergedChunk.metadata.section_types),
    'Merged chunk has section_types array in metadata',
  );
  assert(
    (mergedChunk.metadata.section_types as string[]).length >= 2,
    'Merged chunk section_types has multiple entries',
  );
}

// ---------------------------------------------------------------------------
// Test minimum size guardrail
// ---------------------------------------------------------------------------

console.log('\n=== Minimum size guardrail tests ===\n');

const tinyParagraph = makeSection({
  content: 'Hi',
  section_type: 'paragraph',
});
const tinyWarning = makeSection({
  content: 'CAUTION',
  section_type: 'warning',
  type: 'paragraph',
});
const tinyExcluded = makeSection({
  content: 'X',
  section_type: 'boilerplate',
  retrieval_excluded: true,
});
const tinyStructural = makeSection({
  content: '13.2.1 MICROBIOLOGY TEST CODES',
  section_type: 'paragraph',
});

const tinyChunks = chunkProse(
  [tinyParagraph, tinyWarning, tinyExcluded, tinyStructural],
  'Tiny Doc',
);

const tinyParaChunk = tinyChunks.find((c) => c.content === 'Hi');
assert(!tinyParaChunk, 'Tiny paragraph (under 30 tokens) is dropped');

const tinyWarnChunk = tinyChunks.find((c) => c.content === 'CAUTION');
assert(!!tinyWarnChunk, 'Tiny warning is NOT dropped (exempt type)');

const tinyExclChunk = tinyChunks.find((c) => c.content === 'X');
assert(!!tinyExclChunk, 'Tiny excluded chunk is NOT dropped (audit trail)');

const tinyStructuralChunk = tinyChunks.find((c) => c.content === '13.2.1 MICROBIOLOGY TEST CODES');
assert(!!tinyStructuralChunk, 'Tiny structural heading-like chunk is NOT dropped');

// ---------------------------------------------------------------------------
// Test maximum size guardrail
// ---------------------------------------------------------------------------

console.log('\n=== Maximum size guardrail tests ===\n');

// Generate a section with > 1000 tokens
const bigContent = Array.from({ length: 200 }, (_, i) =>
  `Sentence number ${i + 1} contains enough words to count as multiple tokens in the encoding. `
).join('');
const bigSection = makeSection({
  content: bigContent,
  section_type: 'paragraph',
});

const bigChunks = chunkProse([bigSection], 'Big Doc');
const overLimit = bigChunks.filter((c) => c.token_count > 1000);
assert(overLimit.length === 0, 'No chunks exceed 1,000 tokens after guardrail');
assert(bigChunks.length >= 2, `Large section was split into ${bigChunks.length} chunks`);

// ---------------------------------------------------------------------------
// Test backward compatibility (ExtractedSection without v2 fields)
// ---------------------------------------------------------------------------

console.log('\n=== Backward compatibility tests ===\n');

const legacySections = [
  { title: null, content: 'Legacy paragraph content here with enough words to exceed the minimum thirty token threshold for the post-compose guardrail filter that removes tiny chunks.', type: 'paragraph' as const },
  { title: null, content: 'Another legacy section with sufficient content length to ensure it will not be dropped by the minimum token guardrail check in post-compose processing.', type: 'paragraph' as const },
];

// Should not throw
const legacyChunks = chunkProse(legacySections as any, 'Legacy Doc');
assert(legacyChunks.length > 0, 'Legacy ExtractedSection[] input produces chunks');
if (legacyChunks.length > 0) {
  assert(legacyChunks[0].embedding_status === 'pending', 'Legacy chunks default to embedding_status=pending');
}

// ---------------------------------------------------------------------------
// Test row-like heading leakage prevention
// ---------------------------------------------------------------------------

console.log('\n=== Row-like heading leakage tests ===\n');

const rowLeakSections: NormalisedSection[] = [
  makeSection({
    title: '4.1 RESULT LISTING',
    type: 'heading',
    section_type: 'heading',
    content: '4.1 RESULT LISTING',
  }),
  makeSection({
    // Table-row-like string that should NOT be promoted as a structural heading
    title: '01 C WM 123 00001 1 01/01/23 10:30:59 10.0 43612 02011 00',
    type: 'heading',
    section_type: 'heading',
    content: '01 C WM 123 00001 1 01/01/23 10:30:59 10.0 43612 02011 00',
  }),
  makeSection({
    content: 'Result listing details follow for routine operations and reporting.',
    section_type: 'paragraph',
  }),
];

const rowLeakChunks = chunkProse(rowLeakSections, 'Row Leak Doc');
const detailChunk = rowLeakChunks.find((c) => c.content.includes('Result listing details follow'));
assert(!!detailChunk, 'Detail chunk exists after row-like heading candidate');
assert(
  detailChunk?.section_title === '4.1 RESULT LISTING',
  'Row-like heading is rejected and previous structural heading is retained',
);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) {
  process.exit(1);
}
