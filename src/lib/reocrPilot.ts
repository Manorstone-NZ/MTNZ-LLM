export type OCRStatus = 'native_clean' | 'ocr_clean' | 'ocr_mixed' | 'ocr_noisy' | 'ocr_unusable' | string;

export type PilotDocMetrics = {
  id: string;
  title: string;
  source_path: string;
  folder?: string | null;
  ocr_quality_status?: OCRStatus | null;
  ocr_quality_reasons?: string[] | null;
  document_priority?: 'high' | 'medium' | 'low' | string | null;
  reprocess_candidate?: boolean | null;
  reprocess_reason?: string | null;
  reprocess_rank?: number | null;
  chunk_count?: number | null;
  excluded_chunk_count?: number | null;
  quality_tier?: string | null;
  heading_chunk_count?: number | null;
};

export type PilotDocDelta = {
  title: string;
  excluded_ratio_before: number;
  excluded_ratio_after: number;
  status_before: string;
  status_after: string;
  retrieval_improved: boolean;
};

const CORE_MANUAL_PATTERN = /(lop|eop|manual|operation|sop)/i;

const STATUS_SCORE: Record<string, number> = {
  native_clean: 5,
  ocr_clean: 4,
  ocr_mixed: 3,
  ocr_noisy: 2,
  ocr_unusable: 1,
};

export function excludedRatio(doc: Pick<PilotDocMetrics, 'chunk_count' | 'excluded_chunk_count'>): number {
  const chunkCount = doc.chunk_count ?? 0;
  if (chunkCount <= 0) return 0;
  return (doc.excluded_chunk_count ?? 0) / chunkCount;
}

export function selectPilotCandidates(docs: PilotDocMetrics[], count = 8): PilotDocMetrics[] {
  const target = Math.max(5, Math.min(10, count));

  return docs
    .filter((doc) => doc.reprocess_candidate === true)
    .filter((doc) => doc.document_priority === 'high')
    .filter((doc) => doc.ocr_quality_status === 'ocr_mixed' || doc.ocr_quality_status === 'ocr_noisy')
    .filter((doc) => {
      const haystack = `${doc.title} ${doc.folder ?? ''} ${doc.reprocess_reason ?? ''}`;
      return CORE_MANUAL_PATTERN.test(haystack);
    })
    .sort((a, b) => {
      const rankA = a.reprocess_rank ?? Number.MAX_SAFE_INTEGER;
      const rankB = b.reprocess_rank ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return excludedRatio(b) - excludedRatio(a);
    })
    .slice(0, target);
}

export function buildDocQueries(title: string): string[] {
  const shortTitle = title
    .replace(/\(V\d+\)/gi, '')
    .replace(/\.pdf$/i, '')
    .trim();

  return [
    `What is the end-to-end operating procedure in ${shortTitle}?`,
    `What setup, calibration, or pre-check steps are required in ${shortTitle}?`,
    `What critical quality or safety checks are specified in ${shortTitle}?`,
  ];
}

export function statusImproved(beforeStatus: string, afterStatus: string): boolean {
  const before = STATUS_SCORE[beforeStatus] ?? 0;
  const after = STATUS_SCORE[afterStatus] ?? 0;
  return after > before;
}

/**
 * Select Wave 2 candidates.
 * Differs from pilot selection:
 * - Excludes already-processed source paths (pilot + earlier waves)
 * - Allows medium priority docs (not only high)
 * - Accepts waveOffset/waveCount to split into 2A and 2B
 */
export function selectWave2Candidates(
  docs: PilotDocMetrics[],
  excludedSourcePaths: Set<string>,
  waveCount: number,
  waveOffset = 0,
): PilotDocMetrics[] {
  const count = Math.max(5, Math.min(20, waveCount));

  return docs
    .filter((doc) => doc.reprocess_candidate === true)
    .filter((doc) => doc.ocr_quality_status === 'ocr_mixed' || doc.ocr_quality_status === 'ocr_noisy')
    .filter((doc) => doc.document_priority === 'high' || doc.document_priority === 'medium')
    .filter((doc) => !excludedSourcePaths.has(doc.source_path))
    .sort((a, b) => {
      const rankA = a.reprocess_rank ?? Number.MAX_SAFE_INTEGER;
      const rankB = b.reprocess_rank ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return excludedRatio(b) - excludedRatio(a);
    })
    .slice(waveOffset, waveOffset + count);
}

export type Wave2SummaryInput = {
  wave: '2a' | '2b' | 'combined';
  deltas: PilotDocDelta[];
  pilotBaseline?: {
    average_excluded_ratio_delta: number;
    material_improvement_docs: number;
    retrieval_improved_docs: number;
    pilot_doc_count: number;
  };
};

