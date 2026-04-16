-- V2 Data Quality Rebuild — Schema Migration
-- Adds normalisation, quality scoring, boilerplate tracking, and embedding policy columns

-- === documents table additions ===
ALTER TABLE documents ADD COLUMN IF NOT EXISTS pipeline_version TEXT NOT NULL DEFAULT 'v2';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extraction_method TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS text_quality_score NUMERIC;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS text_quality_tier TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS quality_score_source TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS excluded_chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS boilerplate_chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS downranked_chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS quarantined BOOLEAN NOT NULL DEFAULT false;

-- CHECK constraints for documents
DO $$ BEGIN
  ALTER TABLE documents ADD CONSTRAINT chk_documents_text_quality_tier
    CHECK (text_quality_tier IS NULL OR text_quality_tier IN ('good', 'partial', 'poor'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE documents ADD CONSTRAINT chk_documents_extraction_method
    CHECK (extraction_method IS NULL OR extraction_method IN ('native_pdf', 'ocr', 'native_docx', 'native_xlsx', 'native_txt'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE documents ADD CONSTRAINT chk_documents_quality_score_source
    CHECK (quality_score_source IS NULL OR quality_score_source IN ('native_extraction', 'ocr_output'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- === chunks table additions ===
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS section_type TEXT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS section_type_confidence NUMERIC;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS is_boilerplate BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS retrieval_excluded BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS retrieval_downranked BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS boilerplate_hash TEXT;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS embedding_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS normalisation_reason JSONB;

-- Make embedding nullable for excluded chunks
ALTER TABLE chunks ALTER COLUMN embedding DROP NOT NULL;

-- CHECK constraints for chunks
DO $$ BEGIN
  ALTER TABLE chunks ADD CONSTRAINT chk_chunks_embedding_status
    CHECK (embedding_status IN ('pending', 'embedded', 'skipped_excluded', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE chunks ADD CONSTRAINT chk_chunks_section_type
    CHECK (section_type IS NULL OR section_type IN (
      'heading', 'paragraph', 'procedure_step', 'instruction_block',
      'table', 'warning', 'note',
      'revision_history', 'appendix', 'metadata_only',
      'footer_header', 'form_stub', 'boilerplate'
    ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- === boilerplate_fingerprints table (new) ===
CREATE TABLE IF NOT EXISTS boilerplate_fingerprints (
  hash TEXT PRIMARY KEY,
  sample_text TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  is_confirmed_boilerplate BOOLEAN NOT NULL DEFAULT false,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- === ingest_runs v2 columns ===
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS ocr_routed_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS quarantined_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS excluded_chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS downranked_chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS embedded_chunk_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS skipped_embedding_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ingest_runs ADD COLUMN IF NOT EXISTS pipeline_version TEXT NOT NULL DEFAULT 'v2';

-- === Index updates ===
-- Drop old full embedding index
DROP INDEX IF EXISTS idx_chunks_embedding;

-- Partial index for retrieval: only searchable embedded chunks
-- NOTE: ivfflat requires data to work properly. Create after initial data load.
-- For now, create without ivfflat for exact search:
CREATE INDEX IF NOT EXISTS idx_chunks_retrieval_excluded ON chunks (retrieval_excluded) WHERE retrieval_excluded = false;
CREATE INDEX IF NOT EXISTS idx_chunks_embedding_status ON chunks (embedding_status) WHERE embedding_status = 'embedded';
