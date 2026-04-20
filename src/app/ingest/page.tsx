'use client';

import Link from 'next/link';
import { useState, useEffect, useCallback } from 'react';
import HealthDashboard from '@/components/ingest/HealthDashboard';
import DocumentTable from '@/components/ingest/DocumentTable';
import IngestControls from '@/components/ingest/IngestControls';

interface DocumentRow {
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
  heading_chunk_count?: number;
  table_chunk_count?: number;
  appendix_chunk_count?: number;
  list_chunk_count?: number;
  quality_tier?: 'good' | 'partial' | 'poor' | null;
  quality_reasons?: string[];
}

interface HealthMetrics {
  active_docs: number;
  active_completed: number;
  active_pending: number;
  active_failed: number;
  active_needs_review: number;
  active_chunks_total: number;
  active_ocr_used: number;
  active_fallback_extractions: number;

  inactive_versions: number;
  historical_failed: number;

  active_good: number;
  active_partial: number;
  active_poor: number;
  active_unclassified: number;

  active_quarantined: number;
  active_source_missing: number;
  active_zero_text_docs: number;
  active_avg_chunks_per_doc: number;
  active_fallback_extraction_percent: number;
  active_excluded_chunks_total: number;
  active_excluded_chunk_percent: number;
  active_docs_with_structural_headings: number;

  total_document_versions: number;
  last_ingest_run: string | null;
  embedding_model: string;
  db_size_mb: number;

  diagnostics: {
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
  };
  partial_reason_counts?: Record<string, number>;
  good_reason_counts?: Record<string, number>;
  unclassified_reason_counts?: Record<string, number>;
  metric_audit: Record<string, { source: string; scope: string; filter: string }>;
}

declare global {
  interface Window {
    __ingestFileInput?: HTMLInputElement | null;
  }
}

interface ProgressEvent {
  file: string;
  status: string;
  processed: number;
  total: number;
}

interface UploadState {
  isDragging: boolean;
  isUploading: boolean;
  uploadProgress: { file: string; percent: number } | null;
  uploadError: string | null;
}

const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.docx', '.xlsx', '.txt',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff',
]);

