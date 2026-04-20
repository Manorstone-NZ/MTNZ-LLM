import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAuthoritativeSectionTitle,
  isAuthoritativeTitle,
  isCanonicalLookupQuery,
  isCatalogueStyleQuery,
  isMappingStyleQuery,
  isRulesStyleQuery,
  isStructuredSourceType,
} from './authoritativeSources';

test('detects structured source types', () => {
  assert.equal(isStructuredSourceType('xlsx'), true);
  assert.equal(isStructuredSourceType('CSV'), true);
  assert.equal(isStructuredSourceType('pdf'), false);
});

test('detects authoritative titles and sections', () => {
  assert.equal(isAuthoritativeTitle('Customer Code Register'), true);
  assert.equal(isAuthoritativeTitle('General Procedure Manual'), false);
  assert.equal(isAuthoritativeSectionTitle('Appendix B: Test Type Mapping'), true);
  assert.equal(isAuthoritativeSectionTitle('Background'), false);
});

test('classifies query classes via reusable heuristics', () => {
  assert.equal(isCatalogueStyleQuery('List all programme mappings by code'), true);
  assert.equal(isCanonicalLookupQuery('Which source is the master lookup table?'), true);
  assert.equal(isRulesStyleQuery('Summarise validation criteria and release rules'), true);
  assert.equal(isCanonicalLookupQuery('Explain how ingestion works'), false);
});

test('does not treat generic hyphenated phrasing as mapping style', () => {
  assert.equal(
    isMappingStyleQuery('How does step-by-step integration between MADCAP and SAP work?'),
    false,
  );
  assert.equal(
    isCanonicalLookupQuery('How does step-by-step integration between MADCAP and SAP work?'),
    false,
  );
});
