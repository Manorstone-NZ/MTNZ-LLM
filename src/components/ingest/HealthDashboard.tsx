'use client';

interface HealthMetrics {
  active_docs: number;
  active_completed: number;
  active_pending: number;
  active_failed: number;
  active_needs_review: number;
  active_chunks_total: number;
  active_ocr_used: number;
  active_fallback_extractions: number;
  historical_failed: number;
  inactive_versions: number;
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
  ocr_summary?: {
    native_clean: number;
    ocr_clean: number;
    ocr_mixed: number;
    ocr_noisy: number;
    ocr_unusable: number;
    total_reprocess_candidates: number;
    high_priority_candidates: number;
  };
  top_reprocess_candidates?: Array<{ title: string; reprocess_rank: number | null; reprocess_reason: string }>;
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
          <div title="Active docs that have not been assigned a quality tier (e.g. pending processing or older pipeline version)">
            <span className="text-2xl font-semibold text-slate-400">{unclassified}</span>
            <span className="text-xs text-slate-500 ml-1">Unclassified</span>
          </div>
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

function ReasonBreakdownCard({
  partialDocs,
  reasonCounts,
}: {
  partialDocs: number;
  reasonCounts: Record<string, number>;
}) {
  const topDrivers = Object.entries(reasonCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="rounded-lg bg-slate-800/80 border border-slate-700/50 p-4 col-span-2">
      <div className="flex items-baseline justify-between mb-2">
        <p className="text-xs text-slate-400 uppercase tracking-wide">Partial Explainability</p>
        <span className="text-xs text-slate-300">
          Partial docs: <span className="text-amber-300 font-semibold">{partialDocs}</span>
        </span>
      </div>
      {topDrivers.length === 0 ? (
        <p className="text-sm text-slate-500">No partial reasons available yet.</p>
      ) : (
        <ul className="space-y-1">
          {topDrivers.map(([reason, count]) => (
            <li key={reason} className="text-xs text-slate-300 flex items-center justify-between gap-3">
              <span>{reason}</span>
              <span className="tabular-nums text-slate-200 font-medium">{count}</span>
            </li>
          ))}
        </ul>
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

  const totalVersions = health.total_document_versions;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">

      {/* ── Active Corpus ─────────────────────────────── */}
      <SectionHeading>Active Corpus</SectionHeading>

      <MetricCard label="Active Docs" value={health.active_docs} color="text-green-400" />
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
      <MetricCard
        label="Active Needs Review"
        value={health.active_needs_review}
        color={health.active_needs_review > 0 ? 'text-amber-400' : 'text-slate-400'}
      />
      <MetricCard
        label="Active Chunks"
        value={health.active_chunks_total.toLocaleString()}
      />
      <MetricCard
        label="Active OCR-used"
        value={health.active_ocr_used}
        title="OCR used = OCR contributed to extracted text"
      />
      <MetricCard
        label="Active Fallback-extracted"
        value={`${health.active_fallback_extractions} (${health.active_fallback_extraction_percent.toFixed(1)}%)`}
        color={health.active_fallback_extractions > 0 ? 'text-amber-400' : 'text-slate-400'}
        title="Fallback extraction = native extraction failed/timed out and fallback path was used"
      />

      {/* ── Quality ───────────────────────────────────── */}
      <SectionHeading>Text Quality (active docs)</SectionHeading>

      <QualityTierCard
        good={health.active_good}
        partial={health.active_partial}
        poor={health.active_poor}
        unclassified={health.active_unclassified}
        total={health.active_docs}
      />
      <MetricCard
        label="Quarantined"
        value={health.active_quarantined}
        color={health.active_quarantined > 0 ? 'text-red-400' : 'text-slate-400'}
        title="Active docs where all chunks are excluded from retrieval"
      />
      <MetricCard
        label="Needs Review"
        value={health.active_needs_review}
        color={health.active_needs_review > 0 ? 'text-amber-400' : 'text-slate-400'}
        title="Active docs flagged for manual review"
      />
      <MetricCard
        label="Zero-Text Docs"
        value={health.active_zero_text_docs}
        color={health.active_zero_text_docs > 0 ? 'text-amber-400' : 'text-slate-400'}
        title="Active completed docs that produced 0 chunks"
      />
      <ReasonBreakdownCard
        partialDocs={health.active_partial}
        reasonCounts={health.partial_reason_counts ?? {}}
      />

      {/* ── Chunks & Extraction ───────────────────────── */}
      <SectionHeading>Chunks &amp; Extraction (active docs)</SectionHeading>

      <MetricCard label="Active Chunks" value={health.active_chunks_total.toLocaleString()} />
      <MetricCard label="Avg Chunks/Doc" value={health.active_avg_chunks_per_doc.toFixed(1)} />
      <MetricCard
        label="OCR Used"
        value={health.active_ocr_used}
        title="Active docs where OCR contributed to the extracted text (any OCR path)"
      />
      <MetricCard
        label="Fallback Extractions"
        value={`${health.active_fallback_extractions} (${health.active_fallback_extraction_percent.toFixed(1)}%)`}
        color={health.active_fallback_extractions > 0 ? 'text-amber-400' : 'text-slate-400'}
        title="Active docs where the primary (native) parser failed or timed out and the system switched to a fallback extraction path"
      />
      <MetricCard
        label="Excluded Chunks"
        value={`${health.active_excluded_chunks_total.toLocaleString()} (${health.active_excluded_chunk_percent.toFixed(1)}%)`}
        title="Chunks excluded from retrieval (boilerplate, downranked, or quarantined) in active docs"
      />
      <MetricCard
        label="Docs w/ Appendix Headings"
        value={health.active_docs_with_structural_headings}
        title="Active docs where at least one chunk carries an appendix section type"
      />
      <MetricCard
        label="Source Missing"
        value={health.active_source_missing}
        color={health.active_source_missing > 0 ? 'text-amber-400' : 'text-slate-400'}
        title="Active docs whose source file is no longer present on disk"
      />

      {/* ── Historical Archive ────────────────────────── */}
      <SectionHeading>Historical Archive</SectionHeading>

      <MetricCard
        label="Historical Versions"
        value={health.inactive_versions}
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
        title={`Active (${health.active_docs}) + Historical (${health.inactive_versions}) = ${totalVersions}`}
      />
      <MetricCard
        label="Diagnostics"
        value={health.diagnostics.quality_reconciles && health.diagnostics.active_plus_inactive_reconciles ? 'OK' : 'Mismatch'}
        color={health.diagnostics.quality_reconciles && health.diagnostics.active_plus_inactive_reconciles ? 'text-green-400' : 'text-red-400'}
        title={`quality_total=${health.diagnostics.quality_total}, active_docs=${health.diagnostics.active_docs}, total_versions=${health.diagnostics.total_versions}`}
      />

      {/* ── OCR Quality ──────────────────────────────── */}
      <SectionHeading>OCR Quality (active docs)</SectionHeading>

      {health.ocr_summary ? (
        <>
          <MetricCard
            label="Native Clean"
            value={health.ocr_summary.native_clean}
            color="text-green-400"
            title="Native extraction with clean profile"
          />
          <MetricCard
            label="OCR Clean"
            value={health.ocr_summary.ocr_clean}
            color="text-green-300"
            title="OCR extracted with <15% excluded"
          />
          <MetricCard
            label="OCR Mixed"
            value={health.ocr_summary.ocr_mixed}
            color="text-amber-400"
            title="OCR extracted with 15–30% excluded"
          />
          <MetricCard
            label="OCR Noisy"
            value={health.ocr_summary.ocr_noisy}
            color="text-orange-400"
            title="OCR extracted with 30–50% excluded"
          />
          <MetricCard
            label="OCR Unusable"
            value={health.ocr_summary.ocr_unusable}
            color="text-red-400"
            title="OCR extracted with ≥50% excluded or quarantined"
          />
          <MetricCard
            label="Reprocess Candidates"
            value={health.ocr_summary.total_reprocess_candidates}
            color={health.ocr_summary.total_reprocess_candidates > 0 ? 'text-amber-300' : 'text-slate-400'}
            title="PDFs worth selective re-OCR"
          />
          <MetricCard
            label="High Priority"
            value={health.ocr_summary.high_priority_candidates}
            color={health.ocr_summary.high_priority_candidates > 0 ? 'text-red-400' : 'text-slate-400'}
            title="High-value docs (LOP/EOP/manual) with noisy OCR"
          />
        </>
      ) : (
        <div className="col-span-2 text-sm text-slate-500">No OCR quality data yet</div>
      )}

      {/* ── High-Value Re-OCR Candidates ────────────── */}
      {health.top_reprocess_candidates && health.top_reprocess_candidates.length > 0 && (
        <>
          <SectionHeading>Top Re-OCR Candidates</SectionHeading>
          <div className="col-span-full rounded-lg bg-slate-800/80 border border-slate-700/50 p-4">
            <div className="space-y-2">
              {health.top_reprocess_candidates.slice(0, 5).map((doc) => (
                <div key={doc.title} className="text-xs">
                  <div className="flex items-start gap-2">
                    <span className="tabular-nums text-amber-400 font-semibold min-w-6">#{doc.reprocess_rank ?? '—'}</span>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-slate-200 truncate">{doc.title}</p>
                      <p className="text-slate-400 text-xs mt-0.5">{doc.reprocess_reason}</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* ── System ───────────────────────────────────── */}
      <SectionHeading>System</SectionHeading>

      <MetricCard label="Last Ingest Run" value={lastRun} />
      <MetricCard label="Embedding Model" value={health.embedding_model} />
      <MetricCard label="DB Size" value={`${health.db_size_mb.toFixed(1)} MB`} />
    </div>
  );
}
