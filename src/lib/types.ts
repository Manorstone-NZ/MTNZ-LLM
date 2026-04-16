// Extraction output — common across all extractors
export interface ExtractedContent {
  text: string;
  sections: ExtractedSection[];
  metadata: Record<string, unknown>;
  ocr_used?: boolean;
  ocr_confidence?: number;
}

export interface ExtractedSection {
  title: string | null;
  content: string;
  page?: number;
  level?: number;
  type: 'heading' | 'paragraph' | 'table' | 'list' | 'revision_block' | 'appendix';
}

// Chunk output — common across all chunkers
export interface PreparedChunk {
  content: string;
  content_preview: string;
  chunk_index: number;
  chunk_hash: string;
  token_count: number;
  page_number: number | null;
  section_title: string | null;
  sheet_name: string | null;
  range_ref: string | null;
  citation_label: string;
  metadata: Record<string, unknown>;
}

// Retrieval result
export interface ScoredChunk {
  id: string;
  document_id: string;
  content: string;
  content_preview: string;
  citation_label: string;
  section_title: string | null;
  sheet_name: string | null;
  page_number: number | null;
  doc_title: string;
  folder: string;
  score: number;
  vector_score?: number;
  fts_score?: number;
  trigram_score?: number;
}

// SSE event types for chat streaming
export type ChatSSEEvent =
  | { event: 'token'; data: { text: string } }
  | { event: 'sources'; data: { chunks: CitedChunk[] } }
  | { event: 'done'; data: { ok: true } }
  | { event: 'error'; data: { message: string; code: string } };

export interface CitedChunk {
  chunk_id: string;
  citation_label: string;
  doc_title: string;
  folder: string;
  page: number | null;
  section_title: string | null;
  sheet_name: string | null;
  content_preview: string;
}

// Document row from database
export interface DocumentRow {
  id: string;
  title: string;
  filename: string;
  source_path: string;
  folder: string;
  source_type: string;
  version_hash: string;
  is_active: boolean;
  superseded_at: string | null;
  last_seen_at: string;
  document_date: string | null;
  chunk_count: number;
  extraction_status: string;
  extraction_error: string | null;
  ocr_used: boolean;
  ocr_confidence: number | null;
  source_missing: boolean;
  processed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Health metrics for dashboard
export interface HealthMetrics {
  total_active: number;
  total_inactive: number;
  total_failed: number;
  total_chunks: number;
  zero_text_docs: number;
  avg_chunks_per_doc: number;
  last_ingest_run: string | null;
  embedding_model: string;
  db_size_mb: number;
  source_missing_count: number;
  ocr_used_count: number;
}

// Ingest run result
export interface IngestRunResult {
  run_id: string;
  scanned: number;
  processed: number;
  failed: number;
  skipped: number;
}
