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

test('classifies cross-system billing flow as interaction_explanation', () => {
  const out = classifyQueryIntent('How does MADCAP interact with SAP B1 for billing?');
  assert.equal(out.intent, 'interaction_explanation');
});

test('classifies decision-logic-between query as interaction_explanation', () => {
  const out = classifyQueryIntent('Where is the decision logic between selection and sorting?');
  assert.equal(out.intent, 'interaction_explanation');
});

test('classifies pattern integration query as interaction_explanation', () => {
  const out = classifyQueryIntent('Which integrations use a web service or API mechanism?');
  assert.equal(out.intent, 'interaction_explanation');
});

test('classifies failure-path interaction query as interaction_explanation', () => {
  const out = classifyQueryIntent('What happens if the integration between MADCAP and WSO2 fails?');
  assert.equal(out.intent, 'interaction_explanation');
});

test('classifies operational-boundary query as interaction_explanation', () => {
  const out = classifyQueryIntent(
    'What operational boundary exists between laboratory instruments and downstream business systems?'
  );
  assert.equal(out.intent, 'interaction_explanation');
});

test('classifies reporting export preparation query as interaction_explanation', () => {
  const out = classifyQueryIntent('How are result exports prepared for downstream reporting consumers?');
  assert.equal(out.intent, 'interaction_explanation');
});

test('classifies downstream billing query as interaction_explanation', () => {
  const out = classifyQueryIntent('Which systems provide data needed for downstream billing after result release?');
  assert.equal(out.intent, 'interaction_explanation');
});

test('classifies analytics data-flow query as interaction_explanation', () => {
  const out = classifyQueryIntent('What is the data flow from operational LIMS steps into analytics platforms?');
  assert.equal(out.intent, 'interaction_explanation');
});

test('classifies automatic result entry query as interaction_explanation', () => {
  const out = classifyQueryIntent('How does automatic result entry work between the instrument and MADCAP?');
  assert.equal(out.intent, 'interaction_explanation');
});

test('classifies report propagation query as interaction_explanation', () => {
  const out = classifyQueryIntent('How do results end up in reports?');
  assert.equal(out.intent, 'interaction_explanation');
});

test('classifies fallback manual path query as interaction_explanation', () => {
  const out = classifyQueryIntent('What is the fallback manual path?');
  assert.equal(out.intent, 'interaction_explanation');
});
