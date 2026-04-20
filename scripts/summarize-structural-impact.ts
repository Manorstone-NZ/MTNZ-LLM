import * as fs from 'fs';
import * as path from 'path';
import sql from '../src/lib/db';

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

interface PerDoc {
  id: string;
  title: string;
  source_path?: string;
  excluded_ratio: number;
  dominant_structural_failure_pattern: FailureCategory;
  heading_quality_indicators: {
    heading_chunk_count: number;
    heading_chunk_ratio: number;
    weak_heading_signal: boolean;
  };
  section_boundary_quality_indicators: {
    broken_structure_chunks: number;
    short_fragment_noise_chunks: number;
    null_section_title_ratio: number;
  };
  chunk_density: {
    chunk_count: number;
    included_chunk_count: number;
  };
}

interface StructuralArtifact {
  generated_at: string;
  cohort_size: number;
  summary: {
    avg_excluded_ratio: number;
    high_excluded_doc_count: number;
    top_structural_failure_categories: Array<{ category: FailureCategory; count: number }>;
  };
  per_document: PerDoc[];
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

function delta(before: number, after: number): number {
  return Number((after - before).toFixed(4));
}

function pctImprovement(before: number, after: number): number {
  if (before === 0) return 0;
  return Number((((before - after) / before) * 100).toFixed(1));
}

function mapBySourcePath(docs: PerDoc[]): Map<string, PerDoc> {
  return new Map(
    docs
      .filter((doc) => typeof doc.source_path === 'string' && doc.source_path.length > 0)
      .map((doc) => [doc.source_path as string, doc]),
  );
}

function mapByTitle(docs: PerDoc[]): Map<string, PerDoc> {
  return new Map(docs.map((doc) => [doc.title, doc]));
}

async function resolveSourcePathsForDocs(docs: PerDoc[]): Promise<void> {
  const ids = docs
    .filter((doc) => !doc.source_path)
    .map((doc) => doc.id);
  if (ids.length === 0) return;

  const rows = await sql<{ id: string; source_path: string }[]>`
    SELECT id::text AS id, source_path
    FROM documents
    WHERE id::text IN ${sql(ids)}
  `;
  const idToPath = new Map(rows.map((row) => [row.id, row.source_path]));

  for (const doc of docs) {
    if (!doc.source_path) {
      doc.source_path = idToPath.get(doc.id);
    }
  }
}

function topCategories(artifact: StructuralArtifact): Array<{ category: FailureCategory; count: number }> {
  return [...artifact.summary.top_structural_failure_categories].sort((a, b) => b.count - a.count);
}

async function main() {
  const beforePath = parseArg('--before')
    ?? 'docs/reports/2026-04-20-live-validation/structural-quality-analysis-before.json';
  const afterPath = parseArg('--after')
    ?? 'docs/reports/2026-04-20-live-validation/structural-quality-analysis-after.json';
  const outputPath = parseArg('--output')
    ?? 'docs/reports/2026-04-20-live-validation/structural-pass-impact-summary.json';

  const before = JSON.parse(fs.readFileSync(beforePath, 'utf8')) as StructuralArtifact;
  const after = JSON.parse(fs.readFileSync(afterPath, 'utf8')) as StructuralArtifact;

  await resolveSourcePathsForDocs(before.per_document);
  await resolveSourcePathsForDocs(after.per_document);

  const beforeBySourcePath = mapBySourcePath(before.per_document);
  const beforeByTitle = mapByTitle(before.per_document);

  const perDocImpact = after.per_document
    .map((docAfter) => {
      const docBefore = (docAfter.source_path && beforeBySourcePath.get(docAfter.source_path))
        || beforeByTitle.get(docAfter.title);
      if (!docBefore) return null;
      return {
        id: docAfter.id,
        source_path: docAfter.source_path ?? null,
        title: docAfter.title,
        excluded_ratio_before: docBefore.excluded_ratio,
        excluded_ratio_after: docAfter.excluded_ratio,
        excluded_ratio_delta: delta(docBefore.excluded_ratio, docAfter.excluded_ratio),
        heading_chunk_count_before: docBefore.heading_quality_indicators.heading_chunk_count,
        heading_chunk_count_after: docAfter.heading_quality_indicators.heading_chunk_count,
        heading_ratio_before: docBefore.heading_quality_indicators.heading_chunk_ratio,
        heading_ratio_after: docAfter.heading_quality_indicators.heading_chunk_ratio,
        weak_heading_signal_before: docBefore.heading_quality_indicators.weak_heading_signal,
        weak_heading_signal_after: docAfter.heading_quality_indicators.weak_heading_signal,
        broken_structure_before: docBefore.section_boundary_quality_indicators.broken_structure_chunks,
        broken_structure_after: docAfter.section_boundary_quality_indicators.broken_structure_chunks,
        short_fragment_noise_before: docBefore.section_boundary_quality_indicators.short_fragment_noise_chunks,
        short_fragment_noise_after: docAfter.section_boundary_quality_indicators.short_fragment_noise_chunks,
        null_section_title_ratio_before: docBefore.section_boundary_quality_indicators.null_section_title_ratio,
        null_section_title_ratio_after: docAfter.section_boundary_quality_indicators.null_section_title_ratio,
        included_chunks_before: docBefore.chunk_density.included_chunk_count,
        included_chunks_after: docAfter.chunk_density.included_chunk_count,
        dominant_failure_before: docBefore.dominant_structural_failure_pattern,
        dominant_failure_after: docAfter.dominant_structural_failure_pattern,
      };
    })
    .filter((item): item is NonNullable<typeof item> => item != null)
    .sort((a, b) => a.excluded_ratio_delta - b.excluded_ratio_delta);

  const improvedDocs = perDocImpact.filter((doc) => doc.excluded_ratio_delta < 0);
  const headingImprovedDocs = perDocImpact.filter(
    (doc) => doc.heading_chunk_count_after > doc.heading_chunk_count_before
      || (doc.weak_heading_signal_before && !doc.weak_heading_signal_after),
  );
  const boundaryImprovedDocs = perDocImpact.filter(
    (doc) => doc.broken_structure_after < doc.broken_structure_before
      || doc.short_fragment_noise_after < doc.short_fragment_noise_before,
  );

  const unresolvedDocs = perDocImpact
    .filter((doc) => doc.excluded_ratio_after >= 0.25)
    .slice(0, 10)
    .map((doc) => ({
      id: doc.id,
      title: doc.title,
      excluded_ratio_after: doc.excluded_ratio_after,
      dominant_failure_after: doc.dominant_failure_after,
    }));

  const result = {
    generated_at: new Date().toISOString(),
    inputs: {
      before: beforePath,
      after: afterPath,
      before_generated_at: before.generated_at,
      after_generated_at: after.generated_at,
    },
    cohort: {
      before_size: before.cohort_size,
      after_size: after.cohort_size,
      matched_docs: perDocImpact.length,
    },
    metrics: {
      avg_excluded_ratio_before: before.summary.avg_excluded_ratio,
      avg_excluded_ratio_after: after.summary.avg_excluded_ratio,
      avg_excluded_ratio_delta: delta(before.summary.avg_excluded_ratio, after.summary.avg_excluded_ratio),
      avg_excluded_ratio_improvement_pct: pctImprovement(before.summary.avg_excluded_ratio, after.summary.avg_excluded_ratio),
      high_excluded_doc_count_before: before.summary.high_excluded_doc_count,
      high_excluded_doc_count_after: after.summary.high_excluded_doc_count,
      improved_doc_count: improvedDocs.length,
      heading_improved_doc_count: headingImprovedDocs.length,
      boundary_improved_doc_count: boundaryImprovedDocs.length,
    },
    category_shift: {
      before_top: topCategories(before),
      after_top: topCategories(after),
    },
    top_improved_docs: improvedDocs.slice(0, 5),
    unresolved_docs_sample: unresolvedDocs,
    per_document_impact: perDocImpact,
  };

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  console.log(`[structural-impact] Wrote: ${outputPath}`);
  console.log(`[structural-impact] Improved docs: ${result.metrics.improved_doc_count}`);
  console.log(
    `[structural-impact] Avg excluded ratio: ${result.metrics.avg_excluded_ratio_before} -> ${result.metrics.avg_excluded_ratio_after} (${result.metrics.avg_excluded_ratio_improvement_pct}% improvement)`,
  );
  await sql.end({ timeout: 5 });
}

main().catch((err) => {
  console.error('[structural-impact] Error:', err);
  process.exit(1);
});