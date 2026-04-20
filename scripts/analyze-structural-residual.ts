import { config } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import sql from '../src/lib/db';

config({ path: '.env.local' });

type Tier = 'good' | 'partial' | 'poor' | null;

interface DocumentFromAPI {
  id: string;
  title: string;
  source_path: string;
  source_type: string;
  is_active?: boolean;
  quality_tier?: Tier;
  text_quality_score?: number | null;
  extraction_method?: string | null;
  ocr_used?: boolean;
  quality_reasons?: string[];
  chunk_count: number;
  excluded_chunk_count: number;
  heading_chunk_count?: number;
  table_chunk_count?: number;
  list_chunk_count?: number;
}

interface ChunkAggRow {
  document_id: string;
  total_chunks_db: string;
  excluded_chunks_db: string;
  heading_chunks_db: string;
  table_chunks_db: string;
  list_chunks_db: string;
  null_section_title_chunks: string;
  avg_chunk_tokens: string;
  broken_structure_chunks: string;
  short_fragment_noise_chunks: string;
  table_noise_chunks: string;
  ocr_garbage_chunks: string;
  metadata_block_chunks: string;
  contamination_chunks: string;
  heading_like_paragraph_chunks: string;
}

const STRUCTURAL_CATEGORIES = [
  'weak_heading_detection',
  'broken_section_boundary',
  'multi_column_fragmentation',
  'ocr_body_contamination',
  'table_schema_loss',
  'split_procedure_fragment',
  'footer_header_body_mix',
  'diagram_caption_fragmentation',
  'sparse_extraction',
  'layout_order_error',
] as const;

type StructuralCategory = (typeof STRUCTURAL_CATEGORIES)[number];

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

function asNum(value: string | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : Number(value);
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return numerator / denominator;
}

function inferFamily(title: string): string {
  const lop = title.match(/^(LOP-[A-Z]{2})\b/i);
  if (lop) return lop[1].toUpperCase();
  const sop = title.match(/^(SOP-[A-Z]{2})\b/i);
  if (sop) return sop[1].toUpperCase();
  const firstToken = title.trim().split(/\s+/)[0] ?? 'unknown';
  return firstToken.replace(/[^A-Za-z0-9-]/g, '') || 'unknown';
}

function hasReason(reasons: string[] | undefined, target: string): boolean {
  return (reasons ?? []).some((r) => r.toLowerCase() === target.toLowerCase());
}

function scoreFailurePatterns(input: {
  sourceType: string;
  qualityReasons: string[];
  chunkCount: number;
  headingChunks: number;
  listChunks: number;
  tableChunks: number;
  nullTitleRatio: number;
  brokenStructureChunks: number;
  shortFragmentNoiseChunks: number;
  tableNoiseChunks: number;
  ocrGarbageChunks: number;
  metadataBlockChunks: number;
  contaminationChunks: number;
  headingLikeParagraphChunks: number;
  fallbackUsed: boolean;
  ocrUsed: boolean;
}): Record<StructuralCategory, number> {
  const isPdf = input.sourceType.toLowerCase() === 'pdf';

  return {
    weak_heading_detection:
      (input.headingChunks === 0 ? 2.5 : 0)
      + (input.headingLikeParagraphChunks * 0.7)
      + (hasReason(input.qualityReasons, 'Weak headings') ? 2 : 0),

    broken_section_boundary:
      (input.brokenStructureChunks * 0.6)
      + (input.shortFragmentNoiseChunks * 0.35)
      + (input.nullTitleRatio * 2)
      + (input.chunkCount > 0 && input.headingChunks === 0 ? 0.5 : 0),

    multi_column_fragmentation:
      (isPdf ? 1 : 0)
      + (input.nullTitleRatio * 1.8)
      + (input.brokenStructureChunks * 0.2)
      + (input.fallbackUsed ? 0.5 : 0),

    ocr_body_contamination:
      ((input.ocrUsed || input.fallbackUsed) ? 1.2 : 0)
      + (input.contaminationChunks * 0.9)
      + (input.ocrGarbageChunks * 0.7),

    table_schema_loss:
      (input.tableNoiseChunks * 0.8)
      + (input.tableChunks > 0 && input.headingChunks <= 1 ? 0.8 : 0)
      + (hasReason(input.qualityReasons, 'Table-heavy') ? 0.5 : 0),

    split_procedure_fragment:
      (input.shortFragmentNoiseChunks * 0.75)
      + (input.listChunks * 0.15)
      + (input.brokenStructureChunks * 0.25),

    footer_header_body_mix:
      (input.contaminationChunks * 1.1)
      + (input.metadataBlockChunks * 0.25),

    diagram_caption_fragmentation:
      (isPdf ? 0.3 : 0)
      + (input.chunkCount > 0 && input.headingChunks === 0 && input.tableChunks === 0 ? 0.4 : 0),

    sparse_extraction:
      (input.chunkCount <= 3 ? 3 : input.chunkCount <= 8 ? 1.5 : 0)
      + (hasReason(input.qualityReasons, 'Sparse text') ? 1 : 0)
      + (hasReason(input.qualityReasons, 'Low chunk density') ? 1 : 0),

    layout_order_error:
      (isPdf ? 1 : 0)
      + (input.nullTitleRatio * 1.3)
      + (input.fallbackUsed ? 0.8 : 0),
  };
}

