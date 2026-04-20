/**
 * Normalisation orchestrator — runs classify → suppress → cleanup pipeline.
 * Task 7: V2 Data Quality Rebuild.
 */
import { get_encoding } from 'tiktoken';
import type { ExtractedSection, NormalisedSection } from '../types';
import { classifySections } from './classify';
import { suppressBoilerplate } from './boilerplate';
import {
  mergeAdjacentTinySections,
  dropEmptyHeadings,
  deduplicateWithinDocument,
  applyShortContentPolicy,
  recoverValueableBrokenStructureFragments,
} from './cleanup';

const enc = get_encoding('cl100k_base');

function countTokens(text: string): number {
  return enc.encode(text).length;
}

export interface NormaliseStats {
  total_input: number;
  total_output: number;
  excluded: number;
  downranked: number;
  boilerplate: number;
  merged: number;
  deduplicated: number;
  dropped_short: number;
}

export interface NormaliseResult {
  sections: NormalisedSection[];
  stats: NormaliseStats;
  sanity_warning: boolean;
}

export async function normalise(
  sections: ExtractedSection[],
  documentTitle: string,
  mode: 'rebuild' | 'incremental',
): Promise<NormaliseResult> {
  // Step 1: classify
  const classified = classifySections(sections, documentTitle);

  // Step 2: suppress boilerplate
  const suppressed = await suppressBoilerplate(classified, mode);

  // Step 3: merge adjacent tiny sections (track count diff)
  const preMergeCount = suppressed.length;
  const merged = mergeAdjacentTinySections(suppressed);
  const postMergeCount = merged.length;

  // Step 4: drop empty headings
  const cleaned = dropEmptyHeadings(merged);

  // Step 5: deduplicate within document
  const deduped = deduplicateWithinDocument(cleaned);

  // Step 6: apply short content policy
  const final = applyShortContentPolicy(deduped);

  // Step 7: recover valuable broken_structure fragments (Pass 2 tuning)
  const recovered = recoverValueableBrokenStructureFragments(final);

  // --- Stats computation ---
  const stats: NormaliseStats = {
    total_input: sections.length,
    total_output: recovered.length,
    excluded: recovered.filter(s => s.retrieval_excluded === true).length,
    downranked: recovered.filter(s => s.retrieval_downranked === true).length,
    boilerplate: recovered.filter(s => s.is_boilerplate === true).length,
    merged: preMergeCount - postMergeCount,
    deduplicated: recovered.filter(s => {
      const reason = s.normalisation_reason as Record<string, unknown> | null;
      return reason?.reason === 'duplicate_within_document';
    }).length,
    dropped_short: recovered.filter(s => {
      const reason = s.normalisation_reason as Record<string, unknown> | null;
      return reason?.reason === 'short_content_isolated';
    }).length,
  };

  // --- Sanity check ---
  let sanity_warning = false;

  // >80% excluded
  if (stats.total_output > 0 && stats.excluded / stats.total_output > 0.8) {
    sanity_warning = true;
  }

  // Fewer than 3 non-excluded sections
  const nonExcluded = recovered.filter(s => s.retrieval_excluded === false);
  if (nonExcluded.length < 3) {
    sanity_warning = true;
  }

  // Average token count of non-excluded sections < 15
  if (nonExcluded.length > 0) {
    const totalTokens = nonExcluded.reduce((sum, s) => sum + countTokens(s.content), 0);
    const avgTokens = totalTokens / nonExcluded.length;
    if (avgTokens < 15) {
      sanity_warning = true;
    }
  }

  return { sections: recovered, stats, sanity_warning };
}
