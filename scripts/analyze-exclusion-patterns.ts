import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import sql from '../src/lib/db';

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.local' });

type Row = Record<string, unknown>;

type ExclusionCategory =
  | 'table_reference'
  | 'table_noise'
  | 'short_procedure'
  | 'short_fragment_noise'
  | 'duplicate_boilerplate'
  | 'ocr_garbage'
  | 'broken_structure'
  | 'metadata_block'
  | 'list_reference'
  | 'diagram_caption';

function getArgValue(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

const PROCEDURE_VERBS = /\b(open|select|enter|click|run|verify|check|start|stop|load|save|submit|record|confirm|navigate)\b/i;
const NUMBERED_STEP = /^\s*(\d+[.)]|step\s+\d+|[-*•])\s+/im;
const TABLE_DELIMS = /[|\t,;]/;
const DOMAIN_TERMS = /\b(code|setting|parameter|calibration|program|lookup|result|method|test|limit|range|unit)\b/i;
const GARBAGE = /([\uFFFD]{2,}|\b(?:[0OIl]{8,}|x{6,}|\?{4,})\b)/i;

function safeString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function tokenCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

function classifyExcludedChunk(chunk: {
  section_type: string;
  content: string;
  normalisation_reason: Record<string, unknown> | null;
  is_boilerplate: boolean;
  ocr_used: boolean;
}): ExclusionCategory {
  const sectionType = chunk.section_type;
  const content = chunk.content || '';
  const reason = chunk.normalisation_reason || {};
  const reasonText = JSON.stringify(reason).toLowerCase();
  const tokens = tokenCount(content);

  if (chunk.ocr_used && (GARBAGE.test(content) || tokens <= 3)) return 'ocr_garbage';

  if (sectionType === 'boilerplate' || chunk.is_boilerplate || reasonText.includes('duplicate_within_document') || reasonText.includes('rule_pattern') || reasonText.includes('corpus_frequency')) {
    return 'duplicate_boilerplate';
  }

  if (sectionType === 'metadata_only' || sectionType === 'footer_header' || sectionType === 'revision_history' || reasonText.includes('metadata')) {
    return 'metadata_block';
  }

  if (sectionType === 'table') {
    const hasReferenceSignals = DOMAIN_TERMS.test(content) || TABLE_DELIMS.test(content) || /\b(code|parameter|unit|result)\b/i.test(content);
    return hasReferenceSignals ? 'table_reference' : 'table_noise';
  }

  if (sectionType === 'list' || content.trim().startsWith('-') || content.trim().startsWith('•')) {
    if (DOMAIN_TERMS.test(content) || tokens >= 6) return 'list_reference';
  }

  if (NUMBERED_STEP.test(content) && PROCEDURE_VERBS.test(content)) {
    return 'short_procedure';
  }

  if (tokens <= 12) {
    if (PROCEDURE_VERBS.test(content)) return 'short_procedure';
    if (reasonText.includes('short_content_isolated')) return 'short_fragment_noise';
  }

  if (reasonText.includes('short_content_isolated') || reasonText.includes('merged_with')) {
    return 'broken_structure';
  }

  if (/\b(figure|diagram|caption)\b/i.test(content)) {
    return 'diagram_caption';
  }

  return 'short_fragment_noise';
}

function familyFromTitle(title: string): string {
  const m = title.match(/^([A-Z]{2,4}[\s-]*\d{3})/i);
  if (m) return m[1].replace(/\s+/g, ' ').toUpperCase();
  const n = title.match(/^([A-Z]{2,4})\b/i);
  return n ? n[1].toUpperCase() : 'OTHER';
}

