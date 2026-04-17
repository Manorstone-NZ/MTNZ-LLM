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
  limit: number
): Promise<ScoredChunk[]> {
  const rows = await sql<ScoredChunk[]>`
    SELECT
      c.id,
      c.document_id,
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
  limit: number
): Promise<ScoredChunk[]> {
  const rows = await sql<ScoredChunk[]>`
    SELECT
      c.id,
      c.document_id,
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