function dominantCategory(scores: Record<StructuralCategory, number>): StructuralCategory {
  let best: StructuralCategory = 'broken_section_boundary';
  let bestScore = -Infinity;
  for (const category of STRUCTURAL_CATEGORIES) {
    if (scores[category] > bestScore) {
      bestScore = scores[category];
      best = category;
    }
  }
  return best;
}

async function getChunkAggs(docIds: string[]): Promise<Map<string, ChunkAggRow>> {
  if (docIds.length === 0) return new Map();

  const rows = await sql<ChunkAggRow[]>`
    SELECT
      c.document_id::text AS document_id,
      count(*)::text AS total_chunks_db,
      count(*) FILTER (WHERE c.retrieval_excluded = true)::text AS excluded_chunks_db,
      count(*) FILTER (WHERE c.section_type = 'heading')::text AS heading_chunks_db,
      count(*) FILTER (WHERE c.section_type = 'table')::text AS table_chunks_db,
      count(*) FILTER (WHERE c.section_type = 'list')::text AS list_chunks_db,
      count(*) FILTER (WHERE c.section_title IS NULL)::text AS null_section_title_chunks,
      coalesce(round(avg(c.token_count)::numeric, 2), 0)::text AS avg_chunk_tokens,
      count(*) FILTER (WHERE c.normalisation_reason ->> 'exclusion_tag' = 'broken_structure')::text AS broken_structure_chunks,
      count(*) FILTER (WHERE c.normalisation_reason ->> 'exclusion_tag' = 'short_fragment_noise')::text AS short_fragment_noise_chunks,
      count(*) FILTER (WHERE c.normalisation_reason ->> 'exclusion_tag' = 'table_noise')::text AS table_noise_chunks,
      count(*) FILTER (WHERE c.normalisation_reason ->> 'exclusion_tag' = 'ocr_garbage')::text AS ocr_garbage_chunks,
      count(*) FILTER (WHERE c.normalisation_reason ->> 'exclusion_tag' = 'metadata_block')::text AS metadata_block_chunks,
      count(*) FILTER (
        WHERE c.content ~* '(CONTROLLED COPY|IF THIS LINE IS GREEN|THIS DOCUMENT IS UNCONTROLLED|Page[[:space:]]+[0-9]+[[:space:]]+of[[:space:]]+[0-9]+)'
      )::text AS contamination_chunks,
      count(*) FILTER (
        WHERE c.section_type = 'paragraph'
          AND c.content ~ '^\\s*\\d+(\\.\\d+)*\\s+[A-Za-z]'
      )::text AS heading_like_paragraph_chunks
    FROM chunks c
    WHERE c.document_id::text IN ${sql(docIds)}
    GROUP BY c.document_id
  `;

  return new Map(rows.map((row) => [row.document_id, row]));
}

async function resolveSourcePathsFromArtifact(artifactPath: string): Promise<string[]> {
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
    per_document?: Array<{ id?: string; source_path?: string }>;
  };

  const direct = (artifact.per_document ?? [])
    .map((doc) => doc.source_path)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (direct.length > 0) return Array.from(new Set(direct));

  const ids = (artifact.per_document ?? [])
    .map((doc) => doc.id)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (ids.length === 0) return [];

  const rows = await sql<{ source_path: string }[]>`
    SELECT source_path
    FROM documents
    WHERE id::text IN ${sql(ids)}
  `;

  return Array.from(new Set(rows.map((row) => row.source_path)));
}