async function main() {
  const idsFrom = getArgValue('--ids-from');
  const outArg = getArgValue('--output');

  let ids: string[] = [];
  if (idsFrom) {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), idsFrom), 'utf8')) as {
      per_document?: Array<{ id: string }>;
    };
    ids = (parsed.per_document ?? []).map((d) => String(d.id));
  }

  const top20 = ids.length > 0
    ? await sql<Row[]>`
        WITH cohort_sources AS (
          SELECT DISTINCT source_path
          FROM documents
          WHERE id::text IN ${sql(ids)}
        )
        SELECT
          d.id,
          d.title,
          d.source_type,
          d.chunk_count,
          d.excluded_chunk_count,
          (d.chunk_count - d.excluded_chunk_count) AS included_chunks,
          round((d.excluded_chunk_count::numeric / nullif(d.chunk_count, 0)::numeric), 4) AS excluded_ratio
        FROM documents d
        JOIN cohort_sources s ON s.source_path = d.source_path
        WHERE d.is_active = true
        ORDER BY d.title ASC
      `
    : await sql<Row[]>`
        SELECT
          d.id,
          d.title,
          d.source_type,
          d.chunk_count,
          d.excluded_chunk_count,
          (d.chunk_count - d.excluded_chunk_count) AS included_chunks,
          round((d.excluded_chunk_count::numeric / nullif(d.chunk_count, 0)::numeric), 4) AS excluded_ratio
        FROM documents d
        WHERE d.is_active = true
          AND d.text_quality_tier = 'partial'
          AND d.chunk_count > 0
          AND (d.excluded_chunk_count::numeric / d.chunk_count::numeric) >= 0.25
        ORDER BY (d.excluded_chunk_count::numeric / d.chunk_count::numeric) DESC,
                 d.excluded_chunk_count DESC,
                 d.title ASC
        LIMIT 20
      `;

  const selectedDocIds = top20.map((d) => String(d.id));
  if (ids.length === 0) {
    ids = selectedDocIds;
  }

  const excludedChunks = await sql<Row[]>`
    SELECT
      c.document_id::text AS document_id,
      coalesce(c.section_type, 'unknown') AS section_type,
      c.content,
      c.normalisation_reason,
      c.is_boilerplate,
      d.ocr_used,
      d.source_type,
      d.title
    FROM chunks c
    JOIN documents d ON d.id = c.document_id
    WHERE c.retrieval_excluded = true
      AND c.document_id::text IN ${sql(selectedDocIds)}
  `;

  const byDoc = new Map<string, { title: string; source_type: string; categories: Record<string, number>; section_types: Record<string, number> }>();
  const categoryTotals: Record<string, number> = {};
  const familyTotals: Record<string, number> = {};

  for (const row of excludedChunks) {
    const docId = String(row.document_id);
    const title = safeString(row.title);
    const sourceType = safeString(row.source_type);
    const sectionType = safeString(row.section_type) || 'unknown';

    const category = classifyExcludedChunk({
      section_type: sectionType,
      content: safeString(row.content),
      normalisation_reason: (row.normalisation_reason as Record<string, unknown> | null) ?? null,
      is_boilerplate: Boolean(row.is_boilerplate),
      ocr_used: Boolean(row.ocr_used),
    });

    if (!byDoc.has(docId)) {
      byDoc.set(docId, { title, source_type: sourceType, categories: {}, section_types: {} });
    }

    const agg = byDoc.get(docId)!;
    agg.categories[category] = (agg.categories[category] ?? 0) + 1;
    agg.section_types[sectionType] = (agg.section_types[sectionType] ?? 0) + 1;

    categoryTotals[category] = (categoryTotals[category] ?? 0) + 1;

    const family = familyFromTitle(title);
    familyTotals[family] = (familyTotals[family] ?? 0) + 1;
  }

  const perDoc = top20.map((d) => {
    const id = String(d.id);
    const agg = byDoc.get(id);
    const dominantExclusions = Object.entries(agg?.categories ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([category, count]) => ({ category, count }));

    return {
      id,
      title: safeString(d.title),
      source_type: safeString(d.source_type),
      total_chunks: Number(d.chunk_count ?? 0),
      included_chunks: Number(d.included_chunks ?? 0),
      excluded_chunks: Number(d.excluded_chunk_count ?? 0),
      excluded_ratio: Number(d.excluded_ratio ?? 0),
      dominant_exclusion_patterns: dominantExclusions,
      section_type_breakdown: Object.entries(agg?.section_types ?? {}).sort((a, b) => b[1] - a[1]).map(([section_type, count]) => ({ section_type, count })),
    };
  });

  const topFamilies = Object.entries(familyTotals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([family, excluded_chunks]) => ({ family, excluded_chunks }));

  const topCategories = Object.entries(categoryTotals)
    .sort((a, b) => b[1] - a[1])
    .map(([category, excluded_chunks]) => ({ category, excluded_chunks }));

  const appearsOverExcluded = ['short_procedure', 'table_reference', 'list_reference', 'broken_structure'];
  const appearsCorrectlyExcluded = ['duplicate_boilerplate', 'ocr_garbage', 'metadata_block', 'table_noise', 'short_fragment_noise', 'diagram_caption'];

  const report = {
    generated_at: new Date().toISOString(),
    cohort_definition: idsFrom
      ? 'Fixed cohort from --ids-from artifact'
      : 'Top 20 active Partial docs with High excluded chunk ratio',
    cohort_size: top20.length,
    per_document: perDoc,
    top_affected_document_families: topFamilies,
    top_exclusion_categories: topCategories,
    interpretation: {
      appears_over_excluded_categories: appearsOverExcluded,
      appears_correctly_excluded_categories: appearsCorrectlyExcluded,
    },
  };

  const outPath = path.join(
    process.cwd(),
    outArg || 'docs/reports/2026-04-20-live-validation/partial-exclusion-category-analysis-before-tuning.json',
  );
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ outPath, cohort_size: top20.length }, null, 2));

  await sql.end({ timeout: 2 });
}

main().catch(async (err) => {
  console.error(err);
  await sql.end({ timeout: 2 });
  process.exit(1);
});