export default function IngestPage() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [health, setHealth] = useState<HealthMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isIngesting, setIsIngesting] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [filters, setFilters] = useState({ folder: 'All', status: 'All', type: 'All' });
  const [upload, setUpload] = useState<UploadState>({
    isDragging: false,
    isUploading: false,
    uploadProgress: null,
    uploadError: null,
  });
  const fileInputRef = useCallback((ref: HTMLInputElement | null) => {
    window.__ingestFileInput = ref;
  }, []);
  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setUpload((prev) => ({ ...prev, isDragging: true }));
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setUpload((prev) => ({ ...prev, isDragging: false }));
  }

  async function processFiles(files: FileList | null) {
    if (!files || files.length === 0) return;

    setUpload((prev) => ({ ...prev, isDragging: false, uploadError: null }));

    // Validate files
    const validFiles: File[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const ext = file.name.substring(file.name.lastIndexOf('.')).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        setUpload((prev) => ({
          ...prev,
          uploadError: `Unsupported format: ${file.name}. Supported: PDF, DOCX, XLSX, TXT, images`,
        }));
        return;
      }
      if (file.size > 100 * 1024 * 1024) {
        // 100MB limit
        setUpload((prev) => ({
          ...prev,
          uploadError: `File too large: ${file.name} (max 100MB)`,
        }));
        return;
      }
      validFiles.push(file);
    }

    if (validFiles.length === 0) return;

    setUpload((prev) => ({ ...prev, isUploading: true, uploadError: null }));

    try {
      // Process files sequentially
      for (const file of validFiles) {
        const formData = new FormData();
        formData.append('file', file);

        setUpload((prev) => ({
          ...prev,
          uploadProgress: { file: file.name, percent: 10 },
        }));

        const res = await fetch('/api/ingest/upload', {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(
            errorData.error || `Upload failed for ${file.name} (${res.status})`
          );
        }

        setUpload((prev) => ({
          ...prev,
          uploadProgress: { file: file.name, percent: 100 },
        }));
      }

      // After all uploads complete, trigger ingest with force reprocess
      setUpload((prev) => ({
        ...prev,
        uploadProgress: { file: 'Processing...', percent: 50 },
      }));

      await runIngestAction({ action: 'ingest_new', forceReprocess: true });
    } catch (err) {
      setUpload((prev) => ({
        ...prev,
        uploadError: err instanceof Error ? err.message : 'Upload failed',
        isUploading: false,
        uploadProgress: null,
      }));
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    e.stopPropagation();
    setUpload((prev) => ({ ...prev, isDragging: false }));
    processFiles(e.dataTransfer.files);
  }

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    processFiles(e.target.files);
    // Reset input so same file can be re-selected
    e.target.value = '';
  }


  const fetchData = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (filters.folder !== 'All') params.set('folder', filters.folder);
      if (filters.status !== 'All') params.set('status', filters.status);
      if (filters.type !== 'All') params.set('type', filters.type);

      const qs = params.toString();
      const res = await fetch(`/api/docs${qs ? `?${qs}` : ''}`);
      if (!res.ok) throw new Error(`Failed to fetch (${res.status})`);
      const data = await res.json();
      setDocuments(data.documents ?? []);
      setHealth(data.health ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load documents');
    } finally {
      setIsLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const isProcessing = isIngesting || upload.isUploading;

  function handleFilterChange(key: 'folder' | 'status' | 'type', value: string) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  async function runIngestAction(body: Record<string, unknown>) {
    setIsIngesting(true);
    setProgress(null);
    setError(null);

    try {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      const contentType = res.headers.get('content-type') ?? '';

      // Handle SSE streaming response
      if (contentType.includes('text/event-stream')) {
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split('\n\n');
          buffer = events.pop()!;

          for (const event of events) {
            if (!event.trim()) continue;

            const lines = event.split('\n');
            const eventLine = lines.find((l) => l.startsWith('event:'));
            const dataLine = lines.find((l) => l.startsWith('data:'));

            if (!eventLine || !dataLine) continue;

            const eventType = eventLine.replace('event: ', '').trim();
            const dataStr = dataLine.replace('data: ', '');

            try {
              const parsed = JSON.parse(dataStr);

              switch (eventType) {
                case 'progress':
                  setProgress(parsed);
                  break;
                case 'done':
                  // Ingest completed successfully
                  break;
                case 'error':
                  setError(parsed.message || 'Ingest failed');
                  break;
              }
            } catch {
              // skip malformed JSON
            }
          }
        }
      } else {
        // JSON response (e.g. remove action)
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || 'Action failed');
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setIsIngesting(false);
      setProgress(null);
      fetchData();
    }
  }

  function handleIngestNew() {
    runIngestAction({ action: 'ingest_new' });
  }

  function handleFullRebuild() {
    runIngestAction({ action: 'full_rebuild', confirm: 'REBUILD' });
  }

  function handleReprocess(documentId: string) {
    runIngestAction({ action: 'reprocess_one', documentId });
  }

  async function handleRemove(documentId: string) {
    setError(null);
    try {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', documentId }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Remove failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Remove failed');
    }
    fetchData();
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-6 px-4 py-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-[color:var(--brand-strong)]">Document Ingestion</h1>
        </div>

        {/* Error banner */}
        {(error || upload.uploadError) && (
          <div className="flex items-center justify-between rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700">
            <span>{error || upload.uploadError}</span>
            <button
              onClick={() => {
                setError(null);
                setUpload((prev) => ({ ...prev, uploadError: null }));
              }}
              className="ml-2 text-lg leading-none text-red-500 hover:text-red-700"
            >
              &times;
            </button>
          </div>
        )}

        <section>
          <div className="flex items-center justify-between gap-4 rounded-lg border border-[color:var(--brand)]/40 bg-[color:var(--brand-soft)] px-4 py-3 text-sm text-[color:var(--brand-strong)]">
            <div>
              Need help with uploads, ingestion rules, or troubleshooting?
              <span className="text-[color:var(--brand)]"> Open the integrated Help center.</span>
            </div>
            <Link
              href="/help?guide=adding-documents"
              className="shrink-0 inline-flex items-center rounded-md border border-[color:var(--brand)]/40 bg-[color:var(--brand-soft)] px-3 py-1.5 text-xs font-semibold text-[color:var(--brand-strong)] hover:bg-[color:var(--brand-soft)]/80 transition-colors"
            >
              Open Help
            </Link>
          </div>
        </section>

        {/* Upload Area */}
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-slate-500">Upload Documents</h2>
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            className={`relative border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
              upload.isDragging
                ? 'border-[color:var(--brand)] bg-[color:var(--brand-soft)]/60'
                : 'border-[color:var(--line)] bg-white/70 hover:border-[color:var(--brand)]'
            } ${isProcessing ? 'opacity-50 pointer-events-none' : ''}`}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={Array.from(SUPPORTED_EXTENSIONS).join(',')}
              onChange={handleFileSelect}
              disabled={isProcessing}
              className="hidden"
            />
            <button
              onClick={() => {
                const input = window.__ingestFileInput;
                if (input) input.click();
              }}
              disabled={isProcessing}
              className="mx-auto"
            >
              <div className="text-3xl mb-2">📄</div>
              <h3 className="mb-1 font-semibold text-[color:var(--brand-strong)]">Upload Documents</h3>
              <p className="mb-3 text-sm text-slate-500">
                Drag files here or click to browse
              </p>
              <p className="text-xs text-slate-500">
                Supported: PDF, DOCX, XLSX, TXT, PNG, JPG, GIF, WebP, TIFF (Max 100MB each)
              </p>
            </button>
          </div>

          {/* Upload Progress */}
          {upload.uploadProgress && (
            <div className="mt-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-slate-700">{upload.uploadProgress.file}</span>
                <span className="text-slate-500">{upload.uploadProgress.percent}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded bg-[color:var(--surface-muted)]">
                <div
                  className="h-full bg-[color:var(--brand)] transition-all"
                  style={{ width: `${upload.uploadProgress.percent}%` }}
                />
              </div>
            </div>
          )}
        </section>

        {/* Health Dashboard */}
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-slate-500">Health Metrics</h2>
          <HealthDashboard health={health} />
          {process.env.NODE_ENV !== 'production' && health?.diagnostics && (
            <div className="mt-3 rounded-md border border-[color:var(--line)] bg-white/70 px-3 py-2 text-xs text-slate-600">
              <span className="mr-4">
                quality reconciles:{' '}
                <span className={health.diagnostics.quality_reconciles ? 'text-green-400' : 'text-red-400'}>
                  {String(health.diagnostics.quality_reconciles)}
                </span>
              </span>
              <span>
                active/inactive totals reconcile:{' '}
                <span
                  className={
                    health.diagnostics.active_plus_inactive_reconciles ? 'text-green-400' : 'text-red-400'
                  }
                >
                  {String(health.diagnostics.active_plus_inactive_reconciles)}
                </span>
              </span>
              <span className="ml-4">
                partial reasons complete:{' '}
                <span
                  className={
                    health.diagnostics.quality_reason_diagnostics?.partial_docs_have_reasons
                      ? 'text-green-400'
                      : 'text-red-400'
                  }
                >
                  {String(health.diagnostics.quality_reason_diagnostics?.partial_docs_have_reasons ?? false)}
                </span>
              </span>
            </div>
          )}
        </section>

        {/* Ingest Controls */}
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-slate-500">Actions</h2>
          <IngestControls
            isIngesting={isIngesting}
            progress={progress}
            onIngestNew={handleIngestNew}
            onFullRebuild={handleFullRebuild}
          />
        </section>

        {/* Document Table */}
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-slate-500">Documents</h2>
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-slate-500">
              <span className="mr-2 inline-block h-5 w-5 animate-spin rounded-full border-2 border-[color:var(--brand)]/20 border-t-[color:var(--brand)]" />
              Loading documents...
            </div>
          ) : (
            <DocumentTable
              documents={documents}
              onReprocess={handleReprocess}
              onRemove={handleRemove}
              isIngesting={isIngesting}
              filters={filters}
              onFilterChange={handleFilterChange}
            />
          )}
        </section>
      </div>
    </div>
  );
}
