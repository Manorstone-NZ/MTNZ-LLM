import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDocQueries,
  evaluateContinuousStop,
  selectPilotCandidates,
  selectWave2Candidates,
  summarizePilotOutcomes,
  summarizeWave2Outcomes,
  type PilotDocMetrics,
} from './reocrPilot';

function doc(overrides: Partial<PilotDocMetrics>): PilotDocMetrics {
  return {
    id: overrides.id ?? '1',
    title: overrides.title ?? 'EOP Manual',
    source_path: overrides.source_path ?? 'EOP/eop-manual.pdf',
    folder: overrides.folder ?? 'EOP',
    ocr_quality_status: overrides.ocr_quality_status ?? 'ocr_mixed',
    ocr_quality_reasons: overrides.ocr_quality_reasons ?? ['Moderate OCR contamination'],
    document_priority: overrides.document_priority ?? 'high',
    reprocess_candidate: overrides.reprocess_candidate ?? true,
    reprocess_reason: overrides.reprocess_reason ?? 'High-value doc',
    reprocess_rank: overrides.reprocess_rank ?? 10,
    chunk_count: overrides.chunk_count ?? 100,
    excluded_chunk_count: overrides.excluded_chunk_count ?? 30,
    quality_tier: overrides.quality_tier ?? 'partial',
    heading_chunk_count: overrides.heading_chunk_count ?? 0,
  };
}

test('selectPilotCandidates keeps only high-priority mixed/noisy candidates', () => {
  const rows = [
    doc({ id: 'a', reprocess_rank: 3, title: 'EOP A Manual' }),
    doc({ id: 'b', reprocess_candidate: false, reprocess_rank: 1 }),
    doc({ id: 'c', document_priority: 'medium', reprocess_rank: 2 }),
    doc({ id: 'd', ocr_quality_status: 'ocr_clean', reprocess_rank: 4 }),
    doc({ id: 'e', ocr_quality_status: 'ocr_noisy', reprocess_rank: 5, title: 'LOP B Manual' }),
  ];

  const selected = selectPilotCandidates(rows, 5);

  assert.equal(selected.length, 2);
  assert.deepEqual(selected.map((r) => r.id), ['a', 'e']);
});

test('selectPilotCandidates caps output to requested size', () => {
  const rows = Array.from({ length: 12 }).map((_, i) =>
    doc({ id: `${i}`, reprocess_rank: i + 1, title: `EOP ${i} Manual` }),
  );

  const selected = selectPilotCandidates(rows, 8);
  assert.equal(selected.length, 8);
  assert.equal(selected[0].reprocess_rank, 1);
  assert.equal(selected[7].reprocess_rank, 8);
});

test('buildDocQueries returns practical retrieval checks', () => {
  const queries = buildDocQueries('EOP 010 (V1) Infrared Thermometer Manual');
  assert.equal(queries.length, 3);
  assert.match(queries[0], /Infrared Thermometer/i);
});

test('summarizePilotOutcomes computes recommendation from outcomes', () => {
  const summary = summarizePilotOutcomes([
    {
      title: 'Doc 1',
      excluded_ratio_before: 0.35,
      excluded_ratio_after: 0.20,
      status_before: 'ocr_noisy',
      status_after: 'ocr_mixed',
      retrieval_improved: true,
    },
    {
      title: 'Doc 2',
      excluded_ratio_before: 0.28,
      excluded_ratio_after: 0.20,
      status_before: 'ocr_mixed',
      status_after: 'ocr_mixed',
      retrieval_improved: true,
    },
  ]);

  assert.equal(summary.material_improvement_docs, 2);
  assert.ok(summary.average_excluded_ratio_delta < 0);
  assert.equal(summary.decision.worthwhile, true);
});

// ─── Wave 2 tests ─────────────────────────────────────────────────────────────

test('selectWave2Candidates excludes pilot source paths', () => {
  const rows = [
    doc({ id: 'p1', source_path: 'LOP/pilot-doc.pdf', reprocess_rank: 1, title: 'LOP Pilot Manual' }),
    doc({ id: 'w2', source_path: 'LOP/wave2-doc.pdf', reprocess_rank: 2, title: 'LOP Wave2 Manual' }),
    doc({ id: 'w3', source_path: 'EOP/wave2-eop.pdf', reprocess_rank: 3, title: 'EOP Wave2 Manual' }),
  ];

  const excluded = new Set(['LOP/pilot-doc.pdf']);
  const selected = selectWave2Candidates(rows, excluded, 5, 0);

  assert.equal(selected.length, 2);
  assert.ok(selected.every((d) => !excluded.has(d.source_path)));
});

