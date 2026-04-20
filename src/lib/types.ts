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
  | {
      event: 'provider';
      data: {
        requested: string;
        resolved: 'anthropic' | 'lmstudio';
        anthropicEnabled: boolean;
        fallbackApplied: boolean;
        lmStudioModel?: string | null;
      };
    }
  | {
      event: 'routing';
      data: {
        answer_mode_used: 'lmstudio_only' | 'anthropic_only' | 'two_tier_auto';
        provider_used: 'anthropic' | 'lmstudio';
        model_used: string;
        quality_mode_triggered: boolean;
        quality_mode_reason: string;
        request_override_applied: boolean;
      };
    }
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
  /** True when this is the most recent version for source_path */
  is_latest_version?: boolean;
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
  extraction_completeness_status?: 'unknown' | 'complete' | 'partial' | 'suspect';
  extraction_completeness_score?: number;
  extraction_completeness_reasons?: string[] | null;
  missing_referenced_appendices?: string[] | null;
  completeness_last_audited_at?: string | null;
  heading_chunk_count?: number;
  table_chunk_count?: number;
  appendix_chunk_count?: number;
  list_chunk_count?: number;
  quality_tier?: 'good' | 'partial' | 'poor' | null;
  quality_reasons?: string[];
  // OCR Quality Scoring fields
  ocr_quality_status?: 'native_clean' | 'ocr_clean' | 'ocr_mixed' | 'ocr_noisy' | 'ocr_unusable';
  ocr_quality_reasons?: string[];
  document_priority?: 'high' | 'medium' | 'low';
  reprocess_candidate?: boolean;
  reprocess_reason?: string;
  reprocess_rank?: number | null;
}

export interface IngestHealthDiagnostics {
  quality_total: number;
  active_docs: number;
  quality_reconciles: boolean;
  total_versions: number;
  active_plus_inactive_reconciles: boolean;
  quality_reason_diagnostics?: {
    partial_docs: number;
    unclassified_docs: number;
    partial_docs_with_reasons: number;
    unclassified_docs_with_reasons: number;
    partial_docs_have_reasons: boolean;
    unclassified_docs_have_reasons: boolean;
    partial_reason_counts_present: boolean;
  };
}

export interface IngestMetricAudit {
  source: 'documents' | 'chunks';
  scope: 'active_only' | 'historical_only' | 'all_versions';
  filter: string;
}

// Standardized health metrics for /api/docs dashboard payload
export interface HealthMetrics {
  // Active corpus
  active_docs: number;
  active_completed: number;
  active_pending: number;
  active_failed: number;
  active_needs_review: number;
  active_chunks_total: number;
  active_ocr_used: number;
  active_fallback_extractions: number;

  // Historical
  inactive_versions: number;
  historical_failed: number;

  // Quality (active only)
  active_good: number;
  active_partial: number;
  active_poor: number;
  active_unclassified: number;

  // Additional active/system context
  active_quarantined: number;
  active_source_missing: number;
  active_zero_text_docs: number;
  active_avg_chunks_per_doc: number;
  active_fallback_extraction_percent: number;
  active_excluded_chunks_total: number;
  active_excluded_chunk_percent: number;
  active_docs_with_structural_headings: number;

  // Totals/system
  total_document_versions: number;
  last_ingest_run: string | null;
  embedding_model: string;
  db_size_mb: number;

  diagnostics: IngestHealthDiagnostics;
  partial_reason_counts?: Record<string, number>;
  good_reason_counts?: Record<string, number>;
  unclassified_reason_counts?: Record<string, number>;
  metric_audit: Record<string, IngestMetricAudit>;
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
