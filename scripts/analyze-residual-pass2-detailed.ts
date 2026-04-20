import * as fs from 'fs';
import * as path from 'path';

type FailureCategory =
  | 'weak_heading_detection'
  | 'broken_section_boundary'
  | 'multi_column_fragmentation'
  | 'ocr_body_contamination'
  | 'table_schema_loss'
  | 'split_procedure_fragment'
  | 'footer_header_body_mix'
  | 'diagram_caption_fragmentation'
  | 'sparse_extraction'
  | 'layout_order_error';

interface ResidualDocAnalysis {
  id: string;
  title: string;
  source_path: string;
  source_type: string;
  excluded_ratio_after_pass1: number;
  dominant_failure_after_pass1: FailureCategory;
  is_footer_header_body_mix: boolean;
  ocr_contamination_present: boolean;
  improved_in_pass1: boolean;
  chunk_count: number;
  excluded_chunk_count: number;
  footer_header_contamination_samples: string[];
  ocr_garbage_samples: string[];
  residual_risk_notes: string;
  likely_fixable_by_cleanup: boolean;
  likely_stable_partial_floor: boolean;
}

interface ResidualPass2Artifact {
  generated_at: string;
  cohort_source: string;
  cohort_size: number;
  analysis_timestamp: string;
  per_document: ResidualDocAnalysis[];
  summary: {
    docs_with_footer_header_body_mix: number;
    docs_with_ocr_contamination_contributing: number;
    likely_fixable_docs: number;
    likely_stable_floor_docs: number;
    top_affected_families: Array<{ family: string; count: number }>;
    cleanup_opportunity_estimate: string;
    risk_assessment: string;
  };
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

function inferFamily(title: string): string {
  const lop = title.match(/^(LOP-[A-Z]{2})\b/i);
  if (lop) return lop[1].toUpperCase();
  const firstToken = title.trim().split(/\s+/)[0] ?? 'unknown';
  return firstToken.replace(/[^A-Za-z0-9-]/g, '') || 'unknown';
}



async function main() {
  const beforePath = parseArg('--before')
    ?? 'docs/reports/2026-04-20-live-validation/structural-quality-analysis-before.json';
  const afterPath = parseArg('--after')
    ?? 'docs/reports/2026-04-20-live-validation/structural-quality-analysis-after.json';
  const outputPath = parseArg('--output')
    ?? 'docs/reports/2026-04-21-pass2-prep/residual-pass2-detailed-analysis.json';

  if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) {
    throw new Error(`Before or after artifact missing: ${beforePath} or ${afterPath}`);
  }

  const beforeArtifact = JSON.parse(fs.readFileSync(beforePath, 'utf8')) as {
    per_document?: Array<{ title: string; excluded_ratio: number; dominant_structural_failure_pattern: FailureCategory }>;
  };
  const afterArtifact = JSON.parse(fs.readFileSync(afterPath, 'utf8')) as {
    per_document?: Array<{ id: string; source_path: string; title: string; excluded_ratio: number; dominant_structural_failure_pattern: FailureCategory; source_type?: string; ocr_and_fallback?: { ocr_used: boolean }; chunk_density?: { chunk_count: number; excluded_chunk_count: number } }>;
  };

  const beforeByTitle = new Map(
    (beforeArtifact.per_document ?? []).map((d) => [
      d.title,
      { excluded_ratio: d.excluded_ratio, dominant: d.dominant_structural_failure_pattern },
    ])
  );

  const perDoc: ResidualDocAnalysis[] = [];
  const familyCounts: Record<string, number> = {};
  let footerHeaderMixCount = 0;
  let ocrContaminationCount = 0;
  let fixableCount = 0;
  let stableFloorCount = 0;