test('selectWave2Candidates includes medium priority docs', () => {
  const rows = [
    doc({ id: 'h', document_priority: 'high', reprocess_rank: 1, title: 'EOP High Manual' }),
    doc({ id: 'm', document_priority: 'medium', reprocess_rank: 2, title: 'LOP Medium Manual' }),
    doc({ id: 'l', document_priority: 'low', reprocess_rank: 3, title: 'LOP Low Manual' }),
  ];

  const selected = selectWave2Candidates(rows, new Set(), 5, 0);

  assert.equal(selected.length, 2); // high and medium, not low
  assert.deepEqual(selected.map((d) => d.id), ['h', 'm']);
});

test('selectWave2Candidates respects waveOffset for 2A vs 2B split', () => {
  const rows = Array.from({ length: 20 }).map((_, i) =>
    doc({ id: `${i}`, reprocess_rank: i + 1, title: `EOP ${i} Manual`, source_path: `EOP/doc${i}.pdf` }),
  );

  const wave2a = selectWave2Candidates(rows, new Set(), 10, 0);
  const wave2bExcludes = new Set(wave2a.map((d) => d.source_path));
  const wave2b = selectWave2Candidates(rows, wave2bExcludes, 10, 0);

  assert.equal(wave2a.length, 10);
  assert.equal(wave2b.length, 10);
  // No overlap
  const overlap = wave2a.filter((d) => wave2b.some((b) => b.id === d.id));
  assert.equal(overlap.length, 0);
  // 2A is ranks 1-10, 2B is ranks 11-20
  assert.equal(wave2a[0].reprocess_rank, 1);
  assert.equal(wave2b[0].reprocess_rank, 11);
});

test('summarizeWave2Outcomes compares vs pilot baseline', () => {
  const summary = summarizeWave2Outcomes({
    wave: '2a',
    deltas: [
      { title: 'A', excluded_ratio_before: 0.35, excluded_ratio_after: 0.15, status_before: 'ocr_mixed', status_after: 'ocr_clean', retrieval_improved: true },
      { title: 'B', excluded_ratio_before: 0.30, excluded_ratio_after: 0.10, status_before: 'ocr_mixed', status_after: 'ocr_clean', retrieval_improved: true },
    ],
    pilotBaseline: {
      average_excluded_ratio_delta: -0.3457,
      material_improvement_docs: 8,
      retrieval_improved_docs: 7,
      pilot_doc_count: 8,
    },
  });

  assert.equal(summary.wave, '2a');
  assert.equal(summary.material_improvement_docs, 2);
  assert.ok(summary.average_excluded_ratio_delta < 0);
  assert.ok(summary.vs_pilot_baseline !== null);
  assert.ok(typeof summary.vs_pilot_baseline!.results_consistent === 'boolean');
});

test('evaluateContinuousStop continues when gains are still strong', () => {
  const decision = evaluateContinuousStop({
    avgExcludedRatioImprovement: 0.24,
    retrievalImprovementRate: 0.8,
    lowPriorityShare: 0.2,
    minRatioImprovement: 0.15,
    minRetrievalImprovementRate: 0.6,
    maxLowPriorityShare: 0.5,
  });

  assert.equal(decision.shouldStop, false);
  assert.equal(decision.reasons.length, 0);
});

test('evaluateContinuousStop stops when ratio gains flatten', () => {
  const decision = evaluateContinuousStop({
    avgExcludedRatioImprovement: 0.1,
    retrievalImprovementRate: 0.8,
    lowPriorityShare: 0.2,
    minRatioImprovement: 0.15,
    minRetrievalImprovementRate: 0.6,
    maxLowPriorityShare: 0.5,
  });

  assert.equal(decision.shouldStop, true);
  assert.ok(decision.reasons.some((reason) => reason.includes('ratio')));
});

test('evaluateContinuousStop stops when retrieval gains flatten', () => {
  const decision = evaluateContinuousStop({
    avgExcludedRatioImprovement: 0.2,
    retrievalImprovementRate: 0.5,
    lowPriorityShare: 0.2,
    minRatioImprovement: 0.15,
    minRetrievalImprovementRate: 0.6,
    maxLowPriorityShare: 0.5,
  });

  assert.equal(decision.shouldStop, true);
  assert.ok(decision.reasons.some((reason) => reason.includes('retrieval')));
});

test('evaluateContinuousStop stops when low-priority share dominates', () => {
  const decision = evaluateContinuousStop({
    avgExcludedRatioImprovement: 0.2,
    retrievalImprovementRate: 0.8,
    lowPriorityShare: 0.75,
    minRatioImprovement: 0.15,
    minRetrievalImprovementRate: 0.6,
    maxLowPriorityShare: 0.5,
  });

  assert.equal(decision.shouldStop, true);
  assert.ok(decision.reasons.some((reason) => reason.includes('low priority')));
});
