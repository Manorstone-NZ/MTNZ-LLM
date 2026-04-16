/**
 * Synthetic test for structural cleanup functions (Task 6).
 * Run: npx tsx src/lib/normalise/cleanup.test.ts
 */
import type { NormalisedSection } from '../types';
import {
  mergeAdjacentTinySections,
  dropEmptyHeadings,
  deduplicateWithinDocument,
  applyShortContentPolicy,
} from './cleanup';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const testSections: NormalisedSection[] = [
  // Heading
  {
    title: 'INTRODUCTION', content: 'Introduction', type: 'heading',
    section_type: 'heading', section_type_confidence: 0.95,
    retrieval_excluded: false, retrieval_downranked: false,
    is_boilerplate: false, boilerplate_hash: null, normalisation_reason: null,
  },
  // Two small paragraphs that should merge
  {
    title: null, content: 'Short para one.', type: 'paragraph',
    section_type: 'paragraph', section_type_confidence: 0.5,
    retrieval_excluded: false, retrieval_downranked: false,
    is_boilerplate: false, boilerplate_hash: null, normalisation_reason: null,
  },
  {
    title: null, content: 'Short para two.', type: 'paragraph',
    section_type: 'paragraph', section_type_confidence: 0.5,
    retrieval_excluded: false, retrieval_downranked: false,
    is_boilerplate: false, boilerplate_hash: null, normalisation_reason: null,
  },
  // Warning that should NOT merge
  {
    title: null, content: 'WARNING: Hot surfaces.', type: 'paragraph',
    section_type: 'warning', section_type_confidence: 0.9,
    retrieval_excluded: false, retrieval_downranked: false,
    is_boilerplate: false, boilerplate_hash: null, normalisation_reason: null,
  },
  // Heading with all-excluded children
  {
    title: 'FORMS', content: 'Forms', type: 'heading',
    section_type: 'heading', section_type_confidence: 0.95,
    retrieval_excluded: false, retrieval_downranked: false,
    is_boilerplate: false, boilerplate_hash: null, normalisation_reason: null,
  },
  {
    title: null, content: 'N/A', type: 'paragraph',
    section_type: 'form_stub', section_type_confidence: 0.9,
    retrieval_excluded: true, retrieval_downranked: false,
    is_boilerplate: false, boilerplate_hash: null, normalisation_reason: null,
  },
  // Another heading to scope the duplicates separately from FORMS
  {
    title: 'DETAILS', content: 'Details', type: 'heading',
    section_type: 'heading', section_type_confidence: 0.95,
    retrieval_excluded: false, retrieval_downranked: false,
    is_boilerplate: false, boilerplate_hash: null, normalisation_reason: null,
  },
  // Duplicate paragraphs (>50 tokens each so they won't be merged by step 1)
  {
    title: null, content: 'This exact text appears twice in the document and should be deduplicated by the cleanup pipeline to avoid redundant content appearing in retrieval results for the end user. The structural cleanup phase identifies and marks duplicate sections so that only one copy is indexed for vector search and full-text retrieval, reducing noise and improving result quality across all queries.', type: 'paragraph',
    section_type: 'paragraph', section_type_confidence: 0.5,
    retrieval_excluded: false, retrieval_downranked: false,
    is_boilerplate: false, boilerplate_hash: null, normalisation_reason: null,
  },
  {
    title: null, content: 'This exact text appears twice in the document and should be deduplicated by the cleanup pipeline to avoid redundant content appearing in retrieval results for the end user. The structural cleanup phase identifies and marks duplicate sections so that only one copy is indexed for vector search and full-text retrieval, reducing noise and improving result quality across all queries.', type: 'paragraph',
    section_type: 'paragraph', section_type_confidence: 0.5,
    retrieval_excluded: false, retrieval_downranked: false,
    is_boilerplate: false, boilerplate_hash: null, normalisation_reason: null,
  },
  // Isolated tiny section (should be dropped by short content policy)
  {
    title: null, content: 'OK', type: 'paragraph',
    section_type: 'paragraph', section_type_confidence: 0.5,
    retrieval_excluded: false, retrieval_downranked: false,
    is_boilerplate: false, boilerplate_hash: null, normalisation_reason: null,
  },
];

// ---------------------------------------------------------------------------
// Run pipeline
// ---------------------------------------------------------------------------

let sections = [...testSections];
let pass = 0;
let fail = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  PASS: ${label}`);
    pass++;
  } else {
    console.error(`  FAIL: ${label}`);
    fail++;
  }
}

console.log('\n=== Step 1: mergeAdjacentTinySections ===');
sections = mergeAdjacentTinySections(sections);

// The two short paragraphs should have merged
const merged = sections.find(s => s.content.includes('Short para one.') && s.content.includes('Short para two.'));
assert(!!merged, 'Two short paragraphs merged into one');
assert(merged?.normalisation_reason?.reason === 'adjacent_small_sections', 'Merge reason set correctly');

// Warning should still be separate
const warning = sections.find(s => s.content === 'WARNING: Hot surfaces.');
assert(!!warning, 'Warning NOT merged with paragraphs');
assert(warning?.section_type === 'warning', 'Warning retains its section_type');

console.log('\n=== Step 2: dropEmptyHeadings ===');
sections = dropEmptyHeadings(sections);

const formsHeading = sections.find(s => s.title === 'FORMS');
assert(!formsHeading, 'FORMS heading dropped (all children excluded)');

const introHeading = sections.find(s => s.title === 'INTRODUCTION');
assert(!!introHeading, 'INTRODUCTION heading kept (has non-excluded children)');

console.log('\n=== Step 3: deduplicateWithinDocument ===');
sections = deduplicateWithinDocument(sections);

const duplicates = sections.filter(s => s.content === 'This exact text appears twice in the document and should be deduplicated by the cleanup pipeline to avoid redundant content appearing in retrieval results for the end user. The structural cleanup phase identifies and marks duplicate sections so that only one copy is indexed for vector search and full-text retrieval, reducing noise and improving result quality across all queries.');
assert(duplicates.length === 2, 'Both duplicate sections still present in array');
assert(duplicates[0].retrieval_excluded === false, 'First occurrence kept');
assert(duplicates[1].retrieval_excluded === true, 'Second occurrence excluded');
assert(
  (duplicates[1].normalisation_reason as any)?.reason === 'duplicate_within_document',
  'Duplicate reason set correctly'
);

console.log('\n=== Step 4: applyShortContentPolicy ===');
sections = applyShortContentPolicy(sections);

const okSection = sections.find(s => s.content === 'OK');
assert(!!okSection, '"OK" section still in array');
assert(okSection?.retrieval_excluded === true, '"OK" section excluded (isolated, short, paragraph)');
assert(
  (okSection?.normalisation_reason as any)?.reason === 'short_content_isolated',
  'Short content reason set correctly'
);

// Warning should NOT be excluded by short content policy
const warningAfter = sections.find(s => s.content === 'WARNING: Hot surfaces.');
assert(warningAfter?.retrieval_excluded === false, 'Warning NOT excluded by short content policy');

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===\n`);

if (fail > 0) {
  console.log('Final sections for debugging:');
  sections.forEach((s, i) => {
    console.log(`  [${i}] type=${s.section_type} excluded=${s.retrieval_excluded} content="${s.content.slice(0, 60)}..." reason=${JSON.stringify(s.normalisation_reason)}`);
  });
}

process.exit(fail > 0 ? 1 : 0);
