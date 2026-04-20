import sql from '../src/lib/db';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Analyze residual exclusion patterns in remaining active Partial docs.
 * Identifies top 20 docs still driven by exclusion issues after pass 1.
 *
 * Usage: tsx scripts/analyze-residual-pass2.ts [--output <path>]
 */

interface ExcludedChunk {
  section_id: string;
  reason_code: string | null;
  inclusion_reason: string | null;
  payload: unknown;
}

interface ResidualDoc {
  id: string;
  title: string;
  source_type: string;
  total_chunks: number;
  included_chunks: number;
  excluded_chunks: number;
  excluded_ratio: number;
  active: boolean;
  quality_tier: string;
  quality_reasons: string[];
  dominant_exclusion_patterns: Array<{ category: string; count: number }>;
  residual_drivers: string[];
  section_type_breakdown: Array<{ section_type: string; count: number }>;
}

interface ResidualAnalysisArtifact {
  generated_at: string;
  cohort_definition: string;
  cohort_size: number;
  per_document: ResidualDoc[];
  top_exclusion_categories: Array<{ category: string; excluded_chunks: number }>;
  residual_patterns_identified: string[];
  summary: {
    avg_excluded_ratio: number;
    high_excluded_doc_count: number;
    dominant_family_drivers: Record<string, number>;
    category_assessment: Record<string, { category: string; likely_issue: string; action_needed: boolean }>;
  };
}

async function classifyExclusionCategory(chunk: ExcludedChunk): Promise<string> {
  const code = chunk.reason_code ? String(chunk.reason_code).toLowerCase() : '';
  const inclusion = chunk.inclusion_reason ? String(chunk.inclusion_reason).toLowerCase() : '';

  if (code.includes('boilerplate') || inclusion?.includes('duplicate_boilerplate')) {
    return 'duplicate_boilerplate';
  }
  if (code.includes('ocr') || inclusion?.includes('ocr_garbage')) {
    return 'ocr_garbage';
  }
  if (code.includes('metadata') || inclusion?.includes('metadata')) {
    return 'metadata_block';
  }
  if (code.includes('broken') || inclusion?.includes('broken_structure')) {
    return 'broken_structure';
  }
  if (code.includes('short') && inclusion?.includes('noise')) {
    return 'short_fragment_noise';
  }
  if (code.includes('short') && inclusion?.includes('procedure')) {
    return 'short_procedure';
  }
  if (code.includes('table') && inclusion?.includes('reference')) {
    return 'table_reference';
  }
  if (code.includes('table') || inclusion?.includes('table_noise')) {
    return 'table_noise';
  }
  if (code.includes('list') || inclusion?.includes('list_reference')) {
    return 'list_reference';
  }
  if (code.includes('diagram') || code.includes('caption')) {
    return 'diagram_caption';
  }
  if (code.includes('footer') || inclusion?.includes('footer_mixed_body')) {
    return 'footer_mixed_body';
  }
  if (code.includes('weak')) {
    return 'weak_heading_fragment';
  }

  return 'other_exclusion';
}

async function analyzeExcludedChunks(
  docId: string
): Promise<{ patterns: Map<string, number>; sectionTypes: Map<string, number> }> {
  const patterns = new Map<string, number>();
  const sectionTypes = new Map<string, number>();

  const chunks = await sql<ExcludedChunk[]>`
    SELECT 
      s.id as section_id,
      s.reason_code,
      s.inclusion_reason,
      s.payload,
      s.section_type
    FROM sections s
    WHERE s.doc_id = ${docId} AND s.included = false
    ORDER BY s.created_at
  `;

  for (const chunk of chunks || []) {
    const category = await classifyExclusionCategory(chunk);
    patterns.set(category, (patterns.get(category) || 0) + 1);

    const sectionType = (chunk.payload as any)?.section_type || 'unknown';
    sectionTypes.set(sectionType, (sectionTypes.get(sectionType) || 0) + 1);
  }

  return { patterns, sectionTypes };
}

