import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyInteractionTier,
  computeTierScoreBonus,
  pickInteractionResults,
} from './retrieval';
import type { ScoredChunk } from './types';

function makeChunk(overrides: Partial<ScoredChunk> = {}): ScoredChunk {
  return {
    id: overrides.id ?? 'chunk-1',
    document_id: overrides.document_id ?? 'doc-1',
    source_type: overrides.source_type ?? 'pdf',
    content: overrides.content ?? '',
    content_preview: overrides.content_preview ?? overrides.content ?? '',
    citation_label: overrides.citation_label ?? null,
    section_title: overrides.section_title ?? null,
    sheet_name: overrides.sheet_name ?? null,
    page_number: overrides.page_number ?? null,
    doc_title: overrides.doc_title ?? 'Doc',
    folder: overrides.folder ?? null,
    score: overrides.score ?? 1,
    vector_score: overrides.vector_score,
    fts_score: overrides.fts_score,
    trigram_score: overrides.trigram_score,
    retrieval_downranked: overrides.retrieval_downranked,
  };
}

test('classifies both-entity chunks as tier1', () => {
  const chunk = makeChunk({
    section_title: 'Result transfer',
    content: 'MADCAP sends results to sorter via web service.',
  });

  const result = classifyInteractionTier(chunk, chunk.content, 'MADCAP', 'sorter');
  assert.equal(result.tier, 'tier1_both_entities');
  assert.equal(result.hasBothEntities, true);
});

test('classifies integration plus one entity as tier2', () => {
  const chunk = makeChunk({
    section_title: 'Interface setup',
    content: 'MADCAP integration uses API configuration.',
  });

  const result = classifyInteractionTier(chunk, chunk.content, 'MADCAP', 'sorter');
  assert.equal(result.tier, 'tier2_integrated');
  assert.equal(result.hasBothEntities, false);
  assert.equal(result.hasIntegrationSignal, true);
});

test('pushes generic single-entity chunks to tier3', () => {
  const chunk = makeChunk({
    section_title: 'General usage',
    content: 'MADCAP is used by laboratory staff for routine tasks.',
  });

  const result = classifyInteractionTier(chunk, chunk.content, 'MADCAP', 'sorter');
  assert.equal(result.tier, 'tier3_supporting');
});

test('boosts tier1 score over tier2 and tier3', () => {
  const tier1 = computeTierScoreBonus('tier1_both_entities', false, false, 1);
  const tier2 = computeTierScoreBonus('tier2_integrated', false, false, 1);
  const tier3 = computeTierScoreBonus('tier3_supporting', false, false, 1);

  assert.ok(tier1 > tier2);
  assert.ok(tier2 > tier3);
});

test('caps total selected sources and preserves key interaction evidence', () => {
  const ranked: ScoredChunk[] = [];

  ranked.push(
    makeChunk({
      id: 'tier1-1',
      document_id: 'doc-a',
      section_title: 'Integration flow',
      content: 'MADCAP sends results to sorter through middleware and API.',
      score: 10,
    }),
  );

  ranked.push(
    makeChunk({
      id: 'tier2-1',
      document_id: 'doc-b',
      section_title: 'Interface setup',
      content: 'MADCAP API setup and web service configuration details.',
      score: 9,
    }),
  );

  for (let i = 0; i < 30; i += 1) {
    ranked.push(
      makeChunk({
        id: `noise-${i}`,
        document_id: `doc-noise-${Math.floor(i / 5)}`,
        section_title: 'Operational note',
        content: `MADCAP note ${i}`,
        score: 1 - i * 0.01,
      }),
    );
  }

  const result = pickInteractionResults(ranked, 24, 20, 3, 2, 'MADCAP', 'sorter');

  assert.ok(result.selected.length <= 20);
  assert.ok(result.diagnostics.tier1Count >= 1);
  assert.ok(result.diagnostics.tier2Count >= 1);

  const hasBothEntitiesChunk = result.selected.some(
    (chunk) => chunk.content.includes('MADCAP') && chunk.content.toLowerCase().includes('sorter'),
  );
  assert.equal(hasBothEntitiesChunk, true);

  const hasMechanismChunk = result.selected.some((chunk) => {
    const corpus = `${chunk.section_title ?? ''} ${chunk.content}`.toLowerCase();
    return /api|web\s*service|middleware|setup|configuration|flow/.test(corpus);
  });
  assert.equal(hasMechanismChunk, true);
});

test('enforces per-document cap of 3', () => {
  const ranked: ScoredChunk[] = [];
  for (let i = 0; i < 8; i += 1) {
    ranked.push(
      makeChunk({
        id: `doc-a-${i}`,
        document_id: 'doc-a',
        section_title: 'Integration flow',
        content: `MADCAP sends to sorter via API ${i}`,
        score: 10 - i * 0.1,
      }),
    );
  }

  ranked.push(
    makeChunk({
      id: 'doc-b-1',
      document_id: 'doc-b',
      section_title: 'Interface setup',
      content: 'MADCAP integration setup details',
      score: 5,
    }),
  );

  const result = pickInteractionResults(ranked, 20, 20, 3, 2, 'MADCAP', 'sorter');
  const fromDocA = result.selected.filter((chunk) => chunk.document_id === 'doc-a').length;

  assert.ok(fromDocA <= 3);
  assert.ok(result.diagnostics.uniqueDocCount >= 1);
});
