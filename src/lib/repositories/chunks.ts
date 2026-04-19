import sql from '../db';
import type { PreparedChunk, ScoredChunk } from '../types';

/** Safely extract section_type_confidence from a chunk (may not be on the interface). */
function getConfidence(chunk: PreparedChunk): number {
  return (chunk as unknown as { section_type_confidence?: number }).section_type_confidence ?? 0;
}

/** Safely serialize normalisation_reason to JSON for postgres. */
function jsonOrNull(val: Record<string, unknown> | null | undefined) {
  return val ? sql.json(val as Record<string, string | number | boolean | null>) : null;
}

export async function insertChunks(
  documentId: string,
  chunks: PreparedChunk[]
): Promise<void> {
  const BATCH_SIZE = 50;

  await sql.begin(async (tx) => {
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);

      for (const chunk of batch) {
        await tx`
          INSERT INTO chunks (
            document_id, content, content_preview, chunk_index, chunk_hash,
            token_count, page_number, section_title, sheet_name, range_ref,
            citation_label, metadata, search_text,
            section_type, section_type_confidence,
            is_boilerplate, retrieval_excluded, retrieval_downranked,
            boilerplate_hash, normalisation_reason, embedding_status
          ) VALUES (
            ${documentId},
            ${chunk.content},
            ${chunk.content_preview},
            ${chunk.chunk_index},
            ${chunk.chunk_hash},
            ${chunk.token_count},
            ${chunk.page_number},
            ${chunk.section_title},
            ${chunk.sheet_name},
            ${chunk.range_ref},
            ${chunk.citation_label},
            ${sql.json(chunk.metadata as Record<string, string | number | boolean | null>)},
            setweight(to_tsvector('english', coalesce(${chunk.citation_label}, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(${chunk.section_title}, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(${chunk.sheet_name}, '')), 'B') ||
            setweight(to_tsvector('english', ${chunk.content}), 'C'),
            ${chunk.section_type ?? null},
            ${getConfidence(chunk)},
            ${chunk.is_boilerplate ?? false},
            ${chunk.retrieval_excluded ?? false},
            ${chunk.retrieval_downranked ?? false},
            ${chunk.boilerplate_hash ?? null},
            ${jsonOrNull(chunk.normalisation_reason)},
            ${chunk.embedding_status ?? 'pending'}
          )
        `;
      }
    }
  });
}

/**
 * Insert chunks with embeddings. Handles two cases:
 * 1. Chunks with embeddings (retrieval_excluded=false, embedding_status='embedded')
 * 2. Chunks without embeddings (retrieval_excluded=true, embedding_status='skipped_excluded', embedding=NULL)
 *
 * For v2 pipeline, use insertChunksV2 which handles both cases in one call.
 */
export async function insertChunksWithEmbeddings(
  documentId: string,
  chunks: PreparedChunk[],
  embeddings: number[][]
): Promise<void> {
  const BATCH_SIZE = 50;

  await sql.begin(async (tx) => {
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const batchEmbeddings = embeddings.slice(i, i + BATCH_SIZE);

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const embeddingVector = `[${batchEmbeddings[j].join(',')}]`;

        await tx`
          INSERT INTO chunks (
            document_id, content, content_preview, chunk_index, chunk_hash,
            token_count, page_number, section_title, sheet_name, range_ref,
            citation_label, metadata, search_text, embedding,
            section_type, section_type_confidence,
            is_boilerplate, retrieval_excluded, retrieval_downranked,
            boilerplate_hash, normalisation_reason, embedding_status
          ) VALUES (
            ${documentId},
            ${chunk.content},
            ${chunk.content_preview},
            ${chunk.chunk_index},
            ${chunk.chunk_hash},
            ${chunk.token_count},
            ${chunk.page_number},
            ${chunk.section_title},
            ${chunk.sheet_name},
            ${chunk.range_ref},
            ${chunk.citation_label},
            ${sql.json(chunk.metadata as Record<string, string | number | boolean | null>)},
            setweight(to_tsvector('english', coalesce(${chunk.citation_label}, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(${chunk.section_title}, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(${chunk.sheet_name}, '')), 'B') ||
            setweight(to_tsvector('english', ${chunk.content}), 'C'),
            ${embeddingVector}::vector,
            ${chunk.section_type ?? null},
            ${getConfidence(chunk)},
            ${chunk.is_boilerplate ?? false},
            ${chunk.retrieval_excluded ?? false},
            ${chunk.retrieval_downranked ?? false},
            ${chunk.boilerplate_hash ?? null},
            ${jsonOrNull(chunk.normalisation_reason)},
            ${'embedded'}
          )
        `;
      }
    }
  });
}

