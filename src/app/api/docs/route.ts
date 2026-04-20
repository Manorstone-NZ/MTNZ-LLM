import { NextRequest } from 'next/server';
import { getDocumentInventory, getHealthMetrics } from '@/lib/repositories/documents';
import { attachQualityExplainability, summarizeQualityReasons } from '@/lib/qualityReasons';
import { assessOCRQualityBatch } from '@/lib/ocrQualityScoring';

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const folder = searchParams.get('folder') ?? undefined;
  const status = searchParams.get('status') ?? undefined;
  const type = searchParams.get('type') ?? undefined;

  try {
    const [documents, health] = await Promise.all([
      getDocumentInventory({ folder, status, type }),
      getHealthMetrics(),
    ]);

    // Apply quality scoring and OCR assessment
    const explainableDocuments = documents.map((doc) => attachQualityExplainability(doc));
    const ocrAssessedDocuments = assessOCRQualityBatch(explainableDocuments);
    const reasonSummary = summarizeQualityReasons(ocrAssessedDocuments);

    // Calculate OCR quality summary metrics
    const ocrSummary = calculateOCRSummary(ocrAssessedDocuments);
    const topReprocessCandidates = ocrAssessedDocuments
      .filter(d => d.reprocess_candidate)
      .sort((a, b) => (a.reprocess_rank ?? Infinity) - (b.reprocess_rank ?? Infinity))
      .slice(0, 5);

    const enrichedHealth = {
      ...health,
      partial_reason_counts: reasonSummary.partial_reason_counts,
      good_reason_counts: reasonSummary.good_reason_counts,
      unclassified_reason_counts: reasonSummary.unclassified_reason_counts,
      ocr_summary: ocrSummary,
      top_reprocess_candidates: topReprocessCandidates,
      diagnostics: {
        ...health.diagnostics,
        quality_reason_diagnostics: {
          partial_docs: reasonSummary.partial_docs,
          unclassified_docs: reasonSummary.unclassified_docs,
          partial_docs_with_reasons: reasonSummary.partial_docs_with_reasons,
          unclassified_docs_with_reasons: reasonSummary.unclassified_docs_with_reasons,
          partial_docs_have_reasons:
            reasonSummary.partial_docs_with_reasons === reasonSummary.partial_docs,
          unclassified_docs_have_reasons:
            reasonSummary.unclassified_docs_with_reasons === reasonSummary.unclassified_docs,
          partial_reason_counts_present:
            Object.keys(reasonSummary.partial_reason_counts).length > 0 || reasonSummary.partial_docs === 0,
        },
      },
    };

    return Response.json({ documents: ocrAssessedDocuments, health: enrichedHealth });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to fetch documents';
    return Response.json({ error: message }, { status: 500 });
  }
}

/**
 * Calculate OCR quality summary metrics
 */
function calculateOCRSummary(documents: any[]) {
  const summary = {
    native_clean: 0,
    ocr_clean: 0,
    ocr_mixed: 0,
    ocr_noisy: 0,
    ocr_unusable: 0,
    total_reprocess_candidates: 0,
    high_priority_candidates: 0,
  };

  for (const doc of documents) {
    if (doc.ocr_quality_status) {
      summary[doc.ocr_quality_status as keyof typeof summary] =
        (summary[doc.ocr_quality_status as keyof typeof summary] as number) + 1;
    }
    if (doc.reprocess_candidate) {
      summary.total_reprocess_candidates += 1;
      if (doc.document_priority === 'high') {
        summary.high_priority_candidates += 1;
      }
    }
  }

  return summary;
}
