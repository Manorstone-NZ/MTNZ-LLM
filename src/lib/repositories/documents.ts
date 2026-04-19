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
    SELECT * FROM documents
    WHERE 1 = 1
      ${filters?.folder ? sql`AND folder = ${filters.folder}` : sql``}
      ${filters?.status ? sql`AND extraction_status = ${filters.status}` : sql``}
      ${filters?.type ? sql`AND source_type = ${filters.type}` : sql``}
    ORDER BY folder, title
  `;
  return rows;
}

export async function getHealthMetrics(): Promise<HealthMetrics> {
  const [counts] = await sql<
    {
      total_active: string;
      total_inactive: string;
      total_failed: string;
      total_chunks: string;
      zero_text_docs: string;
      avg_chunks: string;
      source_missing_count: string;
      ocr_used_count: string;
      quarantined_count: string;
      needs_review_count: string;
      quality_good: string;
      quality_partial: string;
      quality_poor: string;
      fallback_extraction_count: string;
      excluded_chunks_total: string;
      docs_with_structural_headings: string;
    }[]
  >`
    SELECT
      count(*) FILTER (WHERE is_active = true) AS total_active,
      count(*) FILTER (WHERE is_active = false) AS total_inactive,
      count(*) FILTER (WHERE extraction_status = 'failed') AS total_failed,
      coalesce(sum(chunk_count) FILTER (WHERE is_active = true), 0) AS total_chunks,
      count(*) FILTER (WHERE chunk_count = 0 AND extraction_status = 'completed') AS zero_text_docs,
      coalesce(avg(chunk_count) FILTER (WHERE is_active = true AND chunk_count > 0), 0) AS avg_chunks,
      count(*) FILTER (WHERE source_missing = true) AS source_missing_count,
      count(*) FILTER (WHERE ocr_used = true) AS ocr_used_count,
      count(*) FILTER (WHERE quarantined = true AND is_active = true) AS quarantined_count,
      count(*) FILTER (WHERE needs_review = true AND is_active = true) AS needs_review_count,
      count(*) FILTER (WHERE text_quality_tier = 'good' AND is_active = true) AS quality_good,
      count(*) FILTER (WHERE text_quality_tier = 'partial' AND is_active = true) AS quality_partial,
      count(*) FILTER (WHERE text_quality_tier = 'poor' AND is_active = true) AS quality_poor,
      count(*) FILTER (WHERE is_active = true AND extraction_method IN ('ocr', 'native_pdfjs')) AS fallback_extraction_count,
      coalesce(sum(excluded_chunk_count) FILTER (WHERE is_active = true), 0) AS excluded_chunks_total,
      (
        SELECT count(DISTINCT c.document_id)
        FROM chunks c
        JOIN documents d2 ON d2.id = c.document_id
        WHERE d2.is_active = true
          AND c.section_type = 'appendix'
      ) AS docs_with_structural_headings
    FROM documents
  `;

  const [lastRun] = await sql<{ started_at: string | null }[]>`
    SELECT started_at FROM ingest_runs
    ORDER BY started_at DESC
    LIMIT 1
  `;

  const [dbSize] = await sql<{ size_mb: string }[]>`
    SELECT round(pg_database_size('idd_knowledge') / 1048576.0, 2) AS size_mb
  `;

  const totalActive = Number(counts.total_active);
  const totalChunks = Number(counts.total_chunks);
  const fallbackCount = Number(counts.fallback_extraction_count);
  const excludedChunksTotal = Number(counts.excluded_chunks_total);

  return {
    total_active: totalActive,
    total_inactive: Number(counts.total_inactive),
    total_failed: Number(counts.total_failed),
    total_chunks: totalChunks,
    zero_text_docs: Number(counts.zero_text_docs),
    avg_chunks_per_doc: Number(Number(counts.avg_chunks).toFixed(1)),
    last_ingest_run: lastRun?.started_at ?? null,
    embedding_model: process.env.EMBEDDING_MODEL ?? 'unknown',
    db_size_mb: Number(dbSize.size_mb),
    source_missing_count: Number(counts.source_missing_count),
    ocr_used_count: Number(counts.ocr_used_count),
    quarantined_count: Number(counts.quarantined_count),
    needs_review_count: Number(counts.needs_review_count),
    quality_good: Number(counts.quality_good),
    quality_partial: Number(counts.quality_partial),
    quality_poor: Number(counts.quality_poor),
    fallback_extraction_count: fallbackCount,
    fallback_extraction_percent: totalActive > 0
      ? Number(((fallbackCount / totalActive) * 100).toFixed(1))
      : 0,
    excluded_chunks_total: excludedChunksTotal,
    excluded_chunk_percent: totalChunks > 0
      ? Number(((excludedChunksTotal / totalChunks) * 100).toFixed(1))
      : 0,
    docs_with_structural_headings: Number(counts.docs_with_structural_headings),
  };
}
