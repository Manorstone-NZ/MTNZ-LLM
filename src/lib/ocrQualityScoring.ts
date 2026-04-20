import type { DocumentRow } from './types';

// ─── Thresholds (easily adjustable) ───
export const THRESHOLDS = {
  ocr_clean_max_excluded: 0.15,    // < 15% excluded
  ocr_mixed_max_excluded: 0.30,    // 15–30% excluded
  ocr_noisy_max_excluded: 0.50,    // 30–50% excluded
  // >= 50% or quarantined → ocr_unusable
} as const;

export type OCRQualityStatus = 'native_clean' | 'ocr_clean' | 'ocr_mixed' | 'ocr_noisy' | 'ocr_unusable';
export type OCRActionPriority = 'none' | 'monitor' | 'candidate' | 'high_value_reprocess';
export type DocumentPriority = 'high' | 'medium' | 'low';

export interface OCRQualityScore {
  ocr_quality_status: OCRQualityStatus;
  ocr_quality_reasons: string[];
}

export interface DocumentPrioritization {
  document_priority: DocumentPriority;
  reprocess_candidate: boolean;
  reprocess_reason: string;
  reprocess_rank: number | null;
}

export interface OCRQualityAssessment extends OCRQualityScore, DocumentPrioritization {}

/**
 * Calculate excluded chunk ratio from available signals
 */
function getExcludedRatio(doc: DocumentRow): number {
  if (!doc.chunk_count || doc.chunk_count === 0) return 0;
  const excludedCount = doc.excluded_chunk_count ?? 0;
  return excludedCount / doc.chunk_count;
}

/**
 * Derive OCR quality status from simple rule set:
 * - extraction_method
 * - ocr_used / fallback_used
 * - excluded_chunk_ratio
 * - needs_review
 * - quality_tier
 * - weak heading signals if available
 */
export function scoreOCRQuality(doc: DocumentRow): OCRQualityScore {
  const excludedRatio = getExcludedRatio(doc);
  const reasons: string[] = [];
  let status: OCRQualityStatus;

  // Rule 1: Quarantined = unusable
  if (doc.quarantined) {
    reasons.push('Document quarantined');
    status = 'ocr_unusable';
  }
  // Rule 2: Native extraction (non-OCR)
  else if (!doc.ocr_used && doc.extraction_method?.startsWith('native_')) {
    reasons.push(`${doc.extraction_method.replace('native_', '').toUpperCase()} native`);
    if (excludedRatio < 0.1) {
      status = 'native_clean';
      reasons.push(`Low exclusion (${(excludedRatio * 100).toFixed(0)}%)`);
    } else {
      status = 'ocr_mixed';
      reasons.push(`Some issues (${(excludedRatio * 100).toFixed(0)}% excluded)`);
    }
  }
  // Rule 3: OCR-extracted, apply excluded ratio thresholds
  else if (doc.ocr_used) {
    reasons.push('OCR extracted');
    
    if (excludedRatio >= 0.5) {
      status = 'ocr_unusable';
      reasons.push(`Very high exclusion (${(excludedRatio * 100).toFixed(0)}%)`);
    } else if (excludedRatio >= THRESHOLDS.ocr_noisy_max_excluded) {
      status = 'ocr_noisy';
      reasons.push(`High contamination (${(excludedRatio * 100).toFixed(0)}%)`);
    } else if (excludedRatio >= THRESHOLDS.ocr_mixed_max_excluded) {
      status = 'ocr_mixed';
      reasons.push(`Moderate contamination (${(excludedRatio * 100).toFixed(0)}%)`);
    } else {
      status = 'ocr_clean';
      reasons.push(`Low exclusion (${(excludedRatio * 100).toFixed(0)}%)`);
    }
    
    // Add weak signal flags if available
    if (!doc.heading_chunk_count || doc.heading_chunk_count === 0) {
      reasons.push('No structural headings');
    }
    if (doc.needs_review) {
      reasons.push('Flagged for review');
    }
  }
  // Rule 4: Unknown extraction method, fall back to quality tier
  else {
    if (doc.text_quality_tier === 'poor') {
      status = 'ocr_noisy';
      reasons.push('Poor quality tier');
    } else if (doc.text_quality_tier === 'partial') {
      status = 'ocr_mixed';
      reasons.push('Partial quality tier');
    } else {
      status = 'ocr_clean';
      reasons.push('Clean quality tier (default)');
    }
  }

  return {
    ocr_quality_status: status,
    ocr_quality_reasons: reasons,
  };
}

/**
 * Infer document priority using simple heuristics:
 * - LOP/EOP/core manual patterns in title/folder
 * - High-value families
 * - Active docs only
 */
