import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyQueryIntent } from './queryIntent';

test('classifies MADCAP list query as synthesis_list', () => {
  const out = classifyQueryIntent('What MADCAP tests are there?');
  assert.equal(out.intent, 'synthesis_list');
});

test('classifies show all test types as synthesis_list', () => {
  const out = classifyQueryIntent('Show all MADCAP test types');
  assert.equal(out.intent, 'synthesis_list');
});

test('classifies section query as structural', () => {
  const out = classifyQueryIntent('What is in section 13.2.1?');
  assert.equal(out.intent, 'structural');
  assert.ok(out.sectionRefs.includes('13.2.1'));
});

test('classifies section list query as synthesis_list', () => {
  const out = classifyQueryIntent('Show the full list from appendix 13.2.1');
  assert.equal(out.intent, 'synthesis_list');
  assert.ok(out.sectionRefs.includes('13.2.1'));
});

test('classifies plain definition query as standard', () => {
  const out = classifyQueryIntent('What is MADCAP?');
  assert.equal(out.intent, 'standard');
});

test('classifies rules synthesis query correctly', () => {
  const out = classifyQueryIntent(
    'What operational rules and validation conditions for MADCAP are described across the corpus?'
  );
  assert.equal(out.intent, 'synthesis_rules');
});

test('classifies canonical lookup query correctly', () => {
  const out = classifyQueryIntent(
    'What is the canonical test type list reference source in this corpus?'
  );
  assert.equal(out.intent, 'canonical_lookup');
});

test('validation set: list/catalogue class routes to synthesis_list', () => {
  const out = classifyQueryIntent('List all result codes and programme mappings used in the manuals.');
  assert.equal(out.intent, 'synthesis_list');
});

test('validation set: appendix/section/table class routes to structural', () => {
  const out = classifyQueryIntent('What does section 8.3 table 2 say about release steps?');
  assert.equal(out.intent, 'structural');
  assert.ok(out.sectionRefs.includes('8.3'));
});

test('validation set: rules/validation class routes to synthesis_rules', () => {
  const out = classifyQueryIntent('Summarise validation criteria, entry conditions, and release rules across procedures.');
  assert.equal(out.intent, 'synthesis_rules');
});