async function main() {
  const outputPath = parseArg('--output')
    ?? 'docs/reports/2026-04-20-live-validation/structural-quality-analysis-before.json';
  const baseUrl = parseArg('--baseUrl') ?? process.env.API_BASE_URL ?? 'http://localhost:3000';
  const cohortSize = Number(parseArg('--cohort') ?? '20');
  const cohortFrom = parseArg('--cohort-from');

  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/docs?status=completed`);
  if (!response.ok) {
    throw new Error(`Failed to fetch docs from API: ${response.status} ${response.statusText}`);
  }

  const payload = await response.json() as { documents?: DocumentFromAPI[] };
  const allDocs = payload.documents ?? [];

  const lockedSourcePaths = cohortFrom
    ? await resolveSourcePathsFromArtifact(cohortFrom)
    : [];
  const lockedSet = new Set(lockedSourcePaths);

  const residualCandidates = allDocs
    .filter((doc) => doc.is_active !== false && doc.quality_tier === 'partial')
    .filter((doc) => (lockedSet.size > 0 ? lockedSet.has(doc.source_path) : true));

  const residualTop = residualCandidates
    .map((doc) => {
      const chunkCount = Math.max(0, doc.chunk_count ?? 0);
      const excludedChunkCount = Math.max(0, doc.excluded_chunk_count ?? 0);
      const excludedRatio = safeRatio(excludedChunkCount, chunkCount);
      return {
        ...doc,
        chunk_count: chunkCount,
        excluded_chunk_count: excludedChunkCount,
        excluded_ratio: Number(excludedRatio.toFixed(4)),
      };
    })
    .sort((a, b) => {
      if (b.excluded_ratio !== a.excluded_ratio) return b.excluded_ratio - a.excluded_ratio;
      return (a.text_quality_score ?? 1) - (b.text_quality_score ?? 1);
    })
    .slice(0, lockedSet.size > 0 ? Math.max(lockedSet.size, cohortSize) : cohortSize);

  const ids = residualTop.map((d) => d.id);
  const chunkAggMap = await getChunkAggs(ids);

  const familyCounts: Record<string, number> = {};
  const categoryCounts: Record<StructuralCategory, number> = Object.fromEntries(
    STRUCTURAL_CATEGORIES.map((category) => [category, 0]),
  ) as Record<StructuralCategory, number>;

  const perDocument = residualTop.map((doc) => {
    const agg = chunkAggMap.get(doc.id);

    const totalChunks = doc.chunk_count;
    const excludedChunks = doc.excluded_chunk_count;
    const headingChunks = agg ? asNum(agg.heading_chunks_db) : asNum(doc.heading_chunk_count);
    const tableChunks = agg ? asNum(agg.table_chunks_db) : asNum(doc.table_chunk_count);
    const listChunks = agg ? asNum(agg.list_chunks_db) : asNum(doc.list_chunk_count);
    const nullSectionTitleChunks = agg ? asNum(agg.null_section_title_chunks) : 0;
    const nullTitleRatio = safeRatio(nullSectionTitleChunks, totalChunks);
    const avgChunkTokens = agg ? asNum(agg.avg_chunk_tokens) : 0;

    const brokenStructureChunks = agg ? asNum(agg.broken_structure_chunks) : 0;
    const shortFragmentNoiseChunks = agg ? asNum(agg.short_fragment_noise_chunks) : 0;
    const tableNoiseChunks = agg ? asNum(agg.table_noise_chunks) : 0;
    const ocrGarbageChunks = agg ? asNum(agg.ocr_garbage_chunks) : 0;
    const metadataBlockChunks = agg ? asNum(agg.metadata_block_chunks) : 0;
    const contaminationChunks = agg ? asNum(agg.contamination_chunks) : 0;
    const headingLikeParagraphChunks = agg ? asNum(agg.heading_like_paragraph_chunks) : 0;

    const fallbackUsed = doc.extraction_method === 'ocr' || doc.extraction_method === 'native_pdfjs';
    const ocrUsed = doc.ocr_used === true;

    const scores = scoreFailurePatterns({
      sourceType: doc.source_type,
      qualityReasons: doc.quality_reasons ?? [],
      chunkCount: totalChunks,
      headingChunks,
      listChunks,
      tableChunks,
      nullTitleRatio,
      brokenStructureChunks,
      shortFragmentNoiseChunks,
      tableNoiseChunks,
      ocrGarbageChunks,
      metadataBlockChunks,
      contaminationChunks,
      headingLikeParagraphChunks,
      fallbackUsed,
      ocrUsed,
    });

    const dominantFailure = dominantCategory(scores);
    categoryCounts[dominantFailure] += 1;

    const family = inferFamily(doc.title);
    familyCounts[family] = (familyCounts[family] ?? 0) + 1;

    return {
      id: doc.id,
      title: doc.title,
      source_path: doc.source_path,
      source_type: doc.source_type,
      current_quality_reasons: doc.quality_reasons ?? [],
      quality_tier: doc.quality_tier,
      text_quality_score: doc.text_quality_score ?? null,
      excluded_ratio: doc.excluded_ratio,
      heading_quality_indicators: {
        heading_chunk_count: headingChunks,
        heading_chunk_ratio: Number(safeRatio(headingChunks, Math.max(totalChunks, 1)).toFixed(4)),
        heading_like_paragraph_chunks: headingLikeParagraphChunks,
        weak_heading_signal: headingChunks === 0 || headingLikeParagraphChunks >= 2,
      },
      section_boundary_quality_indicators: {
        broken_structure_chunks: brokenStructureChunks,
        short_fragment_noise_chunks: shortFragmentNoiseChunks,
        null_section_title_chunks: nullSectionTitleChunks,
        null_section_title_ratio: Number(nullTitleRatio.toFixed(4)),
      },
      chunk_density: {
        chunk_count: totalChunks,
        included_chunk_count: totalChunks - excludedChunks,
        excluded_chunk_count: excludedChunks,
        avg_chunk_tokens: Number(avgChunkTokens.toFixed(2)),
      },
      ocr_and_fallback: {
        ocr_used: ocrUsed,
        fallback_used: fallbackUsed,
        extraction_method: doc.extraction_method ?? null,
        ocr_garbage_chunks: ocrGarbageChunks,
        contamination_chunks: contaminationChunks,
      },
      table_and_layout_signals: {
        table_chunks: tableChunks,
        list_chunks: listChunks,
        table_noise_chunks: tableNoiseChunks,
        metadata_block_chunks: metadataBlockChunks,
      },
      dominant_structural_failure_pattern: dominantFailure,
      failure_score_vector: scores,
      likely_family: family,
      likely_inherently_messy:
        (totalChunks <= 4 && (fallbackUsed || ocrUsed))
        || (ocrGarbageChunks >= 2 && doc.text_quality_score != null && doc.text_quality_score < 0.55),
    };
  });

  const avgExcludedRatio =
    perDocument.length > 0
      ? Number((perDocument.reduce((sum, d) => sum + d.excluded_ratio, 0) / perDocument.length).toFixed(4))
      : 0;

  const topFamilies = Object.entries(familyCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([family, count]) => ({ family, count }));

  const topFailureCategories = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => ({ category, count }));

  const narrowFixable = topFailureCategories
    .filter(({ category }) => [
      'weak_heading_detection',
      'broken_section_boundary',
      'split_procedure_fragment',
      'footer_header_body_mix',
      'table_schema_loss',
    ].includes(category))
    .slice(0, 3)
    .map((x) => x.category);

  const messyDocs = perDocument
    .filter((d) => d.likely_inherently_messy)
    .map((d) => ({ id: d.id, title: d.title, dominant_failure: d.dominant_structural_failure_pattern }));

  const artifact = {
    generated_at: new Date().toISOString(),
    cohort_definition: lockedSet.size > 0
      ? `Fixed cohort from ${cohortFrom} (matched by source_path)`
      : `Top ${cohortSize} active Partial docs by excluded ratio after pass 2`,
    cohort_size: perDocument.length,
    summary: {
      avg_excluded_ratio: avgExcludedRatio,
      high_excluded_doc_count: perDocument.filter((d) => d.excluded_ratio >= 0.25).length,
      top_residual_document_families: topFamilies,
      top_structural_failure_categories: topFailureCategories,
      most_fixable_narrow_categories: narrowFixable,
      likely_inherently_messy_docs: messyDocs,
    },
    per_document: perDocument,
  };

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  console.log(`[structural-analysis] Wrote: ${outputPath}`);
  console.log(`[structural-analysis] Cohort: ${artifact.cohort_size}`);
  console.log(`[structural-analysis] Avg excluded ratio: ${artifact.summary.avg_excluded_ratio}`);
  console.log(`[structural-analysis] Fixable categories: ${artifact.summary.most_fixable_narrow_categories.join(', ')}`);
}

main()
  .catch((err) => {
    console.error('[structural-analysis] Error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });