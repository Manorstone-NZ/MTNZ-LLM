import { readFile, writeFile } from 'fs/promises';
import { resolve } from 'path';

interface IngestHealth {
  active_docs: number;
  inactive_versions: number;
  total_document_versions: number;
  active_failed: number;
  historical_failed: number;
  active_good: number;
  active_partial: number;
  active_poor: number;
  active_unclassified: number;
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

interface IngestDoc {
  id: string;
  title: string;
  is_active: boolean;
  is_latest_version?: boolean;
  text_quality_tier?: 'good' | 'partial' | 'poor' | null;
  quality_tier?: 'good' | 'partial' | 'poor' | null;
  quality_reasons?: string[];
}

interface ApiPayload {
  documents: IngestDoc[];
  health: IngestHealth;
}

function parseArg(name: string): string | undefined {
  const match = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return match ? match.split('=').slice(1).join('=') : undefined;
}

async function main() {
  const baseUrl = parseArg('--baseUrl') ?? 'http://localhost:3000';
  const outPath = parseArg('--out');
  const endpoint = `${baseUrl.replace(/\/$/, '')}/api/docs`;

  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${endpoint}: ${response.status}`);
  }

  const payload = (await response.json()) as ApiPayload;
  const health = payload.health;
  const docs = payload.documents ?? [];

  const qualityTotal = health.active_good + health.active_partial + health.active_poor + health.active_unclassified;
  const versionsTotal = health.active_docs + health.inactive_versions;

  const docTableSource = await readFile(
    resolve(process.cwd(), 'src/components/ingest/DocumentTable.tsx'),
    'utf8',
  );

  const activeDefault = /useState\(true\);\s*\n\s*const \[latestVersionOnly/.test(docTableSource);
  const latestDefault = /const \[latestVersionOnly,\s*setLatestVersionOnly\] = useState\(true\)/.test(docTableSource);
  const historicalDefault = /const \[historicalOnly,\s*setHistoricalOnly\] = useState\(false\)/.test(docTableSource);

  const defaultVisible = docs.filter((d) => d.is_active && d.is_latest_version);
  const defaultHasHistorical = defaultVisible.some((d) => !d.is_active);

  const activeDocs = docs.filter((d) => d.is_active);
  const activePartialDocs = activeDocs.filter((d) => (d.quality_tier ?? d.text_quality_tier ?? null) === 'partial');
  const activeUnclassifiedDocs = activeDocs.filter((d) => (d.quality_tier ?? d.text_quality_tier ?? null) === null);

  const partialWithReasons = activePartialDocs.filter((d) => (d.quality_reasons?.length ?? 0) > 0).length;
  const unclassifiedWithReasons = activeUnclassifiedDocs.filter((d) => (d.quality_reasons?.length ?? 0) > 0).length;

  const partialReasonCounts = health.partial_reason_counts ?? {};
  const partialReasonCountsTotal = Object.values(partialReasonCounts).reduce((sum, count) => sum + count, 0);

  const partialReasonDiagnostics = health.diagnostics.quality_reason_diagnostics;

  const samplePartialDocs = activePartialDocs.slice(0, 5).map((doc) => ({
    id: doc.id,
    title: doc.title,
    quality_tier: doc.quality_tier ?? doc.text_quality_tier ?? null,
    quality_reasons: doc.quality_reasons ?? [],
  }));

  const result = {
    endpoint,
    checks: {
      active_plus_inactive_reconciles: versionsTotal === health.total_document_versions,
      quality_reconciles: qualityTotal === health.active_docs,
      split_failed_present:
        typeof health.active_failed === 'number' && typeof health.historical_failed === 'number',
      table_default_active_only: activeDefault,
      table_default_latest_only: latestDefault,
      table_default_historical_off: historicalDefault,
      default_scope_excludes_historical_rows: !defaultHasHistorical,
      unclassified_present_when_needed:
        health.active_docs > (health.active_good + health.active_partial + health.active_poor)
          ? health.active_unclassified > 0
          : true,
      partial_docs_have_reasons: activePartialDocs.length === partialWithReasons,
      unclassified_docs_have_reasons: activeUnclassifiedDocs.length === unclassifiedWithReasons,
      partial_reason_breakdown_present:
        Object.keys(partialReasonCounts).length > 0 || activePartialDocs.length === 0,
      partial_reason_counts_reconcile:
        partialReasonCountsTotal >= activePartialDocs.length
        && (partialReasonDiagnostics
          ? partialReasonDiagnostics.partial_docs_with_reasons === activePartialDocs.length
          : true),
    },
    diagnostics: {
      quality_total: qualityTotal,
      active_docs: health.active_docs,
      total_document_versions: health.total_document_versions,
      active_plus_inactive_total: versionsTotal,
      api_diagnostics: health.diagnostics,
      quality_reason_diagnostics: partialReasonDiagnostics,
      default_visible_rows_count: defaultVisible.length,
      raw_documents_count: docs.length,
      partial_docs: activePartialDocs.length,
      partial_docs_with_reasons: partialWithReasons,
      unclassified_docs: activeUnclassifiedDocs.length,
      unclassified_docs_with_reasons: unclassifiedWithReasons,
      partial_reason_count_keys: Object.keys(partialReasonCounts).length,
      partial_reason_count_total: partialReasonCountsTotal,
    },
    sample_partial_docs: samplePartialDocs,
    raw_health: health,
  };

  const text = JSON.stringify(result, null, 2);
  if (outPath) {
    await writeFile(resolve(process.cwd(), outPath), `${text}\n`, 'utf8');
    console.log(`Wrote report to ${outPath}`);
  }

  console.log(text);

  const allChecksPass = Object.values(result.checks).every(Boolean);
  if (!allChecksPass) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
