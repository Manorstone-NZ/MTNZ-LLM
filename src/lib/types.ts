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
  type: 'heading' | 'paragraph' | 'table' | 'list' | 'revision_block' | 'appendix' | 'instruction_block';
}

// V2 section classification types
export type SectionType =
  | 'heading' | 'paragraph' | 'procedure_step' | 'instruction_block'
  | 'table' | 'warning' | 'note'
  | 'revision_history' | 'appendix' | 'metadata_only'
  | 'footer_header' | 'form_stub' | 'boilerplate';

export interface NormalisedSection extends ExtractedSection {
  section_type: SectionType;
  section_type_confidence: number;
  retrieval_excluded: boolean;
  retrieval_downranked: boolean;
  is_boilerplate: boolean;
  boilerplate_hash: string | null;
  normalisation_reason: Record<string, unknown> | null;
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
  // V2 fields (optional for backward compatibility)
  section_type?: SectionType | null;
  is_boilerplate?: boolean;
  retrieval_excluded?: boolean;
  retrieval_downranked?: boolean;
  boilerplate_hash?: string | null;
  normalisation_reason?: Record<string, unknown> | null;
  embedding_status?: 'pending' | 'embedded' | 'skipped_excluded' | 'failed';
}

// Retrieval result
export interface ScoredChunk {
  id: string;
  document_id: string;
  source_type?: string;
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
  retrieval_downranked?: boolean;
}

// SSE event types for chat streaming
export type ChatSSEEvent =
  | { event: 'token'; data: { text: string } }
  | { event: 'sources'; data: { chunks: CitedChunk[] } }
  | { event: 'done'; data: { ok: true } }
  | { event: 'error'; data: { message: string; code: string } };

export interface CitedChunk {
  chunk_id: string;
  document_id?: string;
  source_type?: string;
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
  // V2 fields
  pipeline_version?: string;
  extraction_method?: string | null;
  text_quality_score?: number | null;
  text_quality_tier?: 'good' | 'partial' | 'poor' | null;
  quality_score_source?: 'native_extraction' | 'ocr_output' | null;
  needs_review?: boolean;
  excluded_chunk_count?: number;
  boilerplate_chunk_count?: number;
  downranked_chunk_count?: number;
  quarantined?: boolean;
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
  // V2 fields
  quarantined_count: number;
  needs_review_count: number;
  quality_good: number;
  quality_partial: number;
  quality_poor: number;
}

// Ingest run result
export interface IngestRunResult {
  run_id: string;
  scanned: number;
  processed: number;
  failed: number;
  skipped: number;
  // V2 fields
  ocr_routed?: number;
  quarantined?: number;
  excluded_chunks?: number;
  downranked_chunks?: number;
  embedded_chunks?: number;
  skipped_embeddings?: number;
}