/**
 * Insert a mix of embedded and excluded chunks in one transaction.
 * - embeddedChunks: chunks with embeddings (embedding_status='embedded')
 * - excludedChunks: chunks without embeddings (embedding_status='skipped_excluded', embedding=NULL)
 *
 * Enforces invariant: retrieval_excluded=true NEVER has embedding_status='embedded'.
 */
export async function insertChunksV2(
  documentId: string,
  embeddedChunks: PreparedChunk[],
  embeddings: number[][],
  excludedChunks: PreparedChunk[],
): Promise<void> {
  const BATCH_SIZE = 50;

  await sql.begin(async (tx) => {
    // Insert embedded chunks
    for (let i = 0; i < embeddedChunks.length; i += BATCH_SIZE) {
      const batch = embeddedChunks.slice(i, i + BATCH_SIZE);
      const batchEmbed = embeddings.slice(i, i + BATCH_SIZE);

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const embeddingVector = `[${batchEmbed[j].join(',')}]`;

        await tx`
          INSERT INTO chunks (
            document_id, content, content_preview, chunk_index, chunk_hash,
            token_count, page_number, section_title, sheet_name, range_ref,
            citation_label, metadata, search_text, embedding,
            section_type, section_type_confidence,
            is_boilerplate, retrieval_excluded, retrieval_downranked,
            boilerplate_hash, normalisation_reason, embedding_status
          ) VALUES (
            ${documentId},
            ${chunk.content},
            ${chunk.content_preview},
            ${chunk.chunk_index},
            ${chunk.chunk_hash},
            ${chunk.token_count},
            ${chunk.page_number},
            ${chunk.section_title},
            ${chunk.sheet_name},
            ${chunk.range_ref},
            ${chunk.citation_label},
            ${sql.json(chunk.metadata as Record<string, string | number | boolean | null>)},
            setweight(to_tsvector('english', coalesce(${chunk.citation_label}, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(${chunk.section_title}, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(${chunk.sheet_name}, '')), 'B') ||
            setweight(to_tsvector('english', ${chunk.content}), 'C'),
            ${embeddingVector}::vector,
            ${chunk.section_type ?? null},
            ${getConfidence(chunk)},
            ${chunk.is_boilerplate ?? false},
            ${false},
            ${chunk.retrieval_downranked ?? false},
            ${chunk.boilerplate_hash ?? null},
            ${jsonOrNull(chunk.normalisation_reason)},
            ${'embedded'}
          )
        `;
      }
    }

    // Insert excluded chunks (no embedding)
    for (let i = 0; i < excludedChunks.length; i += BATCH_SIZE) {
      const batch = excludedChunks.slice(i, i + BATCH_SIZE);

      for (const chunk of batch) {
        await tx`
          INSERT INTO chunks (
            document_id, content, content_preview, chunk_index, chunk_hash,
            token_count, page_number, section_title, sheet_name, range_ref,
            citation_label, metadata, search_text,
            section_type, section_type_confidence,
            is_boilerplate, retrieval_excluded, retrieval_downranked,
            boilerplate_hash, normalisation_reason, embedding_status
          ) VALUES (
            ${documentId},
            ${chunk.content},
            ${chunk.content_preview},
            ${chunk.chunk_index},
            ${chunk.chunk_hash},
            ${chunk.token_count},
            ${chunk.page_number},
            ${chunk.section_title},
            ${chunk.sheet_name},
            ${chunk.range_ref},
            ${chunk.citation_label},
            ${sql.json(chunk.metadata as Record<string, string | number | boolean | null>)},
            setweight(to_tsvector('english', coalesce(${chunk.citation_label}, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(${chunk.section_title}, '')), 'A') ||
            setweight(to_tsvector('english', coalesce(${chunk.sheet_name}, '')), 'B') ||
            setweight(to_tsvector('english', ${chunk.content}), 'C'),
            ${chunk.section_type ?? null},
            ${getConfidence(chunk)},
            ${chunk.is_boilerplate ?? false},
            ${true},
            ${chunk.retrieval_downranked ?? false},
            ${chunk.boilerplate_hash ?? null},
            ${jsonOrNull(chunk.normalisation_reason)},
            ${'skipped_excluded'}
          )
        `;
      }
    }
  });
}

