import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSynthesisContext } from './synthesis';
import type { CitedChunk } from './types';

const baseChunk: CitedChunk = {
  chunk_id: 'c1',
  document_id: 'd1',
  source_type: 'pdf',
  citation_label: 'LOP-RR 001, 13.2.1 MICROBIOLOGY TEST CODES',
  doc_title: 'LOP-RR 001',
  folder: 'Manuals',
  page: 1,
  section_title: '13.2.1 MICROBIOLOGY TEST CODES',
  sheet_name: null,
  content_preview: 'APC/SPC 3\nColiform 4\nResult code 88',
};

test('groups chunks by document', () => {
  const context = buildSynthesisContext([
    baseChunk,
    {
      ...baseChunk,
      chunk_id: 'c2',
      citation_label: 'LOP-RR 001, 7.2 RESULT RELEASE',
      section_title: '7.2 RESULT RELEASE',
      content_preview: '1. Verify sample identity\n2. Review analyser output',
    },
  ]);

  assert.equal(context.groupedSources.length, 1);
  assert.equal(context.groupedSources[0].docTitle, 'LOP-RR 001');
  assert.ok(context.groupedSources[0].citationLabels.length >= 2);
});

test('extracts list-like snippets for synthesis', () => {
  const context = buildSynthesisContext([baseChunk]);
  const snippets = context.groupedSources[0].snippets.join(' ');
  assert.match(snippets, /APC\/SPC|Result code/i);
});
