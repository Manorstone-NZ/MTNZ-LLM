import sql from '../db';
import type { DocumentRow, HealthMetrics } from '../types';

interface CreateDocumentInput {
  title: string;
  filename: string;
  source_path: string;
  folder: string;
  source_type: string;
  version_hash: string;
  // V2 fields
  pipeline_version?: string;
  extraction_method?: string | null;
  text_quality_score?: number | null;
  text_quality_tier?: 'good' | 'partial' | 'poor' | null;
  quality_score_source?: 'native_extraction' | 'ocr_output' | null;
  needs_review?: boolean;
  quarantined?: boolean;
}

export async function createDocument(doc: CreateDocumentInput): Promise<DocumentRow> {
  const [row] = await sql<DocumentRow[]>`
    INSERT INTO documents (
      title, filename, source_path, folder, source_type, version_hash,
      search_text, title_normalized,
      pipeline_version, extraction_method, text_quality_score, text_quality_tier,
      quality_score_source, needs_review, quarantined
    )
    VALUES (
      ${doc.title},
      ${doc.filename},
      ${doc.source_path},
      ${doc.folder},
      ${doc.source_type},
      ${doc.version_hash},
      setweight(to_tsvector('english', ${doc.title}), 'A') ||
      setweight(to_tsvector('english', ${doc.filename}), 'A') ||
      setweight(to_tsvector('english', ${doc.folder}), 'B'),
      lower(regexp_replace(${doc.title}, '[^a-zA-Z0-9 ]', '', 'g')),
      ${doc.pipeline_version ?? 'v2'},
      ${doc.extraction_method ?? null},
      ${doc.text_quality_score ?? null},
      ${doc.text_quality_tier ?? null},
      ${doc.quality_score_source ?? null},
      ${doc.needs_review ?? false},
      ${doc.quarantined ?? false}
    )
    RETURNING *
  `;
  return row;
}

export async function findActiveBySourcePath(sourcePath: string): Promise<DocumentRow | undefined> {
  const [row] = await sql<DocumentRow[]>`
    SELECT * FROM documents
    WHERE source_path = ${sourcePath}
      AND is_active = true
    LIMIT 1
  `;
  return row;
}

export async function deactivateDocument(id: string): Promise<void> {
  await sql`
    UPDATE documents
    SET is_active = false,
        superseded_at = now(),
        updated_at = now()
    WHERE id = ${id}
  `;
}

export async function markSourceMissing(id: string): Promise<void> {
  await sql`
    UPDATE documents
    SET source_missing = true,
        updated_at = now()
    WHERE id = ${id}
  `;
}

export async function updateExtractionStatus(
  id: string,
  status: string,
  error?: string
): Promise<void> {
  await sql`
    UPDATE documents
    SET extraction_status = ${status},
        extraction_error = ${error ?? null},
        updated_at = now()
    WHERE id = ${id}
  `;
}

export async function updateChunkCount(id: string, count: number): Promise<void> {
  await sql`
    UPDATE documents
    SET chunk_count = ${count},
        updated_at = now()
    WHERE id = ${id}
  `;
}

export async function markCompleted(id: string): Promise<void> {
  await sql`
    UPDATE documents
    SET extraction_status = 'completed',
        processed_at = now(),
        updated_at = now()
    WHERE id = ${id}
  `;
}

export async function updateDocumentNormStats(id: string, stats: {
  excluded_chunk_count: number;
  boilerplate_chunk_count: number;
  downranked_chunk_count: number;
}): Promise<void> {
  await sql`
    UPDATE documents
    SET excluded_chunk_count = ${stats.excluded_chunk_count},
        boilerplate_chunk_count = ${stats.boilerplate_chunk_count},
        downranked_chunk_count = ${stats.downranked_chunk_count},
        updated_at = now()
    WHERE id = ${id}
  `;
}

export async function setQuarantined(id: string): Promise<void> {
  await sql`
    UPDATE documents
    SET quarantined = true,
        updated_at = now()
    WHERE id = ${id}
  `;
}

export async function updateCompletenessAudit(
  id: string,
  status: 'unknown' | 'complete' | 'partial' | 'suspect',
  score: number,
  reasons: string[],
  missingReferencedAppendices: string[],
): Promise<void> {
  await sql`
    UPDATE documents
    SET extraction_completeness_status = ${status},
        extraction_completeness_score = ${score},
        extraction_completeness_reasons = ${sql.json(reasons)},
        missing_referenced_appendices = ${sql.json(missingReferencedAppendices)},
        completeness_last_audited_at = now(),
        updated_at = now()
    WHERE id = ${id}
  `;
}