export async function deleteChunksByDocumentId(documentId: string): Promise<void> {
  await sql`
    DELETE FROM chunks WHERE document_id = ${documentId}
  `;
}

export async function vectorSearch(
  embedding: number[],
  limit: number
): Promise<ScoredChunk[]> {
  const vectorLiteral = `[${embedding.join(',')}]`;

  const rows = await sql<ScoredChunk[]>`
    SELECT
      c.id,
      c.document_id,
      d.source_type,
      c.content,
      c.content_preview,
      c.citation_label,
      c.section_title,
      c.sheet_name,
      c.page_number,
      c.retrieval_downranked,
      d.title AS doc_title,
      d.folder,
      (1 - (c.embedding <=> ${vectorLiteral}::vector)) AS score,
      (1 - (c.embedding <=> ${vectorLiteral}::vector)) AS vector_score
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE d.is_active = true
      AND c.retrieval_excluded = false
      AND c.embedding_status = 'embedded'
    ORDER BY c.embedding <=> ${vectorLiteral}::vector
    LIMIT ${limit}
  `;

  return rows;
}

export async function fullTextSearch(
  query: string,
  limit: number,
  sectionRefs: string[] = [],
  documentRefs: string[] = []
): Promise<ScoredChunk[]> {
  const sectionLikePatterns = sectionRefs.map((ref) => `%${ref}%`);
  const docLikePatterns = documentRefs.map((ref) => `%${ref}%`);

  if (sectionLikePatterns.length > 0 || docLikePatterns.length > 0) {
    const rows = await sql<ScoredChunk[]>`
      SELECT
        c.id,
        c.document_id,
        d.source_type,
        c.content,
        c.content_preview,
        c.citation_label,
        c.section_title,
        c.sheet_name,
        c.page_number,
        c.retrieval_downranked,
        d.title AS doc_title,
        d.folder,
        ts_rank(c.search_text, plainto_tsquery('english', ${query})) AS score,
        ts_rank(c.search_text, plainto_tsquery('english', ${query})) AS fts_score
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE (
        c.search_text @@ plainto_tsquery('english', ${query})
        OR coalesce(c.section_title, '') ILIKE ANY(${sql.array(sectionLikePatterns)}::text[])
        OR d.title ILIKE ANY(${sql.array(docLikePatterns)}::text[])
      )
        AND d.is_active = true
        AND c.retrieval_excluded = false
      ORDER BY fts_score DESC
      LIMIT ${limit}
    `;

    return rows;
  }

  const rows = await sql<ScoredChunk[]>`
    SELECT
      c.id,
      c.document_id,
      d.source_type,
      c.content,
      c.content_preview,
      c.citation_label,
      c.section_title,
      c.sheet_name,
      c.page_number,
      c.retrieval_downranked,
      d.title AS doc_title,
      d.folder,
      ts_rank(c.search_text, plainto_tsquery('english', ${query})) AS score,
      ts_rank(c.search_text, plainto_tsquery('english', ${query})) AS fts_score
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE c.search_text @@ plainto_tsquery('english', ${query})
      AND d.is_active = true
      AND c.retrieval_excluded = false
    ORDER BY fts_score DESC
    LIMIT ${limit}
  `;

  return rows;
}

