import type { DocumentRow } from './types';

export type QualityTier = 'good' | 'partial' | 'poor' | null;

export interface QualityExplainabilityDoc {
  id: string;
  is_active: boolean;
  source_type: string;
  extraction_method?: string | null;
  text_quality_tier?: QualityTier;
  text_quality_score?: number | null;
  needs_review?: boolean;
  ocr_used?: boolean;
  source_missing?: boolean;
  quarantined?: boolean;
  chunk_count?: number;
  excluded_chunk_count?: number;
  heading_chunk_count?: number;
  table_chunk_count?: number;
  appendix_chunk_count?: number;
  list_chunk_count?: number;
}

export interface QualityReasonSummary {
  partial_docs: number;
  good_docs: number;
  unclassified_docs: number;
  partial_docs_with_reasons: number;
  unclassified_docs_with_reasons: number;
  partial_reason_counts: Record<string, number>;
  good_reason_counts: Record<string, number>;
  unclassified_reason_counts: Record<string, number>;
}

const REASON_ORDER = [
  'Weak headings',
  'OCR used',
  'High excluded chunk ratio',
  'Fallback extraction',
  'Sparse text',
  'Low chunk density',
  'Table-heavy',
  'Low structure confidence',
  'Appendix-heavy / list-heavy',
  'Needs review',
  'Unclassified inputs',
  'Quarantined',
  'Source missing',
] as const;

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function pushUnique(items: string[], value: string): void {
  if (!items.includes(value)) {
    items.push(value);
  }
}

function normalizeTier(doc: Pick<QualityExplainabilityDoc, 'text_quality_tier'>): QualityTier {
  return doc.text_quality_tier ?? null;
}

export function deriveQualityReasons(doc: QualityExplainabilityDoc): string[] {
  const reasons: string[] = [];
  const tier = normalizeTier(doc);

  const chunkCount = Math.max(0, doc.chunk_count ?? 0);
  const excludedChunkCount = Math.max(0, doc.excluded_chunk_count ?? 0);
  const headingChunkCount = Math.max(0, doc.heading_chunk_count ?? 0);
  const tableChunkCount = Math.max(0, doc.table_chunk_count ?? 0);
  const appendixChunkCount = Math.max(0, doc.appendix_chunk_count ?? 0);
  const listChunkCount = Math.max(0, doc.list_chunk_count ?? 0);

  const excludedRatio = ratio(excludedChunkCount, chunkCount);
  const tableRatio = ratio(tableChunkCount, chunkCount);
  const appendixListRatio = ratio(appendixChunkCount + listChunkCount, chunkCount);

  if (doc.ocr_used === true) {
    pushUnique(reasons, 'OCR used');
  }

  if (doc.extraction_method === 'ocr' || doc.extraction_method === 'native_pdfjs') {
    pushUnique(reasons, 'Fallback extraction');
  }

  if (doc.needs_review === true) {
    pushUnique(reasons, 'Needs review');
  }

  if (doc.quarantined === true) {
    pushUnique(reasons, 'Quarantined');
  }

  if (doc.source_missing === true) {
    pushUnique(reasons, 'Source missing');
  }

  if (excludedRatio >= 0.25) {
    pushUnique(reasons, 'High excluded chunk ratio');
  }

  if (chunkCount > 0 && chunkCount <= 3) {
    pushUnique(reasons, 'Sparse text');
  }

  if (doc.source_type !== 'xlsx' && chunkCount > 0 && chunkCount <= 8) {
    pushUnique(reasons, 'Low chunk density');
  }

  if (
    doc.source_type === 'xlsx'
    || (chunkCount > 0 && tableRatio >= 0.5)
  ) {
    pushUnique(reasons, 'Table-heavy');
  }

  if (
    (doc.source_type === 'pdf' || doc.source_type === 'docx' || doc.source_type === 'txt')
    && chunkCount > 0
    && headingChunkCount === 0
  ) {
    pushUnique(reasons, 'Weak headings');
  }

  if (chunkCount > 0 && appendixListRatio >= 0.45) {
    pushUnique(reasons, 'Appendix-heavy / list-heavy');
  }

  if (typeof doc.text_quality_score === 'number' && doc.text_quality_score < 0.75) {
    pushUnique(reasons, 'Low structure confidence');
  }

  if (tier === null) {
    pushUnique(reasons, 'Unclassified inputs');
  }

  // Ensure explainability for partial docs even when signals are weak.
  if (tier === 'partial' && reasons.length === 0) {
    pushUnique(reasons, 'Low structure confidence');
  }

  reasons.sort((a, b) => {
    const aIdx = REASON_ORDER.indexOf(a as (typeof REASON_ORDER)[number]);
    const bIdx = REASON_ORDER.indexOf(b as (typeof REASON_ORDER)[number]);
    if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
    if (aIdx === -1) return 1;
    if (bIdx === -1) return -1;
    return aIdx - bIdx;
  });

  return reasons;
}

function incrementCounts(target: Record<string, number>, reasons: string[]): void {
  for (const reason of reasons) {
    target[reason] = (target[reason] ?? 0) + 1;
  }
}

export function summarizeQualityReasons(docs: QualityExplainabilityDoc[]): QualityReasonSummary {
  const activeDocs = docs.filter((doc) => doc.is_active);

  const partialDocs = activeDocs.filter((doc) => normalizeTier(doc) === 'partial');
  const goodDocs = activeDocs.filter((doc) => normalizeTier(doc) === 'good');
  const unclassifiedDocs = activeDocs.filter((doc) => normalizeTier(doc) === null);

  const partialReasonCounts: Record<string, number> = {};
  const goodReasonCounts: Record<string, number> = {};
  const unclassifiedReasonCounts: Record<string, number> = {};

  let partialDocsWithReasons = 0;
  let unclassifiedDocsWithReasons = 0;

  for (const doc of partialDocs) {
    const reasons = deriveQualityReasons(doc);
    if (reasons.length > 0) {
      partialDocsWithReasons += 1;
    }
    incrementCounts(partialReasonCounts, reasons);
  }

  for (const doc of goodDocs) {
    const reasons = deriveQualityReasons(doc);
    incrementCounts(goodReasonCounts, reasons);
  }

  for (const doc of unclassifiedDocs) {
    const reasons = deriveQualityReasons(doc);
    if (reasons.length > 0) {
      unclassifiedDocsWithReasons += 1;
    }
    incrementCounts(unclassifiedReasonCounts, reasons);
  }

  return {
    partial_docs: partialDocs.length,
    good_docs: goodDocs.length,
    unclassified_docs: unclassifiedDocs.length,
    partial_docs_with_reasons: partialDocsWithReasons,
    unclassified_docs_with_reasons: unclassifiedDocsWithReasons,
    partial_reason_counts: partialReasonCounts,
    good_reason_counts: goodReasonCounts,
    unclassified_reason_counts: unclassifiedReasonCounts,
  };
}

export function attachQualityExplainability<T extends DocumentRow>(doc: T): T & {
  quality_tier: QualityTier;
  quality_reasons: string[];
} {
  const qualityTier = doc.text_quality_tier ?? null;
  const qualityReasons = doc.is_active ? deriveQualityReasons(doc) : [];

  return {
    ...doc,
    quality_tier: qualityTier,
    quality_reasons: qualityReasons,
  };
}