async function getTopResidualDocs(): Promise<ResidualDoc[]> {
  // Query all active Partial docs, prioritize by high excluded ratio + unimproved status
  const docs = await sql`
    SELECT 
      d.id,
      d.title,
      d.source_type,
      d.active,
      d.quality_tier,
      d.quality_reasons,
      COUNT(s.id) FILTER (WHERE s.included = true) as included_chunks,
      COUNT(s.id) FILTER (WHERE s.included = false) as excluded_chunks,
      COUNT(s.id) as total_chunks
    FROM docs d
    LEFT JOIN sections s ON d.id = s.doc_id
    WHERE d.active = true AND d.quality_tier = 'Partial'
    GROUP BY d.id, d.title, d.source_type, d.active, d.quality_tier, d.quality_reasons
    HAVING COUNT(s.id) > 0
    ORDER BY 
      CASE 
        WHEN d.quality_reasons::text ILIKE '%High excluded%' THEN 0
        ELSE 1
      END,
      (COUNT(s.id) FILTER (WHERE s.included = false)::float / NULLIF(COUNT(s.id), 0)) DESC
    LIMIT 20
  `;

  const results: ResidualDoc[] = [];

  for (const doc of docs || []) {
    const totalChunks = parseInt(doc.total_chunks) || 0;
    const excludedChunks = parseInt(doc.excluded_chunks) || 0;
    const includedChunks = parseInt(doc.included_chunks) || 0;
    const excludedRatio = totalChunks > 0 ? excludedChunks / totalChunks : 0;

    const { patterns, sectionTypes } = await analyzeExcludedChunks(doc.id);

    const patternArray = Array.from(patterns.entries())
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    const sectionTypeArray = Array.from(sectionTypes.entries())
      .map(([section_type, count]) => ({ section_type, count }))
      .sort((a, b) => b.count - a.count);

    const qualityReasons = doc.quality_reasons
      ? typeof doc.quality_reasons === 'string'
        ? JSON.parse(doc.quality_reasons)
        : doc.quality_reasons
      : [];

    const residualDrivers = [];
    if (qualityReasons.includes('High excluded chunk ratio')) {
      residualDrivers.push('High excluded chunk ratio');
    }
    const brokenCount = patternArray.find((p) => p.category === 'broken_structure')?.count || 0;
    if (brokenCount > 2) {
      residualDrivers.push('broken_structure');
    }
    const shortFragmentCount = patternArray.find((p) => p.category === 'short_fragment_noise')?.count || 0;
    if (shortFragmentCount > 3) {
      residualDrivers.push('short_fragment_noise');
    }
    if (residualDrivers.length === 0 && excludedRatio > 0.25) {
      residualDrivers.push('elevated_exclusion');
    }

    results.push({
      id: doc.id,
      title: doc.title,
      source_type: doc.source_type,
      total_chunks: totalChunks,
      included_chunks: includedChunks,
      excluded_chunks: excludedChunks,
      excluded_ratio: parseFloat(excludedRatio.toFixed(4)),
      active: doc.active,
      quality_tier: doc.quality_tier,
      quality_reasons: qualityReasons,
      dominant_exclusion_patterns: patternArray,
      residual_drivers: residualDrivers,
      section_type_breakdown: sectionTypeArray,
    });
  }

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const outputPathIndex = args.indexOf('--output');
  const outputPath =
    outputPathIndex >= 0
      ? args[outputPathIndex + 1]
      : 'docs/reports/2026-04-20-live-validation/residual-exclusion-analysis-pass2-before.json';

  console.log('[residual-pass2-analysis] Querying active Partial docs...');
  const residualDocs = await getTopResidualDocs();

  // Aggregate category stats
  const categoryTotals = new Map<string, number>();
  for (const doc of residualDocs) {
    for (const pattern of doc.dominant_exclusion_patterns) {
      categoryTotals.set(pattern.category, (categoryTotals.get(pattern.category) || 0) + pattern.count);
    }
  }

  const categoryArray = Array.from(categoryTotals.entries())
    .map(([category, count]) => ({ category, excluded_chunks: count }))
    .sort((a, b) => b.excluded_chunks - a.excluded_chunks);

  // Identify residual patterns
  const residualPatterns = new Set<string>();
  for (const doc of residualDocs) {
    for (const driver of doc.residual_drivers) {
      residualPatterns.add(driver);
    }
  }

  // Category assessment
  const categoryAssessment: Record<string, { category: string; likely_issue: string; action_needed: boolean }> = {};
  const trueNoise = ['duplicate_boilerplate', 'ocr_garbage', 'metadata_block', 'table_noise', 'short_fragment_noise'];
  const overExcluded = ['broken_structure', 'short_procedure', 'table_reference', 'list_reference', 'diagram_caption'];

  for (const { category } of categoryArray) {
    let assessment = { category, likely_issue: '', action_needed: false };

    if (trueNoise.includes(category)) {
      assessment.likely_issue = 'True noise - should remain excluded';
      assessment.action_needed = false;
    } else if (overExcluded.includes(category)) {
      const count = categoryTotals.get(category) || 0;
      if (count > 5) {
        assessment.likely_issue = 'Over-excluded - candidate for narrowed retention';
        assessment.action_needed = true;
      } else {
        assessment.likely_issue = 'Minor pattern - low impact tuning target';
        assessment.action_needed = false;
      }
    } else {
      assessment.likely_issue = 'Unclear - requires inspection';
      assessment.action_needed = false;
    }

    categoryAssessment[category] = assessment;
  }

  const artifact: ResidualAnalysisArtifact = {
    generated_at: new Date().toISOString(),
    cohort_definition: 'Top 20 active Partial docs, prioritized by High excluded chunk ratio and high excluded ratio',
    cohort_size: residualDocs.length,
    per_document: residualDocs,
    top_exclusion_categories: categoryArray,
    residual_patterns_identified: Array.from(residualPatterns),
    summary: {
      avg_excluded_ratio: parseFloat(
        (residualDocs.reduce((sum, d) => sum + d.excluded_ratio, 0) / residualDocs.length).toFixed(4)
      ),
      high_excluded_doc_count: residualDocs.filter((d) => d.excluded_ratio >= 0.25).length,
      dominant_family_drivers: {},
      category_assessment: categoryAssessment,
    },
  };

  // Family drivers
  const familyMap = new Map<string, number>();
  for (const doc of residualDocs) {
    const family = doc.title.split(' ')[0] || 'unknown';
    familyMap.set(family, (familyMap.get(family) || 0) + 1);
  }

  for (const [family, count] of familyMap.entries()) {
    artifact.summary.dominant_family_drivers[family] = count;
  }

  // Ensure output dir exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2));
  console.log(`[residual-pass2-analysis] Analysis saved to ${outputPath}`);
  console.log(`[residual-pass2-analysis] Cohort size: ${artifact.cohort_size}`);
  console.log(`[residual-pass2-analysis] Avg excluded ratio: ${artifact.summary.avg_excluded_ratio}`);
  console.log(`[residual-pass2-analysis] High-excluded docs: ${artifact.summary.high_excluded_doc_count}`);
  console.log(`[residual-pass2-analysis] Top residual patterns: ${artifact.residual_patterns_identified.join(', ')}`);
  console.log(JSON.stringify({
    cohort_size: artifact.cohort_size,
    avg_excluded_ratio: artifact.summary.avg_excluded_ratio,
    high_excluded_doc_count: artifact.summary.high_excluded_doc_count,
    top_patterns: artifact.residual_patterns_identified,
    top_categories: artifact.top_exclusion_categories.slice(0, 5).map((c) => `${c.category}:${c.excluded_chunks}`),
  }));
}

main().catch(console.error);