export async function getDocumentInventory(
  filters?: { folder?: string; status?: string; type?: string }
): Promise<DocumentRow[]> {
  const rows = await sql<DocumentRow[]>`
    WITH chunk_signals AS (
      SELECT
        c.document_id,
        count(*) FILTER (WHERE c.section_type = 'heading')  AS heading_chunk_count,
        count(*) FILTER (WHERE c.section_type = 'table')    AS table_chunk_count,
        count(*) FILTER (WHERE c.section_type = 'appendix') AS appendix_chunk_count,
        count(*) FILTER (WHERE c.section_type = 'list')     AS list_chunk_count
      FROM chunks c
      GROUP BY c.document_id
    ),
    ranked AS (
      SELECT
        d.*,
        coalesce(cs.heading_chunk_count, 0)  AS heading_chunk_count,
        coalesce(cs.table_chunk_count, 0)    AS table_chunk_count,
        coalesce(cs.appendix_chunk_count, 0) AS appendix_chunk_count,
        coalesce(cs.list_chunk_count, 0)     AS list_chunk_count,
        row_number() OVER (
          PARTITION BY d.source_path
          ORDER BY d.created_at DESC, d.updated_at DESC, d.id DESC
        ) = 1 AS is_latest_version
      FROM documents d
      LEFT JOIN chunk_signals cs ON cs.document_id = d.id
    )
    SELECT * FROM ranked
    WHERE 1 = 1
      ${filters?.folder ? sql`AND folder = ${filters.folder}` : sql``}
      ${filters?.status ? sql`AND extraction_status = ${filters.status}` : sql``}
      ${filters?.type ? sql`AND source_type = ${filters.type}` : sql``}
    ORDER BY is_active DESC, is_latest_version DESC, folder, title, created_at DESC
  `;
  return rows;
}