export async function trigramSearch(
  query: string,
  limit: number,
  sectionRefs: string[] = [],
  documentRefs: string[] = []
): Promise<ScoredChunk[]> {
  const sectionLikePatterns = sectionRefs.map((ref) => `%${ref}%`);
  const docLikePatterns = documentRefs.map((ref) => `%${ref}%`);

  if (sectionLikePatterns.length > 0 || docLikePatterns.length > 0) {
    const rows = await sql<ScoredChunk[]>`
      SELECT
        c.id,
        c.document_id,
        d.source_type,
        c.content,
        c.content_preview,
        c.citation_label,
        c.section_title,
        c.sheet_name,
        c.page_number,
        c.retrieval_downranked,
        d.title AS doc_title,
        d.folder,
        greatest(
          similarity(c.content, ${query}),
          similarity(c.citation_label, ${query}),
          similarity(coalesce(c.section_title, ''), ${query})
        ) AS score,
        greatest(
          similarity(c.content, ${query}),
          similarity(c.citation_label, ${query}),
          similarity(coalesce(c.section_title, ''), ${query})
        ) AS trigram_score
      FROM chunks c
      JOIN documents d ON c.document_id = d.id
      WHERE d.is_active = true
        AND c.retrieval_excluded = false
        AND (
          c.content % ${query}
          OR c.citation_label % ${query}
          OR coalesce(c.section_title, '') % ${query}
          OR coalesce(c.section_title, '') ILIKE ANY(${sql.array(sectionLikePatterns)}::text[])
          OR d.title ILIKE ANY(${sql.array(docLikePatterns)}::text[])
        )
      ORDER BY score DESC
      LIMIT ${limit}
    `;

    return rows;
  }

  const rows = await sql<ScoredChunk[]>`
    SELECT
      c.id,
      c.document_id,
      d.source_type,
      c.content,
      c.content_preview,
      c.citation_label,
      c.section_title,
      c.sheet_name,
      c.page_number,
      c.retrieval_downranked,
      d.title AS doc_title,
      d.folder,
      greatest(
        similarity(c.content, ${query}),
        similarity(c.citation_label, ${query}),
        similarity(coalesce(c.section_title, ''), ${query})
      ) AS score,
      greatest(
        similarity(c.content, ${query}),
        similarity(c.citation_label, ${query}),
        similarity(coalesce(c.section_title, ''), ${query})
      ) AS trigram_score
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE d.is_active = true
      AND c.retrieval_excluded = false
      AND (
        c.content % ${query}
        OR c.citation_label % ${query}
        OR coalesce(c.section_title, '') % ${query}
      )
    ORDER BY score DESC
    LIMIT ${limit}
  `;

  return rows;
}

export async function findChunksBySectionRefs(
  sectionRefs: string[],
  limit: number = 20,
): Promise<ScoredChunk[]> {
  if (sectionRefs.length === 0) return [];

  const sectionLikePatterns = sectionRefs.flatMap((ref) => [
    `%${ref}%`,
    `%appendix ${ref}%`,
    `%section ${ref}%`,
  ]);
  const appendixPatterns = ['%appendix%', '%test codes%'];

  const rows = await sql<ScoredChunk[]>`
    SELECT
      c.id,
      c.document_id,
      d.source_type,
      c.content,
      c.content_preview,
      c.citation_label,
      c.section_title,
      c.sheet_name,
      c.page_number,
      c.retrieval_downranked,
      d.title AS doc_title,
      d.folder,
      CASE
        WHEN coalesce(c.section_title, '') ILIKE ANY(${sql.array(sectionLikePatterns)}::text[]) THEN 1.0
        WHEN coalesce(c.section_title, '') ILIKE '%test codes%' THEN 0.95
        WHEN coalesce(c.section_title, '') ILIKE ANY(${sql.array(appendixPatterns)}::text[]) THEN 0.9
        ELSE 0.8
      END AS score,
      CASE
        WHEN coalesce(c.section_title, '') ILIKE ANY(${sql.array(sectionLikePatterns)}::text[]) THEN 1.0
        WHEN coalesce(c.section_title, '') ILIKE '%test codes%' THEN 0.95
        WHEN coalesce(c.section_title, '') ILIKE ANY(${sql.array(appendixPatterns)}::text[]) THEN 0.9
        ELSE 0.8
      END AS fts_score
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE d.is_active = true
      AND c.retrieval_excluded = false
      AND c.section_title IS NOT NULL
      AND (
        coalesce(c.section_title, '') ILIKE ANY(${sql.array(sectionLikePatterns)}::text[])
        OR coalesce(c.section_title, '') ILIKE '%test codes%'
        OR coalesce(c.section_title, '') ILIKE ANY(${sql.array(appendixPatterns)}::text[])
      )
    ORDER BY score DESC
    LIMIT ${limit}
  `;

  return rows;
}

