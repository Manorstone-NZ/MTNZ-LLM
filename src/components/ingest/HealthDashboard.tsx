'use client';

interface HealthMetrics {
  total_active: number;
  total_inactive: number;
  active_completed: number;
  active_pending: number;
  active_failed: number;
  historical_failed: number;
  total_chunks: number;
  zero_text_docs: number;
  avg_chunks_per_doc: number;
  last_ingest_run: string | null;
  embedding_model: string;
  db_size_mb: number;
  source_missing_count: number;
  active_ocr_count: number;
  quarantined_count: number;
  needs_review_count: number;
  quality_good: number;
  quality_partial: number;
  quality_poor: number;
  quality_unclassified: number;
  fallback_extraction_count: number;
  fallback_extraction_percent: number;
  excluded_chunks_total: number;
  excluded_chunk_percent: number;
  docs_with_structural_headings: number;
}

function MetricCard({
  label,
  value,
  color,
  title,
}: {
  label: string;
  value: string | number;
  color?: string;
  title?: string;
}) {
  return (
    <div className="rounded-lg bg-slate-800/80 border border-slate-700/50 p-4" title={title}>
      <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-2xl font-semibold ${color ?? 'text-slate-100'}`}>{value}</p>
    </div>
  );
}

function QualityTierCard({
  good,
  partial,
  poor,
  unclassified,
  total,
}: {
  good: number;
  partial: number;
  poor: number;
  unclassified: number;
  total: number;
}) {
  const classified = good + partial + poor + unclassified;
  const reconciles = classified === total;
  return (
    <div className="rounded-lg bg-slate-800/80 border border-slate-700/50 p-4 col-span-2">
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-xs text-slate-400 uppercase tracking-wide">Quality Tiers (active)</p>
        {!reconciles && (
          <span className="text-[10px] text-amber-400 font-medium">⚠ sum ≠ active docs</span>
        )}
      </div>
      {total === 0 ? (
        <p className="text-sm text-slate-500">No quality data yet</p>
      ) : (
        <div className="flex items-end gap-4 flex-wrap">
          <div title="Active docs where extracted text quality is high">
            <span className="text-2xl font-semibold text-green-400">{good}</span>
            <span className="text-xs text-slate-400 ml-1">Good</span>
          </div>
          <div title="Active docs where extracted text quality is partial or degraded">
            <span className="text-2xl font-semibold text-amber-400">{partial}</span>
            <span className="text-xs text-slate-400 ml-1">Partial</span>
          </div>
          <div title="Active docs where extracted text quality is poor">
            <span className="text-2xl font-semibold text-red-400">{poor}</span>
            <span className="text-xs text-slate-400 ml-1">Poor</span>
          </div>
          {unclassified > 0 && (
            <div title="Active docs that have not been assigned a quality tier (e.g. pending processing or older pipeline version)">
              <span className="text-2xl font-semibold text-slate-400">{unclassified}</span>
              <span className="text-xs text-slate-500 ml-1">Unclassified</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="col-span-full text-xs font-semibold text-slate-400 uppercase tracking-widest mt-2 mb-0 border-b border-slate-700/50 pb-1">
      {children}
    </h3>
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

  const totalVersions = health.total_active + health.total_inactive;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">

      {/* ── Active Corpus ─────────────────────────────── */}
      <SectionHeading>Active Corpus</SectionHeading>

      <MetricCard label="Active Docs" value={health.total_active} color="text-green-400" />
      <MetricCard
        label="Active Completed"
        value={health.active_completed}
        color="text-green-300"
        title="Active documents that have been fully processed"
      />
      <MetricCard
        label="Active Pending"
        value={health.active_pending}
        color={health.active_pending > 0 ? 'text-amber-400' : 'text-slate-400'}
        title="Active documents awaiting processing"
      />
      <MetricCard
        label="Active Failed"
        value={health.active_failed}
        color={health.active_failed > 0 ? 'text-red-400' : 'text-slate-400'}
        title="Active documents where extraction failed — these are in the live corpus but may have 0 chunks"
      />

      {/* ── Quality ───────────────────────────────────── */}
      <SectionHeading>Text Quality (active docs)</SectionHeading>

      <QualityTierCard
        good={health.quality_good}
        partial={health.quality_partial}
        poor={health.quality_poor}
        unclassified={health.quality_unclassified}
        total={health.total_active}
      />
      <MetricCard
        label="Quarantined"
        value={health.quarantined_count}
        color={health.quarantined_count > 0 ? 'text-red-400' : 'text-slate-400'}
        title="Active docs where all chunks are excluded from retrieval"
      />
      <MetricCard
        label="Needs Review"
        value={health.needs_review_count}
        color={health.needs_review_count > 0 ? 'text-amber-400' : 'text-slate-400'}
        title="Active docs flagged for manual review"
      />
      <MetricCard
        label="Zero-Text Docs"
        value={health.zero_text_docs}
        color={health.zero_text_docs > 0 ? 'text-amber-400' : 'text-slate-400'}
        title="Active completed docs that produced 0 chunks"
      />

      {/* ── Chunks & Extraction ───────────────────────── */}
      <SectionHeading>Chunks &amp; Extraction (active docs)</SectionHeading>

      <MetricCard label="Active Chunks" value={health.total_chunks.toLocaleString()} />
      <MetricCard label="Avg Chunks/Doc" value={health.avg_chunks_per_doc.toFixed(1)} />
      <MetricCard
        label="OCR Used"
        value={health.active_ocr_count}
        title="Active docs where OCR contributed to the extracted text (any OCR path)"
      />
      <MetricCard
        label="Fallback Extractions"
        value={`${health.fallback_extraction_count} (${health.fallback_extraction_percent.toFixed(1)}%)`}
        color={health.fallback_extraction_count > 0 ? 'text-amber-400' : 'text-slate-400'}
        title="Active docs where the primary (native) parser failed or timed out and the system switched to a fallback extraction path"
      />
      <MetricCard
        label="Excluded Chunks"
        value={`${health.excluded_chunks_total.toLocaleString()} (${health.excluded_chunk_percent.toFixed(1)}%)`}
        title="Chunks excluded from retrieval (boilerplate, downranked, or quarantined) in active docs"
      />
      <MetricCard
        label="Docs w/ Appendix Headings"
        value={health.docs_with_structural_headings}
        title="Active docs where at least one chunk carries an appendix section type"
      />
      <MetricCard
        label="Source Missing"
        value={health.source_missing_count}
        color={health.source_missing_count > 0 ? 'text-amber-400' : 'text-slate-400'}
        title="Active docs whose source file is no longer present on disk"
      />

      {/* ── Historical Archive ────────────────────────── */}
      <SectionHeading>Historical Archive</SectionHeading>

      <MetricCard
        label="Historical Versions"
        value={health.total_inactive}
        color="text-slate-400"
        title="Superseded document versions (is_active = false) — included in total version count"
      />
      <MetricCard
        label="Historical Failed"
        value={health.historical_failed}
        color={health.historical_failed > 0 ? 'text-slate-400' : 'text-slate-400'}
        title="Inactive/superseded docs that are in failed state — these are not in the live corpus"
      />
      <MetricCard
        label="Total Versions"
        value={totalVersions.toLocaleString()}
        title={`Active (${health.total_active}) + Historical (${health.total_inactive}) = ${totalVersions}`}
      />

      {/* ── System ───────────────────────────────────── */}
      <SectionHeading>System</SectionHeading>

      <MetricCard label="Last Ingest Run" value={lastRun} />
      <MetricCard label="Embedding Model" value={health.embedding_model} />
      <MetricCard label="DB Size" value={`${health.db_size_mb.toFixed(1)} MB`} />
    </div>
  );
}
