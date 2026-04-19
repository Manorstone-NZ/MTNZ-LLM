import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prepareQuery } from './queryPrep';

test('detects appendix query', () => {
  const r = prepareQuery('appendix 13.2.1');
  assert.equal(r.isStructural, true);
  assert.ok(r.sectionRefs.includes('13.2.1'));
});

test('preserves exact section number', () => {
  const r = prepareQuery('section 13.2.1');
  assert.ok(r.expanded.includes('13.2.1'));
});

test('adds list hints', () => {
  const r = prepareQuery('full list from appendix 13.2');
  assert.match(r.expanded, /list/i);
  assert.match(r.expanded, /table/i);
});

test('non-structural query unchanged', () => {
  const r = prepareQuery('what is MADCAP');
  assert.equal(r.expanded, 'what is MADCAP');
  assert.equal(r.isStructural, false);
});

test('captures document reference token for structural appendix query', () => {
  const r = prepareQuery('List test codes from LOP-RR 001 appendix');
  assert.equal(r.isStructural, true);
  assert.ok(r.documentRefs.includes('LOP-RR 001'));
  assert.match(r.expanded, /LOP-RR 001/);
});