export async function findListPriorityChunks(
  limit: number = 20,
): Promise<ScoredChunk[]> {
  const listPatterns = ['%test code%', '%test codes%', '%test type%', '%test types%'];

  const rows = await sql<ScoredChunk[]>`
    SELECT
      c.id,
      c.document_id,
      d.source_type,
      c.content,
      c.content_preview,
      c.citation_label,
      c.section_title,
      c.sheet_name,
      c.page_number,
      c.retrieval_downranked,
      d.title AS doc_title,
      d.folder,
      CASE
        WHEN coalesce(c.section_title, '') ILIKE '%test codes%' THEN 1.0
        WHEN c.content ILIKE '%test code%' THEN 0.95
        WHEN c.content ILIKE '%test type%' THEN 0.92
        ELSE 0.85
      END AS score,
      CASE
        WHEN coalesce(c.section_title, '') ILIKE '%test codes%' THEN 1.0
        WHEN c.content ILIKE '%test code%' THEN 0.95
        WHEN c.content ILIKE '%test type%' THEN 0.92
        ELSE 0.85
      END AS fts_score
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE d.is_active = true
      AND c.retrieval_excluded = false
      AND (
        c.content ILIKE ANY(${sql.array(listPatterns)}::text[])
        OR coalesce(c.section_title, '') ILIKE ANY(${sql.array(listPatterns)}::text[])
      )
    ORDER BY score DESC
    LIMIT ${limit}
  `;

  return rows;
}

export async function findAuthoritativeChunks(
  query: string,
  limit: number = 24,
  sectionRefs: string[] = [],
): Promise<ScoredChunk[]> {
  const titlePatterns = ['%list%', '%code%', '%appendix%', '%matrix%', '%mapping%', '%register%', '%reference%', '%catalog%', '%catalogue%', '%lookup%'];
  const sectionPatterns = ['%code%', '%test type%', '%appendix%', '%criteria%', '%rule%', '%release%', '%interpretation%', '%form%', '%mapping%', '%register%', '%reference%'];
  const sectionRefPatterns = sectionRefs.map((ref) => `%${ref}%`);

  const rows = await sql<ScoredChunk[]>`
    SELECT
      c.id,
      c.document_id,
      d.source_type,
      c.content,
      c.content_preview,
      c.citation_label,
      c.section_title,
      c.sheet_name,
      c.page_number,
      c.retrieval_downranked,
      d.title AS doc_title,
      d.folder,
      CASE
        WHEN lower(coalesce(d.source_type, '')) IN ('xlsx', 'csv') THEN 1.0
        WHEN d.title ILIKE ANY(${sql.array(titlePatterns)}::text[]) THEN 0.96
        WHEN coalesce(c.section_title, '') ILIKE ANY(${sql.array(sectionPatterns)}::text[]) THEN 0.93
        WHEN c.search_text @@ plainto_tsquery('english', ${query}) THEN 0.9
        ELSE 0.82
      END AS score,
      CASE
        WHEN lower(coalesce(d.source_type, '')) IN ('xlsx', 'csv') THEN 1.0
        WHEN d.title ILIKE ANY(${sql.array(titlePatterns)}::text[]) THEN 0.96
        WHEN coalesce(c.section_title, '') ILIKE ANY(${sql.array(sectionPatterns)}::text[]) THEN 0.93
        WHEN c.search_text @@ plainto_tsquery('english', ${query}) THEN 0.9
        ELSE 0.82
      END AS fts_score
    FROM chunks c
    JOIN documents d ON c.document_id = d.id
    WHERE d.is_active = true
      AND c.retrieval_excluded = false
      AND (
        lower(coalesce(d.source_type, '')) IN ('xlsx', 'csv')
        OR d.title ILIKE ANY(${sql.array(titlePatterns)}::text[])
        OR coalesce(c.section_title, '') ILIKE ANY(${sql.array(sectionPatterns)}::text[])
        OR (${sectionRefPatterns.length > 0 ? sql`coalesce(c.section_title, '') ILIKE ANY(${sql.array(sectionRefPatterns)}::text[])` : sql`false`})
      )
      AND (
        c.search_text @@ plainto_tsquery('english', ${query})
        OR c.content ILIKE ${`%${query}%`}
        OR c.citation_label ILIKE ${`%${query}%`}
        OR lower(coalesce(d.source_type, '')) IN ('xlsx', 'csv')
      )
    ORDER BY score DESC
    LIMIT ${limit}
  `;

  return rows;
}
