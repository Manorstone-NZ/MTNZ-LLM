'use client';

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
  fallback_extraction_count: number;
  fallback_extraction_percent: number;
  excluded_chunks_total: number;
  excluded_chunk_percent: number;
  docs_with_structural_headings: number;
}

function MetricCard({ label, value, color }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="rounded-lg bg-slate-800/80 border border-slate-700/50 p-4">
      <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-semibold ${color ?? 'text-slate-100'}`}>{value}</p>
    </div>
  );
}

function QualityTierCard({ good, partial, poor }: { good: number; partial: number; poor: number }) {
  const total = good + partial + poor;
  return (
    <div className="rounded-lg bg-slate-800/80 border border-slate-700/50 p-4 col-span-2">
      <p className="text-xs text-slate-400 uppercase tracking-wide mb-2">Quality Tiers</p>
      {total === 0 ? (
        <p className="text-sm text-slate-500">No quality data yet</p>
      ) : (
        <div className="flex items-end gap-4">
          <div>
            <span className="text-2xl font-semibold text-green-400">{good}</span>
            <span className="text-xs text-slate-400 ml-1">Good</span>
          </div>
          <div>
            <span className="text-2xl font-semibold text-amber-400">{partial}</span>
            <span className="text-xs text-slate-400 ml-1">Partial</span>
          </div>
          <div>
            <span className="text-2xl font-semibold text-red-400">{poor}</span>
            <span className="text-xs text-slate-400 ml-1">Poor</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default function HealthDashboard({ health }: { health: HealthMetrics | null }) {
  if (!health) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {Array.from({ length: 10 }).map((_, i) => (
          <div key={i} className="rounded-lg bg-slate-800/50 border border-slate-700/30 p-4 animate-pulse h-20" />
        ))}
      </div>
    );
  }

  const lastRun = health.last_ingest_run
    ? new Date(health.last_ingest_run).toLocaleString()
    : 'Never';

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      <MetricCard label="Active Docs" value={health.total_active} color="text-green-400" />
      <MetricCard label="Inactive" value={health.total_inactive} color="text-slate-400" />
      <MetricCard label="Failed" value={health.total_failed} color={health.total_failed > 0 ? 'text-red-400' : 'text-slate-400'} />
      <MetricCard label="Total Chunks" value={health.total_chunks.toLocaleString()} />
      <MetricCard
        label="Quarantined"
        value={health.quarantined_count}
        color={health.quarantined_count > 0 ? 'text-red-400' : 'text-slate-400'}
      />
      <MetricCard
        label="Needs Review"
        value={health.needs_review_count}
        color={health.needs_review_count > 0 ? 'text-amber-400' : 'text-slate-400'}
      />
      <QualityTierCard
        good={health.quality_good}
        partial={health.quality_partial}
        poor={health.quality_poor}
      />
      <MetricCard label="Zero-Text Docs" value={health.zero_text_docs} color={health.zero_text_docs > 0 ? 'text-amber-400' : 'text-slate-400'} />
      <MetricCard
        label="Fallback Extractions"
        value={`${health.fallback_extraction_count} (${health.fallback_extraction_percent.toFixed(1)}%)`}
        color={health.fallback_extraction_count > 0 ? 'text-amber-400' : 'text-slate-400'}
      />
      <MetricCard
        label="Excluded Chunks"
        value={`${health.excluded_chunks_total.toLocaleString()} (${health.excluded_chunk_percent.toFixed(1)}%)`}
      />
      <MetricCard
        label="Docs w/ Appendix Headings"
        value={health.docs_with_structural_headings}
      />
      <MetricCard label="Avg Chunks/Doc" value={health.avg_chunks_per_doc.toFixed(1)} />
      <MetricCard label="Last Ingest Run" value={lastRun} />
      <MetricCard label="Embedding Model" value={health.embedding_model} />
      <MetricCard label="DB Size" value={`${health.db_size_mb.toFixed(1)} MB`} />
      <MetricCard label="Source Missing" value={health.source_missing_count} color={health.source_missing_count > 0 ? 'text-amber-400' : 'text-slate-400'} />
      <MetricCard label="OCR Used" value={health.ocr_used_count} />
    </div>
  );
}
