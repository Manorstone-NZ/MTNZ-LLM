import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRegistryQueryExpansion,
  extractRegistryInteractionPair,
  extractRegistrySystemMentions,
  getRegistrySourceBoost,
} from './entityRegistry';

test('extractRegistrySystemMentions detects canonical systems from aliases', () => {
  const mentions = extractRegistrySystemMentions('How does SAP B1 receive MADCAP release exports?');
  assert.deepEqual(mentions, ['SAP B1', 'MADCAP']);
});

test('extractRegistryInteractionPair returns first two mentioned systems', () => {
  const pair = extractRegistryInteractionPair('Describe TITAN to ODS integration flow');
  assert.deepEqual(pair, { systemA: 'TITAN', systemB: 'ODS' });
});

test('buildRegistryQueryExpansion adds domain and master hints', () => {
  const expanded = buildRegistryQueryExpansion('Need billing export path to SAP');
  assert.match(expanded, /master list/i);
  assert.match(expanded, /billing invoice downstream/i);
});

test('getRegistrySourceBoost boosts canonical reference titles', () => {
  const boost = getRegistrySourceBoost('what is the canonical code list', {
    doc_title: 'MADCAP Test Type List',
    source_type: 'xlsx',
  });
  assert.ok(boost > 1.1);
});