function inferDocumentPriority(doc: DocumentRow): DocumentPriority {
  if (!doc.is_active) return 'low';
  
  const title = (doc.title ?? '').toUpperCase();
  const folder = (doc.folder ?? '').toUpperCase();
  
  // High-value patterns
  const highValuePatterns = [
    /^LOP-[A-Z]+/,              // Core procedures
    /^EOP/,                      // EOP documents
    /MANUAL/,
    /PROCEDURE.*MANUAL/,
    /GUIDELINES/,
  ];
  
  const isHighValue = highValuePatterns.some(p => p.test(title) || p.test(folder));
  
  if (isHighValue) return 'high';
  
  // Medium: partial tier, structured content
  if (doc.text_quality_tier === 'partial' || (doc.heading_chunk_count ?? 0) > 0) {
    return 'medium';
  }
  
  return 'low';
}

/**
 * Build explainable reasons for reprocess candidate decision
 */
function buildReprocessReasons(
  status: OCRQualityStatus,
  priority: DocumentPriority,
  doc: DocumentRow
): string[] {
  const reasons: string[] = [];
  
  // Reason 1: Value signal
  if (priority === 'high') {
    reasons.push('High-value document (LOP/EOP/manual)');
  } else if (priority === 'medium') {
    reasons.push('Core operational document');
  }
  
  // Reason 2: Quality signal
  if (status === 'ocr_noisy') {
    reasons.push('Significant OCR contamination');
  } else if (status === 'ocr_mixed') {
    reasons.push('Moderate OCR contamination');
  }
  
  // Reason 3: Excluded ratio signal
  const excludedRatio = getExcludedRatio(doc);
  if (excludedRatio > 0.3) {
    reasons.push(`${(excludedRatio * 100).toFixed(0)}% excluded chunks`);
  }
  
  // Reason 4: Structure signal
  if (!doc.heading_chunk_count || doc.heading_chunk_count === 0) {
    reasons.push('Weak structure');
  }
  
  return reasons;
}

/**
 * Derive re-OCR candidate assessment
 */
export function rankReprocessCandidate(
  doc: DocumentRow,
  ocrQuality: OCRQualityScore
): DocumentPrioritization {
  const priority = inferDocumentPriority(doc);
  const status = ocrQuality.ocr_quality_status;
  const excludedRatio = getExcludedRatio(doc);
  
  // Candidate criteria:
  // - Not native_clean, not ocr_clean, not ocr_unusable
  // - Has meaningful contamination (>15% excluded)
  // - Either high priority OR noisy status
  const isCandidate =
    status !== 'native_clean' &&
    status !== 'ocr_clean' &&
    status !== 'ocr_unusable' &&
    excludedRatio > 0.15 &&
    (priority === 'high' || status === 'ocr_noisy');
  
  const reasons = isCandidate ? buildReprocessReasons(status, priority, doc) : [];
  const reason = reasons.length > 0 ? reasons.join('; ') : '';
  
  return {
    document_priority: priority,
    reprocess_candidate: isCandidate,
    reprocess_reason: reason,
    reprocess_rank: null, // Will be assigned during batch ranking
  };
}

/**
 * Compute full OCR quality assessment for a document
 */
export function assessOCRQuality(doc: DocumentRow): OCRQualityAssessment {
  const quality = scoreOCRQuality(doc);
  const priority = rankReprocessCandidate(doc, quality);
  return { ...quality, ...priority };
}

/**
 * Batch assess multiple documents and rank re-OCR candidates
 */
export function assessOCRQualityBatch(docs: DocumentRow[]): (DocumentRow & OCRQualityAssessment)[] {
  // First pass: compute assessments
  const assessed = docs.map(doc => ({
    ...doc,
    ...assessOCRQuality(doc),
  }));

  // Second pass: rank reprocess candidates
  const candidates = assessed
    .filter(d => d.reprocess_candidate)
    .sort((a, b) => {
      // Sort by: document_priority (high > medium > low) → excluded_ratio DESC
      const docPriorityOrder: Record<DocumentPriority, number> = {
        'high': 0,
        'medium': 1,
        'low': 2,
      };

      const aRatio = getExcludedRatio(a);
      const bRatio = getExcludedRatio(b);

      if (docPriorityOrder[a.document_priority] !== docPriorityOrder[b.document_priority]) {
        return docPriorityOrder[a.document_priority] - docPriorityOrder[b.document_priority];
      }
      // Descending excluded ratio within same priority
      return bRatio - aRatio;
    });

  // Assign ranks
  return assessed.map(doc => {
    if (!doc.reprocess_candidate) {
      return doc;
    }
    const rankIndex = candidates.findIndex(c => c.id === doc.id);
    return {
      ...doc,
      reprocess_rank: rankIndex >= 0 ? rankIndex + 1 : null,
    };
  });
}
