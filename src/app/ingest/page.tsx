'use client';

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

interface HealthMetrics {
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

interface ProgressEvent {
  file: string;
  status: string;
  processed: number;
  total: number;
}

export default function IngestPage() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [health, setHealth] = useState<HealthMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isIngesting, setIsIngesting] = useState(false);
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [filters, setFilters] = useState({ folder: 'All', status: 'All', type: 'All' });

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
      <div className="max-w-7xl mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-slate-100">Document Ingestion</h1>
        </div>

        {/* Error banner */}
        {error && (
          <div className="px-4 py-3 rounded-lg bg-red-900/50 border border-red-700 text-red-200 text-sm flex items-center justify-between">
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="ml-2 text-red-400 hover:text-red-200 text-lg leading-none"
            >
              &times;
            </button>
          </div>
        )}

        {/* Health Dashboard */}
        <section>
          <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide mb-3">Health Metrics</h2>
          <HealthDashboard health={health} />
        </section>

        {/* Ingest Controls */}
        <section>
          <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide mb-3">Actions</h2>
          <IngestControls
            isIngesting={isIngesting}
            progress={progress}
            onIngestNew={handleIngestNew}
            onFullRebuild={handleFullRebuild}
          />
        </section>

        {/* Document Table */}
        <section>
          <h2 className="text-sm font-medium text-slate-400 uppercase tracking-wide mb-3">Documents</h2>
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-slate-500">
              <span className="inline-block w-5 h-5 border-2 border-slate-500/30 border-t-slate-500 rounded-full animate-spin mr-2" />
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