  for (const afterDoc of (afterArtifact.per_document ?? [])) {
    const beforeDoc = beforeByTitle.get(afterDoc.title);
    if (!beforeDoc) {
      console.warn(`[residual-pass2] No before doc for: ${afterDoc.title}`);
      continue;
    }

    const improved = afterDoc.excluded_ratio < beforeDoc.excluded_ratio;
    const isFooterHeaderMix = afterDoc.dominant_structural_failure_pattern === 'footer_header_body_mix';
    if (isFooterHeaderMix) footerHeaderMixCount += 1;

    const ocrUsed = afterDoc.ocr_and_fallback?.ocr_used ?? false;
    const hasOCRContamination = ocrUsed;
    if (hasOCRContamination && isFooterHeaderMix) ocrContaminationCount += 1;

    const chunkCount = afterDoc.chunk_density?.chunk_count ?? 0;
    const excludedCount = afterDoc.chunk_density?.excluded_chunk_count ?? 0;

    const family = inferFamily(afterDoc.title || '');
    familyCounts[family] = (familyCounts[family] ?? 0) + 1;

    // Determine fixability and stability
    const likely_fixable = isFooterHeaderMix && !hasOCRContamination;
    const likely_stable = afterDoc.excluded_ratio > 0.28 && isFooterHeaderMix && hasOCRContamination;

    if (likely_fixable) fixableCount += 1;
    if (likely_stable) stableFloorCount += 1;

    const riskNotes = [];
    if (hasOCRContamination && isFooterHeaderMix) {
      riskNotes.push('OCR + footer/header mix (higher risk)');
    }
    if (afterDoc.excluded_ratio > 0.29) {
      riskNotes.push('High excluded ratio after pass 1');
    }
    if (!improved) {
      riskNotes.push('Did not improve in pass 1');
    }
    if (likely_fixable) {
      riskNotes.push('Good candidate for footer/header cleanup');
    }

    perDoc.push({
      id: afterDoc.id,
      title: afterDoc.title || 'unknown',
      source_path: afterDoc.source_path || '',
      source_type: afterDoc.source_type || 'pdf',
      excluded_ratio_after_pass1: afterDoc.excluded_ratio,
      dominant_failure_after_pass1: afterDoc.dominant_structural_failure_pattern,
      is_footer_header_body_mix: isFooterHeaderMix,
      ocr_contamination_present: hasOCRContamination,
      improved_in_pass1: improved,
      chunk_count: chunkCount,
      excluded_chunk_count: excludedCount,
      footer_header_contamination_samples: [],
      ocr_garbage_samples: [],
      residual_risk_notes: riskNotes.join('; '),
      likely_fixable_by_cleanup: likely_fixable,
      likely_stable_partial_floor: likely_stable,
    });
  }

  const topFamilies = Object.entries(familyCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([family, count]) => ({ family, count }));

  const cleanupOpportunity = fixableCount > 0 
    ? `High: ${fixableCount}/${perDoc.length} docs likely fixable by footer/header cleanup`
    : 'Low: Most residual issues tied to OCR or inherent structure';

  const riskAssessment = stableFloorCount > (perDoc.length * 0.5)
    ? `High risk: ${stableFloorCount}/${perDoc.length} docs show stable floor traits`
    : `Moderate: ${stableFloorCount}/${perDoc.length} docs may be stable floor`;

  const artifact: ResidualPass2Artifact = {
    generated_at: new Date().toISOString(),
    cohort_source: `Fixed cohort from ${beforePath}`,
    cohort_size: perDoc.length,
    analysis_timestamp: new Date().toISOString(),
    per_document: perDoc,
    summary: {
      docs_with_footer_header_body_mix: footerHeaderMixCount,
      docs_with_ocr_contamination_contributing: ocrContaminationCount,
      likely_fixable_docs: fixableCount,
      likely_stable_floor_docs: stableFloorCount,
      top_affected_families: topFamilies,
      cleanup_opportunity_estimate: cleanupOpportunity,
      risk_assessment: riskAssessment,
    },
  };

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  console.log(`[residual-pass2] Analysis saved to ${outputPath}`);
  console.log(`[residual-pass2] Cohort size: ${perDoc.length}`);
  console.log(`[residual-pass2] Footer/header mix docs: ${footerHeaderMixCount}/${perDoc.length}`);
  console.log(`[residual-pass2] OCR contamination contributing: ${ocrContaminationCount}/${perDoc.length}`);
  console.log(`[residual-pass2] Likely fixable by cleanup: ${fixableCount}/${perDoc.length}`);
  console.log(`[residual-pass2] Risk: ${riskAssessment}`);
}

main().catch(e => {
  console.error('[residual-pass2] Error:', e);
  process.exit(1);
});