export type ContinuousStopInput = {
  avgExcludedRatioImprovement: number;
  retrievalImprovementRate: number;
  lowPriorityShare: number;
  minRatioImprovement: number;
  minRetrievalImprovementRate: number;
  maxLowPriorityShare: number;
};

export function evaluateContinuousStop(input: ContinuousStopInput): {
  shouldStop: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];

  if (input.avgExcludedRatioImprovement < input.minRatioImprovement) {
    reasons.push(
      `ratio improvement ${input.avgExcludedRatioImprovement.toFixed(3)} below threshold ${input.minRatioImprovement.toFixed(3)}`,
    );
  }

  if (input.retrievalImprovementRate < input.minRetrievalImprovementRate) {
    reasons.push(
      `retrieval improvement ${input.retrievalImprovementRate.toFixed(3)} below threshold ${input.minRetrievalImprovementRate.toFixed(3)}`,
    );
  }

  if (input.lowPriorityShare > input.maxLowPriorityShare) {
    reasons.push(
      `low priority share ${input.lowPriorityShare.toFixed(3)} above threshold ${input.maxLowPriorityShare.toFixed(3)}`,
    );
  }

  return {
    shouldStop: reasons.length > 0,
    reasons,
  };
}

export function summarizeWave2Outcomes(input: Wave2SummaryInput) {
  const { wave, deltas, pilotBaseline } = input;
  const base = summarizePilotOutcomes(deltas);

  const recommendation = base.decision.worthwhile
    ? 'continue_to_next_wave'
    : base.average_excluded_ratio_delta < -0.02
      ? 'refine_and_retry'
      : 'stop_rollout_gains_flattened';

  const vsBaseline = pilotBaseline
    ? {
        pilot_avg_ratio_delta: pilotBaseline.average_excluded_ratio_delta,
        wave_avg_ratio_delta: base.average_excluded_ratio_delta,
        pilot_improvement_rate: Number((pilotBaseline.material_improvement_docs / pilotBaseline.pilot_doc_count).toFixed(3)),
        wave_improvement_rate: Number((base.material_improvement_docs / Math.max(1, base.pilot_doc_count)).toFixed(3)),
        results_consistent: Math.abs(base.average_excluded_ratio_delta - pilotBaseline.average_excluded_ratio_delta) < 0.1,
      }
    : null;

  return {
    wave,
    wave_doc_count: base.pilot_doc_count,
    material_improvement_docs: base.material_improvement_docs,
    retrieval_improved_docs: base.retrieval_improved_docs,
    average_excluded_ratio_delta: base.average_excluded_ratio_delta,
    average_status_movement: base.average_status_movement,
    vs_pilot_baseline: vsBaseline,
    decision: {
      worthwhile: base.decision.worthwhile,
      recommendation,
    },
  };
}

export function summarizePilotOutcomes(deltas: PilotDocDelta[]) {
  const count = deltas.length;
  const materialImprovementDocs = deltas.filter((d) =>
    (d.excluded_ratio_before - d.excluded_ratio_after) >= 0.05 || statusImproved(d.status_before, d.status_after),
  ).length;

  const retrievalImprovedDocs = deltas.filter((d) => d.retrieval_improved).length;

  const avgExcludedDelta = count === 0
    ? 0
    : deltas.reduce((sum, d) => sum + (d.excluded_ratio_after - d.excluded_ratio_before), 0) / count;

  const avgStatusDelta = count === 0
    ? 0
    : deltas.reduce((sum, d) => {
      const before = STATUS_SCORE[d.status_before] ?? 0;
      const after = STATUS_SCORE[d.status_after] ?? 0;
      return sum + (after - before);
    }, 0) / count;

  const worthwhile = materialImprovementDocs >= Math.max(2, Math.ceil(count * 0.3))
    && retrievalImprovedDocs >= Math.max(2, Math.ceil(count * 0.3));

  const recommendation = worthwhile
    ? 'proceed_to_next_10_20_candidates'
    : avgExcludedDelta < -0.02
      ? 'refine_reocr_method_and_rerun_pilot'
      : 'stop_broader_rollout_gains_too_small';

  return {
    pilot_doc_count: count,
    material_improvement_docs: materialImprovementDocs,
    retrieval_improved_docs: retrievalImprovedDocs,
    average_excluded_ratio_delta: Number(avgExcludedDelta.toFixed(4)),
    average_status_movement: Number(avgStatusDelta.toFixed(4)),
    decision: {
      worthwhile,
      recommendation,
    },
  };
}
