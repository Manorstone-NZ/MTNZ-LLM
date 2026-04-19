import test from 'node:test';
import assert from 'node:assert/strict';

import {
  expandQueryForStructuralLookup,
  isListPriorityQuery,
  isCanonicalPriorityQuery,
  isRulesPriorityQuery,
  hasSectionOrListEvidence,
} from './retrieval';
import type { ScoredChunk } from './types';

test('expands appendix-style lookup queries with structural hints', () => {
  const q = 'Show the full list from appendix 13.2.1';
  const expanded = expandQueryForStructuralLookup(q);

  assert.notEqual(expanded, q);
  assert.ok(expanded.toLowerCase().includes('appendix 13.2.1'));
  assert.ok(expanded.toLowerCase().includes('test code'));
  assert.ok(expanded.toLowerCase().includes('microbiology'));
});

test('does not expand unrelated free-form queries', () => {
  const q = 'What is the CEO birthday?';
  assert.equal(expandQueryForStructuralLookup(q), q);
});

test('detects list-priority query signals', () => {
  assert.equal(isListPriorityQuery('Show the full list from appendix 13.2.1'), true);
  assert.equal(isListPriorityQuery('What test codes are in appendix 13.2?'), true);
  assert.equal(isListPriorityQuery('Explain result release process'), false);
});

test('detects rules-priority query signals', () => {
  assert.equal(
    isRulesPriorityQuery('Summarise the MADCAP validation conditions and release rules'),
    true,
  );
  assert.equal(isRulesPriorityQuery('Show all test types'), false);
});

test('detects canonical-priority query signals', () => {
  assert.equal(
    isCanonicalPriorityQuery('Which source is the canonical test type list reference?'),
    true,
  );
  assert.equal(isCanonicalPriorityQuery('Explain release workflow steps'), false);
});

test('detects section/list evidence in candidate chunks', () => {
  const candidates: ScoredChunk[] = [
    {
      id: '1',
      document_id: 'd1',
      source_type: 'pdf',
      content: 'APC/SPC 3\nColiform 4',
      content_preview: 'APC/SPC 3 Coliform 4',
      citation_label: 'LOP-RR 001, 13.2.1 MICROBIOLOGY TEST CODES',
      section_title: '13.2.1 MICROBIOLOGY TEST CODES',
      sheet_name: null,
      page_number: 10,
      doc_title: 'LOP-RR 001',
      folder: 'LOP',
      score: 0.7,
    },
  ];

  assert.equal(hasSectionOrListEvidence(candidates, ['13.2.1']), true);
  assert.equal(hasSectionOrListEvidence(candidates, ['99.9.9']), true); // list-like data still counts
  assert.equal(hasSectionOrListEvidence([], ['13.2.1']), false);
});