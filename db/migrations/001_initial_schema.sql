-- Extensions (must be first — schema depends on these)
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- documents table
CREATE TABLE documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  filename        TEXT NOT NULL,
  source_path     TEXT NOT NULL,
  folder          TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  version_hash    TEXT NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  superseded_at   TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  document_date   DATE,
  chunk_count     INTEGER NOT NULL DEFAULT 0,
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  extraction_error TEXT,
  ocr_used        BOOLEAN NOT NULL DEFAULT false,
  ocr_confidence  NUMERIC,
  source_missing  BOOLEAN NOT NULL DEFAULT false,
  processed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_text     TSVECTOR,
  title_normalized TEXT
);

CREATE INDEX idx_documents_active ON documents (is_active) WHERE is_active = true;
CREATE INDEX idx_documents_folder ON documents (folder);
CREATE INDEX idx_documents_hash ON documents (version_hash);
CREATE UNIQUE INDEX ux_documents_active_source_path ON documents (source_path) WHERE is_active = true;
CREATE INDEX idx_documents_search_text ON documents USING gin (search_text);

-- chunks table
CREATE TABLE chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id     UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  content         TEXT NOT NULL,
  content_preview TEXT NOT NULL,
  search_text     TSVECTOR NOT NULL,
  embedding       VECTOR(768) NOT NULL,
  chunk_index     INTEGER NOT NULL,
  chunk_hash      TEXT NOT NULL,
  token_count     INTEGER NOT NULL,
  page_number     INTEGER,
  section_title   TEXT,
  sheet_name      TEXT,
  range_ref       TEXT,
  citation_label  TEXT NOT NULL,
  metadata        JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- NOTE: ivfflat index should be created after initial data load.
-- For small corpora, exact cosine scan is acceptable.
-- Run this manually after ingestion:
-- CREATE INDEX idx_chunks_embedding ON chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX idx_chunks_search_text ON chunks USING gin (search_text);
CREATE INDEX idx_chunks_content_trgm ON chunks USING gin (content gin_trgm_ops);
CREATE INDEX idx_chunks_citation_trgm ON chunks USING gin (citation_label gin_trgm_ops);
CREATE INDEX idx_chunks_section_trgm ON chunks USING gin (section_title gin_trgm_ops)
  WHERE section_title IS NOT NULL;
CREATE INDEX idx_chunks_document_id ON chunks (document_id);
CREATE UNIQUE INDEX ux_chunks_document_chunk_index ON chunks (document_id, chunk_index);
CREATE UNIQUE INDEX ux_chunks_document_chunk_hash ON chunks (document_id, chunk_hash);

-- ingest_runs table
CREATE TABLE ingest_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running',
  scanned_count   INTEGER NOT NULL DEFAULT 0,
  processed_count INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
