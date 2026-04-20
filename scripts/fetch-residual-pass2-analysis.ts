import * as fs from 'fs';
import * as path from 'path';

/**
 * Fetch documents from /api/docs and generate residual analysis
 *
 * Usage: tsx scripts/fetch-residual-pass2-analysis.ts [--output <path>]
 */

interface DocumentFromAPI {
  id: string;
  title: string;
  source_type: string;
  chunk_count: number;
  excluded_chunk_count: number;
  quality_tier?: 'good' | 'partial' | 'poor' | null;
  quality_reasons?: string[];
  boilerplate_chunk_count?: number;
  downranked_chunk_count?: number;
  is_active?: boolean;
}

async function main() {
  const args = process.argv.slice(2);
  const outputPathIndex = args.indexOf('--output');
  const outputPath =
    outputPathIndex >= 0
      ? args[outputPathIndex + 1]
      : 'docs/reports/2026-04-20-live-validation/residual-exclusion-analysis-pass2-before.json';

  const baseUrl = process.env.API_BASE_URL || 'http://localhost:3000';

  console.log('[residual-pass2-fetch] Fetching documents from API...');
  const response = await fetch(`${baseUrl}/api/docs?status=completed`);

  if (!response.ok) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const allDocs: DocumentFromAPI[] = data.documents || [];

  // Filter for active Partial docs with high excluded ratio
  const residualDocs = allDocs
    .filter((d) => d.is_active !== false && d.quality_tier === 'partial')
    .map((d) => {
      const totalChunks = d.chunk_count || 0;
      const excludedChunks = d.excluded_chunk_count || 0;
      const excludedRatio = totalChunks > 0 ? excludedChunks / totalChunks : 0;

      return {
        ...d,
        total_chunks: totalChunks,
        included_chunks: totalChunks - excludedChunks,
        excluded_chunks: excludedChunks,
        excluded_ratio: parseFloat(excludedRatio.toFixed(4)),
      };
    })
    .sort((a, b) => b.excluded_ratio - a.excluded_ratio)
    .slice(0, 20);

  // Estimate residual patterns from quality_reasons
  const residualPatterns = new Set<string>();
  for (const doc of residualDocs) {
    const reasons = doc.quality_reasons || [];
    if (reasons.includes('High excluded chunk ratio')) {
      residualPatterns.add('High excluded chunk ratio');
    }
  }

  // Create placeholder exclusion category analysis
  const categoryTotals: Record<string, number> = {
    duplicate_boilerplate: 0,
    metadata_block: 0,
    short_fragment_noise: 0,
    other: 0,
  };

  for (const doc of residualDocs) {
    categoryTotals['duplicate_boilerplate'] += doc.boilerplate_chunk_count || 0;
  }

  const categoryArray = Object.entries(categoryTotals)
    .filter(([, count]) => count > 0)
    .map(([category, excluded_chunks]) => ({ category, excluded_chunks }))
    .sort((a, b) => b.excluded_chunks - a.excluded_chunks);

  const artifact = {
    generated_at: new Date().toISOString(),
    cohort_definition: 'Top 20 active Partial docs by excluded_ratio from /api/docs',
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
      category_assessment: {},
      note: 'This is a shallow analysis based on /api/docs aggregate data. Per-chunk category analysis requires database queries.',
    },
  };

  // Ensure output dir exists
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(artifact, null, 2));
  console.log(`[residual-pass2-fetch] Analysis saved to ${outputPath}`);
  console.log(`[residual-pass2-fetch] Cohort size: ${artifact.cohort_size}`);
  console.log(`[residual-pass2-fetch] Avg excluded ratio: ${artifact.summary.avg_excluded_ratio}`);
  console.log(`[residual-pass2-fetch] High-excluded docs: ${artifact.summary.high_excluded_doc_count}`);
  console.log(`[residual-pass2-fetch] Top residual patterns: ${artifact.residual_patterns_identified.join(', ')}`);
  console.log(
    JSON.stringify({
      cohort_size: artifact.cohort_size,
      avg_excluded_ratio: artifact.summary.avg_excluded_ratio,
      high_excluded_doc_count: artifact.summary.high_excluded_doc_count,
      top_patterns: artifact.residual_patterns_identified,
      top_categories: artifact.top_exclusion_categories.slice(0, 5).map((c: any) => `${c.category}:${c.excluded_chunks}`),
    })
  );
}

main().catch((err) => {
  console.error('[residual-pass2-fetch] Error:', err);
  process.exit(1);
});
