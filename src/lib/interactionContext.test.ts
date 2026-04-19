import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeepInteractionHintTerms,
  buildFollowUpRetrievalQuestion,
  isDeepInteractionFollowUp,
  isVagueInteractionFollowUp,
  parseInteractionContextFromText,
  serializeInteractionContext,
  extractLatestInteractionContext,
  type InteractionContext,
} from './interactionContext';

const HISTORY_WITH_CONTEXT = [
  { role: 'user' as const, content: 'How does MADCAP interact with the sorter?' },
  {
    role: 'assistant' as const,
    content:
      'Interaction summary. <!-- INTERACTION_CONTEXT:{"systemA":"MADCAP","systemB":"Sorter","lastIntent":"interaction_explanation","retrievedDocIds":["doc-1"],"hintTerms":["automatic result entry","fallback"]} -->',
  },
];

test('interaction context marker serializes and parses', () => {
  const context: InteractionContext = {
    systemA: 'MADCAP',
    systemB: 'Sorter',
    lastIntent: 'interaction_explanation',
    retrievedDocIds: ['doc-1', 'doc-2'],
    hintTerms: ['automatic result entry', 'fallback'],
  };

  const text = `Answer body${serializeInteractionContext(context)}`;
  const parsed = parseInteractionContextFromText(text);

  assert.ok(parsed);
  assert.equal(parsed?.systemA, 'MADCAP');
  assert.equal(parsed?.systemB, 'Sorter');
  assert.deepEqual(parsed?.retrievedDocIds, ['doc-1', 'doc-2']);
  assert.deepEqual(parsed?.hintTerms, ['automatic result entry', 'fallback']);
});

test('extractLatestInteractionContext finds marker in assistant history', () => {
  const context = extractLatestInteractionContext(HISTORY_WITH_CONTEXT);
  assert.ok(context);
  assert.equal(context?.systemA, 'MADCAP');
  assert.equal(context?.systemB, 'Sorter');
});

test('extractLatestInteractionContext skips malformed latest assistant markers', () => {
  const history = [
    ...HISTORY_WITH_CONTEXT,
    {
      role: 'assistant' as const,
      content: 'Bad marker <!-- INTERACTION_CONTEXT:not-json -->',
    },
  ];

  const context = extractLatestInteractionContext(history);
  assert.ok(context);
  assert.equal(context?.systemA, 'MADCAP');
  assert.equal(context?.systemB, 'Sorter');
});

test('classifies vague and deep interaction follow-up phrases', () => {
  assert.equal(isVagueInteractionFollowUp('More detail'), true);
  assert.equal(isDeepInteractionFollowUp('What happens if it fails?'), true);
  assert.equal(isDeepInteractionFollowUp('Where is the logic?'), true);
  assert.equal(isVagueInteractionFollowUp('What is MADCAP?'), false);
});

test('builds follow-up retrieval question with inherited interaction context and hints', () => {
  const context = extractLatestInteractionContext(HISTORY_WITH_CONTEXT);
  assert.ok(context);

  const hintTerms = buildDeepInteractionHintTerms('What happens if it fails?', context);
  const retrievalQuery = buildFollowUpRetrievalQuestion('What happens if it fails?', context, hintTerms);

  assert.match(retrievalQuery, /MADCAP/i);
  assert.match(retrievalQuery, /Sorter/i);
  assert.match(retrievalQuery, /fallback/i);
  assert.match(retrievalQuery, /failure/i);
});
