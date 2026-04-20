import fs from 'fs';
import path from 'path';

/**
 * Generate OCR quality reconciliation validation artifact
 * Run: npx tsx scripts/generate-ocr-quality-reconciliation.ts --api-output <path-to-api-response.json>
 */

interface DocumentRow {
  id: string;
  title: string;
  ocr_quality_status?: string;
  ocr_quality_reasons?: string[];
  document_priority?: string;
  reprocess_candidate?: boolean;
  reprocess_reason?: string;
  reprocess_rank?: number | null;
  chunk_count?: number;
  excluded_chunk_count?: number;
}

interface ValidationReport {
  generated_at: string;
  total_documents: number;
  status_distribution: Record<string, number>;
  priority_distribution: Record<string, number>;
  
  validation_checks: {
    all_docs_have_status: boolean;
    all_quality_docs_have_reasons: boolean;
    all_candidates_have_reasons: boolean;
    all_candidates_have_rank: boolean;
    no_zero_candidates: boolean;
  };
  
  validation_details: string[];
  
  top_reprocess_candidates: Array<{
    rank: number | null;
    title: string;
    status: string;
    priority: string;
    excluded_ratio: number;
    reasons: string;
  }>;
  
  sample_rows: Array<{
    title: string;
    status: string;
    priority: string;
    candidate: boolean;
    reasons: string[];
  }>;
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

function getExcludedRatio(doc: DocumentRow): number {
  if (!doc.chunk_count || doc.chunk_count === 0) return 0;
  return (doc.excluded_chunk_count ?? 0) / doc.chunk_count;
}

function main(): void {
  const apiOutputPath = parseArg('--api-output');
  if (!apiOutputPath) {
    console.error('Usage: npx tsx scripts/generate-ocr-quality-reconciliation.ts --api-output <path>');
    process.exit(1);
  }

  if (!fs.existsSync(apiOutputPath)) {
    console.error(`File not found: ${apiOutputPath}`);
    process.exit(1);
  }

  const apiResponse = JSON.parse(fs.readFileSync(apiOutputPath, 'utf8'));
  const documents: DocumentRow[] = apiResponse.documents ?? [];

  // Collect validation data
  const statusDist: Record<string, number> = {};
  const priorityDist: Record<string, number> = {};
  let docsWithoutStatus = 0;
  let docsNeedingReasonsMissing = 0;
  let candidatesWithoutReasons = 0;
  let candidatesWithoutRank = 0;
  const validationDetails: string[] = [];

  for (const doc of documents) {
    // Status distribution
    const status = doc.ocr_quality_status ?? 'unassigned';
    statusDist[status] = (statusDist[status] ?? 0) + 1;

    // Check status assignment
    if (!doc.ocr_quality_status) {
      docsWithoutStatus += 1;
    }

    // Check quality docs have reasons
    if (doc.ocr_quality_status && ['ocr_mixed', 'ocr_noisy', 'ocr_unusable'].includes(doc.ocr_quality_status)) {
      if (!doc.ocr_quality_reasons || doc.ocr_quality_reasons.length === 0) {
        docsNeedingReasonsMissing += 1;
        validationDetails.push(
          `⚠ ${doc.ocr_quality_status} doc missing reasons: ${doc.title}`
        );
      }
    }

    // Check candidates have reasons and rank
    if (doc.reprocess_candidate) {
      if (!doc.reprocess_reason || doc.reprocess_reason.trim().length === 0) {
        candidatesWithoutReasons += 1;
        validationDetails.push(`⚠ Candidate missing reason: ${doc.title}`);
      }
      if (doc.reprocess_rank === null || doc.reprocess_rank === undefined) {
        candidatesWithoutRank += 1;
        validationDetails.push(`⚠ Candidate missing rank: ${doc.title}`);
      }
    }

    // Priority distribution
    if (doc.document_priority) {
      priorityDist[doc.document_priority] = (priorityDist[doc.document_priority] ?? 0) + 1;
    }
  }

  // Get top reprocess candidates
  const candidates = documents
    .filter(d => d.reprocess_candidate)
    .sort((a, b) => (a.reprocess_rank ?? Infinity) - (b.reprocess_rank ?? Infinity))
    .slice(0, 10)
    .map(d => ({
      rank: d.reprocess_rank ?? null,
      title: d.title,
      status: d.ocr_quality_status ?? 'unknown',
      priority: d.document_priority ?? 'unknown',
      excluded_ratio: getExcludedRatio(d),
      reasons: d.reprocess_reason ?? '',
    }));

  // Sample rows (variety of statuses)
  const samples: DocumentRow[] = [];
  const statusSamples: Record<string, boolean> = {};
  for (const doc of documents) {
    const status = doc.ocr_quality_status ?? 'unassigned';
    if (!statusSamples[status] && samples.length < 8) {
      samples.push(doc);
      statusSamples[status] = true;
    }
  }

  const sampleRows = samples.map(d => ({
    title: d.title,
    status: d.ocr_quality_status ?? 'unassigned',
    priority: d.document_priority ?? 'unknown',
    candidate: d.reprocess_candidate ?? false,
    reasons: d.ocr_quality_reasons ?? [],
  }));

  // Build validation report
  const report: ValidationReport = {
    generated_at: new Date().toISOString(),
    total_documents: documents.length,
    status_distribution: statusDist,
    priority_distribution: priorityDist,
    validation_checks: {
      all_docs_have_status: docsWithoutStatus === 0,
      all_quality_docs_have_reasons: docsNeedingReasonsMissing === 0,
      all_candidates_have_reasons: candidatesWithoutReasons === 0,
      all_candidates_have_rank: candidatesWithoutRank === 0,
      no_zero_candidates: candidates.length > 0 || documents.filter(d => d.reprocess_candidate).length === 0,
    },
    validation_details: validationDetails.length > 0
      ? validationDetails
      : ['✓ All validation checks passed'],
    top_reprocess_candidates: candidates,
    sample_rows: sampleRows,
  };

  // Output report
  const outputPath = 'docs/reports/2026-04-21-pass2-prep/ocr-quality-reconciliation.json';
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log('[ocr-quality-validation] Report generated');
  console.log(`[ocr-quality-validation] Total docs: ${documents.length}`);
  console.log(`[ocr-quality-validation] Status distribution: ${JSON.stringify(statusDist)}`);
  console.log(`[ocr-quality-validation] Candidates: ${documents.filter(d => d.reprocess_candidate).length}`);
  console.log(`[ocr-quality-validation] Validation: ${report.validation_checks.all_docs_have_status ? '✓ PASS' : '✗ FAIL'}`);
  if (!report.validation_checks.all_docs_have_status) {
    console.log(`  → ${docsWithoutStatus} docs missing status`);
  }
  if (!report.validation_checks.all_quality_docs_have_reasons) {
    console.log(`  → ${docsNeedingReasonsMissing} quality docs missing reasons`);
  }
  if (!report.validation_checks.all_candidates_have_reasons) {
    console.log(`  → ${candidatesWithoutReasons} candidates missing reasons`);
  }
  if (!report.validation_checks.all_candidates_have_rank) {
    console.log(`  → ${candidatesWithoutRank} candidates missing rank`);
  }
  console.log(`[ocr-quality-validation] Output: ${outputPath}`);
}

try {
  main();
} catch (err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[ocr-quality-validation] Error:', message);
  process.exit(1);
}
