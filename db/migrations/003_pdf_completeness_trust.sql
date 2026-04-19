-- PDF completeness trust signals
-- Adds machine-actionable extraction trust status derived from structural audit.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS extraction_completeness_status TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extraction_completeness_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extraction_completeness_reasons JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS missing_referenced_appendices JSONB;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS completeness_last_audited_at TIMESTAMPTZ;

DO $$ BEGIN
  ALTER TABLE documents ADD CONSTRAINT chk_documents_extraction_completeness_status
    CHECK (extraction_completeness_status IN ('unknown', 'complete', 'partial', 'suspect'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_documents_completeness_status
  ON documents (extraction_completeness_status)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_documents_completeness_audited_at
  ON documents (completeness_last_audited_at)
  WHERE is_active = true;