export async function getHealthMetrics(): Promise<HealthMetrics> {
  const [counts] = await sql<
    {
      active_docs: string;
      inactive_versions: string;
      active_completed: string;
      active_pending: string;
      active_failed: string;
      historical_failed: string;
      active_chunks_total: string;
      active_zero_text_docs: string;
      active_avg_chunks_per_doc: string;
      active_source_missing: string;
      active_ocr_used: string;
      active_quarantined: string;
      active_needs_review: string;
      active_good: string;
      active_partial: string;
      active_poor: string;
      active_unclassified: string;
      active_fallback_extractions: string;
      active_excluded_chunks_total: string;
      active_docs_with_structural_headings: string;
    }[]
  >`
    SELECT
      -- Active corpus counts (is_active = true)
      count(*) FILTER (WHERE is_active = true)                                               AS active_docs,
      count(*) FILTER (WHERE is_active = false)                                              AS inactive_versions,
      count(*) FILTER (WHERE extraction_status = 'completed' AND is_active = true)          AS active_completed,
      count(*) FILTER (WHERE extraction_status = 'pending'   AND is_active = true)          AS active_pending,
      count(*) FILTER (WHERE extraction_status = 'failed'    AND is_active = true)          AS active_failed,
      -- Historical failed = inactive docs that are in failed state (not active corpus)
      count(*) FILTER (WHERE extraction_status = 'failed'    AND is_active = false)         AS historical_failed,
      -- Chunk metrics (active only)
      coalesce(sum(chunk_count) FILTER (WHERE is_active = true), 0)                         AS active_chunks_total,
      count(*) FILTER (WHERE chunk_count = 0 AND extraction_status = 'completed'
                       AND is_active = true)                                                 AS active_zero_text_docs,
      coalesce(avg(chunk_count) FILTER (WHERE is_active = true AND chunk_count > 0), 0)     AS active_avg_chunks_per_doc,
      -- Source/OCR (active only)
      count(*) FILTER (WHERE source_missing = true AND is_active = true)                    AS active_source_missing,
      count(*) FILTER (WHERE ocr_used = true       AND is_active = true)                    AS active_ocr_used,
      -- Quality (active only)
      count(*) FILTER (WHERE quarantined = true    AND is_active = true)                    AS active_quarantined,
      count(*) FILTER (WHERE needs_review = true   AND is_active = true)                    AS active_needs_review,
      count(*) FILTER (WHERE text_quality_tier = 'good'    AND is_active = true)            AS active_good,
      count(*) FILTER (WHERE text_quality_tier = 'partial' AND is_active = true)            AS active_partial,
      count(*) FILTER (WHERE text_quality_tier = 'poor'    AND is_active = true)            AS active_poor,
      count(*) FILTER (WHERE text_quality_tier IS NULL     AND is_active = true)            AS active_unclassified,
      -- Fallback extraction = active docs where native parse failed/timed out and fallback path was used
      count(*) FILTER (WHERE is_active = true
                       AND extraction_method IN ('ocr', 'native_pdfjs'))                    AS active_fallback_extractions,
      coalesce(sum(excluded_chunk_count) FILTER (WHERE is_active = true), 0)               AS active_excluded_chunks_total,
      (
        SELECT count(DISTINCT c.document_id)
        FROM chunks c
        JOIN documents d2 ON d2.id = c.document_id
        WHERE d2.is_active = true
          AND c.section_type = 'appendix'
      ) AS active_docs_with_structural_headings
    FROM documents
  `;

  const [lastRun] = await sql<{ started_at: string | null }[]>`
    SELECT started_at FROM ingest_runs
    ORDER BY started_at DESC
    LIMIT 1
  `;

  const [dbSize] = await sql<{ size_mb: string }[]>`
    SELECT round(pg_database_size(current_database()) / 1048576.0, 2) AS size_mb
  `;

  const activeDocs = Number(counts.active_docs);
  const inactiveVersions = Number(counts.inactive_versions);
  const activeChunksTotal = Number(counts.active_chunks_total);
  const activeFallbackExtractions = Number(counts.active_fallback_extractions);
  const activeExcludedChunksTotal = Number(counts.active_excluded_chunks_total);
  const activeGood = Number(counts.active_good);
  const activePartial = Number(counts.active_partial);
  const activePoor = Number(counts.active_poor);
  const activeUnclassified = Number(counts.active_unclassified);
  const qualityTotal = activeGood + activePartial + activePoor + activeUnclassified;
  const totalDocumentVersions = activeDocs + inactiveVersions;

  return {
    active_docs: activeDocs,
    active_completed: Number(counts.active_completed),
    active_pending: Number(counts.active_pending),
    active_failed: Number(counts.active_failed),
    active_needs_review: Number(counts.active_needs_review),
    active_chunks_total: activeChunksTotal,
    active_ocr_used: Number(counts.active_ocr_used),
    active_fallback_extractions: activeFallbackExtractions,

    inactive_versions: inactiveVersions,
    historical_failed: Number(counts.historical_failed),

    active_good: activeGood,
    active_partial: activePartial,
    active_poor: activePoor,
    active_unclassified: activeUnclassified,

    active_quarantined: Number(counts.active_quarantined),
    active_source_missing: Number(counts.active_source_missing),
    active_zero_text_docs: Number(counts.active_zero_text_docs),
    active_avg_chunks_per_doc: Number(Number(counts.active_avg_chunks_per_doc).toFixed(1)),
    active_fallback_extraction_percent: activeDocs > 0
      ? Number(((activeFallbackExtractions / activeDocs) * 100).toFixed(1))
      : 0,
    active_excluded_chunks_total: activeExcludedChunksTotal,
    active_excluded_chunk_percent: activeChunksTotal > 0
      ? Number(((activeExcludedChunksTotal / activeChunksTotal) * 100).toFixed(1))
      : 0,
    active_docs_with_structural_headings: Number(counts.active_docs_with_structural_headings),

    total_document_versions: totalDocumentVersions,
    last_ingest_run: lastRun?.started_at ?? null,
    embedding_model: process.env.EMBEDDING_MODEL ?? 'unknown',
    db_size_mb: Number(dbSize.size_mb),

    diagnostics: {
      quality_total: qualityTotal,
      active_docs: activeDocs,
      quality_reconciles: qualityTotal === activeDocs,
      total_versions: totalDocumentVersions,
      active_plus_inactive_reconciles: activeDocs + inactiveVersions === totalDocumentVersions,
    },
    metric_audit: {
      active_docs: { source: 'documents', scope: 'active_only', filter: 'is_active = true' },
      active_completed: { source: 'documents', scope: 'active_only', filter: "is_active = true AND extraction_status = 'completed'" },
      active_pending: { source: 'documents', scope: 'active_only', filter: "is_active = true AND extraction_status = 'pending'" },
      active_failed: { source: 'documents', scope: 'active_only', filter: "is_active = true AND extraction_status = 'failed'" },
      active_needs_review: { source: 'documents', scope: 'active_only', filter: 'is_active = true AND needs_review = true' },
      active_chunks_total: { source: 'documents', scope: 'active_only', filter: 'is_active = true (sum chunk_count)' },
      active_ocr_used: { source: 'documents', scope: 'active_only', filter: 'is_active = true AND ocr_used = true' },
      active_fallback_extractions: { source: 'documents', scope: 'active_only', filter: "is_active = true AND extraction_method IN ('ocr','native_pdfjs')" },
      inactive_versions: { source: 'documents', scope: 'historical_only', filter: 'is_active = false' },
      historical_failed: { source: 'documents', scope: 'historical_only', filter: "is_active = false AND extraction_status = 'failed'" },
      active_good: { source: 'documents', scope: 'active_only', filter: "is_active = true AND text_quality_tier = 'good'" },
      active_partial: { source: 'documents', scope: 'active_only', filter: "is_active = true AND text_quality_tier = 'partial'" },
      active_poor: { source: 'documents', scope: 'active_only', filter: "is_active = true AND text_quality_tier = 'poor'" },
      active_unclassified: { source: 'documents', scope: 'active_only', filter: 'is_active = true AND text_quality_tier IS NULL' },
      total_document_versions: { source: 'documents', scope: 'all_versions', filter: 'active_docs + inactive_versions' },
    },
  };
}
