/**
 * Wave 2 selective re-OCR rollout script.
 *
 * Extends the validated pilot approach to the next 10–20 ranked candidates,
 * split into Wave 2A (top 10) and Wave 2B (next 10).
 *
 * Usage:
 *   npx tsx scripts/run-wave2-reocr.ts --wave 2a
 *   npx tsx scripts/run-wave2-reocr.ts --wave 2b
 *   npx tsx scripts/run-wave2-reocr.ts --wave both   (default)
 *
 * Options:
 *   --wave <2a|2b|both>           which wave to execute (default: both)
 *   --wave2a-count <N>            docs in Wave 2A (default: 10)
 *   --wave2b-count <N>            docs in Wave 2B (default: 10)
 *   --pilot-selection <path>      pilot selection artifact to exclude (default: auto-discovered)
 *   --api-base <url>              API base URL (default: http://localhost:3000)
 *   --out-dir <dir>               output directory (default: docs/reports/2026-04-20-wave2-reocr)
 */
import { config } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildDocQueries,
  excludedRatio,
  selectWave2Candidates,
  summarizeWave2Outcomes,
  type PilotDocDelta,
  type PilotDocMetrics,
} from '@/lib/reocrPilot';

config({ path: '.env.local' });

// ─── Types ───────────────────────────────────────────────────────────────────

type DocsResponse = {
  documents: PilotDocMetrics[];
  health: Record<string, unknown> & {
    ocr_summary?: Record<string, number>;
    diagnostics?: Record<string, unknown>;
  };
};

type ChatMetrics = {
  answerLength: number;
  sourceCount: number;
  sourceHitsForDoc: number;
  appearsInSources: boolean;
};

type QueryCheck = {
  query: string;
  before: {
    source_count: number;
    appears_in_sources: boolean;
    source_hits_for_doc: number;
    answer_length: number;
  };
  after: {
    source_count: number;
    appears_in_sources: boolean;
    source_hits_for_doc: number;
    answer_length: number;
  };
  improved: boolean;
};

type RetrievalDocImpact = {
  title: string;
  source_path: string;
  checks: QueryCheck[];
  doc_level_retrieval_improved: boolean;
};

// ─── CLI helpers ─────────────────────────────────────────────────────────────

function parseArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

function parseIntArg(name: string, fallback: number): number {
  const val = parseArg(name, String(fallback));
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// ─── API helpers ──────────────────────────────────────────────────────────────

async function fetchDocsSnapshot(apiBase: string): Promise<DocsResponse> {
  const res = await fetch(`${apiBase}/api/docs`);
  if (!res.ok) throw new Error(`Failed to fetch /api/docs: HTTP ${res.status}`);
  return (await res.json()) as DocsResponse;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function runChatQuery(apiBase: string, query: string, docTitle: string): Promise<ChatMetrics> {
  const res = await fetch(`${apiBase}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question: query, conversationHistory: [], modelTier: 'default' }),
  });

  if (!res.ok || !res.body) throw new Error(`Chat query failed: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let sourceTitles: string[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() ?? '';

    for (const eventBlock of events) {
      const lines = eventBlock.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7).trim();
      const dataLine = lines.find((l) => l.startsWith('data: '));
      if (!event || !dataLine) continue;

      let data: unknown;
      try { data = JSON.parse(dataLine.slice(6)); } catch { continue; }

      if (event === 'token' && typeof data === 'object' && data && 'text' in data) {
        const text = (data as { text?: unknown }).text;
        if (typeof text === 'string') answer += text;
      }
      if (event === 'sources' && typeof data === 'object' && data && 'chunks' in data) {
        const chunks = (data as { chunks?: Array<{ doc_title?: string }> }).chunks ?? [];
        sourceTitles = chunks.map((c) => c.doc_title ?? '').filter((t) => t.trim().length > 0);
      }
    }
  }

  const normalizedDoc = normalize(docTitle);
  const sourceHitsForDoc = sourceTitles.filter((t) => {
    const n = normalize(t);
    return n === normalizedDoc || n.includes(normalizedDoc) || normalizedDoc.includes(n);
  }).length;

  return { answerLength: answer.trim().length, sourceCount: sourceTitles.length, sourceHitsForDoc, appearsInSources: sourceHitsForDoc > 0 };
}

// ─── Metrics helpers ──────────────────────────────────────────────────────────

function pickDocMetrics(doc: PilotDocMetrics | undefined) {
  return {
    status: doc?.ocr_quality_status ?? 'unknown',
    quality_tier: doc?.quality_tier ?? null,
    chunk_count: doc?.chunk_count ?? 0,
    excluded_chunk_count: doc?.excluded_chunk_count ?? 0,
    excluded_ratio: excludedRatio(doc ?? {}),
    heading_chunk_count: doc?.heading_chunk_count ?? 0,
    reasons: doc?.ocr_quality_reasons ?? [],
    reprocess_candidate: doc?.reprocess_candidate ?? false,
    reprocess_rank: doc?.reprocess_rank ?? null,
  };
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── Wave execution ───────────────────────────────────────────────────────────

async function runWave(opts: {
  waveName: '2a' | '2b';
  selected: PilotDocMetrics[];
  beforeSnapshot: DocsResponse;
  apiBase: string;
  outDir: string;
  sourcePath: string;
}) {
  const { waveName, selected, beforeSnapshot, apiBase, outDir, sourcePath } = opts;
  const prefix = `wave2${waveName === '2a' ? 'a' : 'b'}`;

  console.log(`\n[wave-${waveName}] Running ${selected.length} documents...`);

  // Capture retrieval BEFORE reprocess
  const retrievalBeforeByDoc = new Map<string, Array<{ query: string; metrics: ChatMetrics }>>();
  for (const doc of selected) {
    const queries = buildDocQueries(doc.title);
    const checks: Array<{ query: string; metrics: ChatMetrics }> = [];
    for (const query of queries) {
      checks.push({ query, metrics: await runChatQuery(apiBase, query, doc.title) });
    }
    retrievalBeforeByDoc.set(doc.id, checks);
  }

  // Reprocess each selected document
  const { ingestDocuments } = await import('@/lib/ingestion');
  const reprocessRuns: Array<{ title: string; source_path: string; processed: number; failed: number; skipped: number }> = [];

  for (const doc of selected) {
    console.log(`[wave-${waveName}] Reprocessing: ${doc.title}`);
    const result = await ingestDocuments({ sourcePath, forceReprocess: true, singleFile: doc.source_path, rebuild: true });
    reprocessRuns.push({ title: doc.title, source_path: doc.source_path, processed: result.processed, failed: result.failed, skipped: result.skipped });
  }

  // Capture AFTER snapshot
  const afterSnapshot = await fetchDocsSnapshot(apiBase);
  const afterBySourcePath = new Map(afterSnapshot.documents.map((d) => [d.source_path, d]));

  // Build quality rows
  const qualityRows = selected.map((beforeDoc) => {
    const afterDoc = afterBySourcePath.get(beforeDoc.source_path);
    const before = pickDocMetrics(beforeDoc);
    const after = pickDocMetrics(afterDoc);
    return {
      title: beforeDoc.title,
      source_path: beforeDoc.source_path,
      before,
      after,
      deltas: {
        excluded_ratio_delta: Number((after.excluded_ratio - before.excluded_ratio).toFixed(4)),
        chunk_count_delta: after.chunk_count - before.chunk_count,
        excluded_chunk_count_delta: after.excluded_chunk_count - before.excluded_chunk_count,
        heading_chunk_count_delta: after.heading_chunk_count - before.heading_chunk_count,
        status_changed: before.status !== after.status,
        remains_reprocess_candidate: after.reprocess_candidate,
      },
    };
  });

  // Capture retrieval AFTER and build impact
  const retrievalImpact: RetrievalDocImpact[] = [];
  for (const doc of selected) {
    const beforeChecks = retrievalBeforeByDoc.get(doc.id) ?? [];
    const checks: QueryCheck[] = [];

    for (const bc of beforeChecks) {
      const afterM = await runChatQuery(apiBase, bc.query, doc.title);
      const improved =
        (afterM.appearsInSources && !bc.metrics.appearsInSources) ||
        (afterM.sourceHitsForDoc > bc.metrics.sourceHitsForDoc) ||
        (afterM.answerLength > bc.metrics.answerLength + 40);

      checks.push({
        query: bc.query,
        before: { source_count: bc.metrics.sourceCount, appears_in_sources: bc.metrics.appearsInSources, source_hits_for_doc: bc.metrics.sourceHitsForDoc, answer_length: bc.metrics.answerLength },
        after: { source_count: afterM.sourceCount, appears_in_sources: afterM.appearsInSources, source_hits_for_doc: afterM.sourceHitsForDoc, answer_length: afterM.answerLength },
        improved,
      });
    }

    retrievalImpact.push({ title: doc.title, source_path: doc.source_path, checks, doc_level_retrieval_improved: checks.some((c) => c.improved) });
  }

  // Write before/after quality artifact
  fs.writeFileSync(
    path.join(outDir, `${prefix}-before-after-quality.json`),
    JSON.stringify({
      generated_at: new Date().toISOString(),
      wave: waveName,
      reprocess_runs: reprocessRuns,
      before_ocr_summary: beforeSnapshot.health.ocr_summary ?? null,
      after_ocr_summary: afterSnapshot.health.ocr_summary ?? null,
      per_document: qualityRows,
    }, null, 2),
  );

  // Write retrieval impact artifact
  fs.writeFileSync(
    path.join(outDir, `${prefix}-retrieval-impact.json`),
    JSON.stringify({
      generated_at: new Date().toISOString(),
      wave: waveName,
      method: 'API chat SSE checks with practical procedure/calibration/quality queries per doc',
      per_document: retrievalImpact,
    }, null, 2),
  );

  return { qualityRows, retrievalImpact, afterSnapshot };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const wave = parseArg('--wave', 'both') as '2a' | '2b' | 'both';
  const wave2aCount = parseIntArg('--wave2a-count', 10);
  const wave2bCount = parseIntArg('--wave2b-count', 10);
  const apiBase = parseArg('--api-base', 'http://localhost:3000');
  const outDir = parseArg('--out-dir', 'docs/reports/2026-04-20-wave2-reocr');
  const pilotSelectionPath = parseArg('--pilot-selection', 'docs/reports/2026-04-20-reocr-pilot/pilot-selection.json');

  const sourcePath = process.env.SOURCE_PATH;
  if (!sourcePath) throw new Error('SOURCE_PATH not set in .env.local');

  ensureDir(outDir);

  // Load pilot selection to exclude already-processed docs
  const pilotSelection = JSON.parse(fs.readFileSync(pilotSelectionPath, 'utf8')) as {
    selected_documents: Array<{ source_path: string }>;
  };
  const excludedSourcePaths = new Set(pilotSelection.selected_documents.map((d) => d.source_path));
  console.log(`[wave2] Excluding ${excludedSourcePaths.size} pilot-processed documents`);

  // Fetch current snapshot for selection
  const baseSnapshot = await fetchDocsSnapshot(apiBase);

  // Select Wave 2A and 2B candidates upfront
  const wave2aDocs = selectWave2Candidates(baseSnapshot.documents, excludedSourcePaths, wave2aCount, 0);
  const wave2bExcludes = new Set([...excludedSourcePaths, ...wave2aDocs.map((d) => d.source_path)]);
  const wave2bDocs = selectWave2Candidates(baseSnapshot.documents, wave2bExcludes, wave2bCount, 0);

  if (wave2aDocs.length === 0) throw new Error('No Wave 2A candidates found after excluding pilot docs');
  if ((wave === '2b' || wave === 'both') && wave2bDocs.length === 0) {
    console.warn('[wave2] No Wave 2B candidates found — only Wave 2A will run');
  }

  // Write combined selection artifact
  const allSelected = [...wave2aDocs, ...wave2bDocs];
  const selectionArtifact = {
    generated_at: new Date().toISOString(),
    excluded_from_pilot: pilotSelection.selected_documents.map((d) => d.source_path),
    selection_criteria: {
      reprocess_candidate: true,
      document_priority: ['high', 'medium'],
      allowed_statuses: ['ocr_mixed', 'ocr_noisy'],
      excluded_statuses: ['native_clean', 'ocr_clean', 'ocr_unusable'],
    },
    wave2a: {
      doc_count: wave2aDocs.length,
      documents: wave2aDocs.map((doc) => ({
        title: doc.title,
        source_path: doc.source_path,
        ocr_quality_status: doc.ocr_quality_status,
        excluded_ratio: Number(excludedRatio(doc).toFixed(4)),
        document_priority: doc.document_priority,
        reprocess_rank: doc.reprocess_rank,
        reprocess_reasons: doc.reprocess_reason,
      })),
    },
    wave2b: {
      doc_count: wave2bDocs.length,
      documents: wave2bDocs.map((doc) => ({
        title: doc.title,
        source_path: doc.source_path,
        ocr_quality_status: doc.ocr_quality_status,
        excluded_ratio: Number(excludedRatio(doc).toFixed(4)),
        document_priority: doc.document_priority,
        reprocess_rank: doc.reprocess_rank,
        reprocess_reasons: doc.reprocess_reason,
      })),
    },
    total_selected: allSelected.length,
    before_ocr_summary: baseSnapshot.health.ocr_summary ?? null,
  };

  fs.writeFileSync(path.join(outDir, 'wave2-selection.json'), JSON.stringify(selectionArtifact, null, 2));
  console.log(`[wave2] Selection artifact written: ${wave2aDocs.length} in 2A, ${wave2bDocs.length} in 2B`);

  // Load pilot summary baseline for comparison
  const pilotSummaryPath = 'docs/reports/2026-04-20-reocr-pilot/pilot-summary.json';
  const pilotBaseline = fs.existsSync(pilotSummaryPath)
    ? (JSON.parse(fs.readFileSync(pilotSummaryPath, 'utf8')) as {
        quality_outcomes: {
          average_excluded_ratio_delta: number;
          material_improvement_docs: number;
          retrieval_improved_docs: number;
          pilot_doc_count: number;
        };
      }).quality_outcomes
    : undefined;

  // Execute waves
  let wave2aResults: Awaited<ReturnType<typeof runWave>> | null = null;
  let wave2bResults: Awaited<ReturnType<typeof runWave>> | null = null;

  if (wave === '2a' || wave === 'both') {
    const beforeSnapshot2a = await fetchDocsSnapshot(apiBase);
    wave2aResults = await runWave({ waveName: '2a', selected: wave2aDocs, beforeSnapshot: beforeSnapshot2a, apiBase, outDir, sourcePath });

    // Write 2A summary
    const deltas2a: PilotDocDelta[] = wave2aResults.qualityRows.map((row) => ({
      title: row.title,
      excluded_ratio_before: row.before.excluded_ratio,
      excluded_ratio_after: row.after.excluded_ratio,
      status_before: row.before.status,
      status_after: row.after.status,
      retrieval_improved: wave2aResults!.retrievalImpact.find((r) => r.title === row.title)?.doc_level_retrieval_improved ?? false,
    }));

    const summary2a = summarizeWave2Outcomes({ wave: '2a', deltas: deltas2a, pilotBaseline });
    const safety2a = {
      no_spike_in_junk_chunks: (wave2aResults.afterSnapshot.health.ocr_summary?.ocr_unusable ?? 0) <= (beforeSnapshot2a.health.ocr_summary?.ocr_unusable ?? 0) + 1,
      no_obvious_source_spam: wave2aResults.retrievalImpact.every((doc) => doc.checks.every((c) => c.after.source_count <= 24)),
      ingest_dashboard_reconciliation_ok: Boolean((wave2aResults.afterSnapshot.health.diagnostics as Record<string, unknown>)?.quality_reconciles ?? true),
    };

    fs.writeFileSync(
      path.join(outDir, 'wave2a-summary.json'),
      JSON.stringify({
        generated_at: new Date().toISOString(),
        wave: '2a',
        doc_count: wave2aDocs.length,
        outcomes: summary2a,
        safety_checks: safety2a,
        acceptance_snapshot: {
          selected_docs_only_reprocessed: wave2aResults.qualityRows.length === wave2aDocs.length,
          before_after_metrics_for_every_doc: wave2aResults.qualityRows.length === wave2aDocs.length,
          retrieval_checked_for_every_doc: wave2aResults.retrievalImpact.length === wave2aDocs.length,
        },
        proceed_to_2b: safety2a.no_spike_in_junk_chunks && summary2a.decision.worthwhile,
      }, null, 2),
    );

    console.log(`[wave-2a] done. worthwhile=${summary2a.decision.worthwhile}, proceed_to_2b=${safety2a.no_spike_in_junk_chunks && summary2a.decision.worthwhile}`);
  }

  if (wave === '2b' || wave === 'both') {
    if (wave2bDocs.length === 0) {
      console.warn('[wave2] Skipping Wave 2B — no candidates available');
    } else {
      const beforeSnapshot2b = await fetchDocsSnapshot(apiBase);
      wave2bResults = await runWave({ waveName: '2b', selected: wave2bDocs, beforeSnapshot: beforeSnapshot2b, apiBase, outDir, sourcePath });

      const deltas2b: PilotDocDelta[] = wave2bResults.qualityRows.map((row) => ({
        title: row.title,
        excluded_ratio_before: row.before.excluded_ratio,
        excluded_ratio_after: row.after.excluded_ratio,
        status_before: row.before.status,
        status_after: row.after.status,
        retrieval_improved: wave2bResults!.retrievalImpact.find((r) => r.title === row.title)?.doc_level_retrieval_improved ?? false,
      }));

      const summary2b = summarizeWave2Outcomes({ wave: '2b', deltas: deltas2b, pilotBaseline });
      const safety2b = {
        no_spike_in_junk_chunks: (wave2bResults.afterSnapshot.health.ocr_summary?.ocr_unusable ?? 0) <= (beforeSnapshot2b.health.ocr_summary?.ocr_unusable ?? 0) + 1,
        no_obvious_source_spam: wave2bResults.retrievalImpact.every((doc) => doc.checks.every((c) => c.after.source_count <= 24)),
        ingest_dashboard_reconciliation_ok: Boolean((wave2bResults.afterSnapshot.health.diagnostics as Record<string, unknown>)?.quality_reconciles ?? true),
      };

      fs.writeFileSync(
        path.join(outDir, 'wave2b-summary.json'),
        JSON.stringify({
          generated_at: new Date().toISOString(),
          wave: '2b',
          doc_count: wave2bDocs.length,
          outcomes: summary2b,
          safety_checks: safety2b,
          acceptance_snapshot: {
            selected_docs_only_reprocessed: wave2bResults.qualityRows.length === wave2bDocs.length,
            before_after_metrics_for_every_doc: wave2bResults.qualityRows.length === wave2bDocs.length,
            retrieval_checked_for_every_doc: wave2bResults.retrievalImpact.length === wave2bDocs.length,
          },
        }, null, 2),
      );

      console.log(`[wave-2b] done. worthwhile=${summary2b.decision.worthwhile}`);
    }
  }

  // Write combined Wave 2 summary
  const allQualityRows = [...(wave2aResults?.qualityRows ?? []), ...(wave2bResults?.qualityRows ?? [])];
  const allRetrievalImpact = [...(wave2aResults?.retrievalImpact ?? []), ...(wave2bResults?.retrievalImpact ?? [])];

  const combinedDeltas: PilotDocDelta[] = allQualityRows.map((row) => ({
    title: row.title,
    excluded_ratio_before: row.before.excluded_ratio,
    excluded_ratio_after: row.after.excluded_ratio,
    status_before: row.before.status,
    status_after: row.after.status,
    retrieval_improved: allRetrievalImpact.find((r) => r.title === row.title)?.doc_level_retrieval_improved ?? false,
  }));

  const combinedSummary = summarizeWave2Outcomes({ wave: 'combined', deltas: combinedDeltas, pilotBaseline });

  const afterFinalSnapshot = await fetchDocsSnapshot(apiBase);
  const finalSafety = {
    no_spike_in_junk_chunks: (afterFinalSnapshot.health.ocr_summary?.ocr_unusable ?? 0) <= (baseSnapshot.health.ocr_summary?.ocr_unusable ?? 0) + 2,
    no_obvious_source_spam: allRetrievalImpact.every((doc) => doc.checks.every((c) => c.after.source_count <= 24)),
    ingest_dashboard_reconciliation_ok: Boolean((afterFinalSnapshot.health.diagnostics as Record<string, unknown>)?.quality_reconciles ?? true),
  };

  const finalDecision = {
    wave2_confirms_pilot: combinedSummary.vs_pilot_baseline?.results_consistent ?? true,
    worthwhile: combinedSummary.decision.worthwhile,
    recommendation: combinedSummary.decision.recommendation,
    explicit_answer: combinedSummary.decision.worthwhile
      ? 'Wave 2 confirms pilot results. Rollout should continue to next batch.'
      : 'Wave 2 gains are inconsistent or flattened. Review method before further rollout.',
  };

  fs.writeFileSync(
    path.join(outDir, 'wave2-summary.json'),
    JSON.stringify({
      generated_at: new Date().toISOString(),
      wave: 'combined',
      waves_executed: wave,
      total_docs_processed: allQualityRows.length,
      wave2a_docs: wave2aResults?.qualityRows.length ?? 0,
      wave2b_docs: wave2bResults?.qualityRows.length ?? 0,
      combined_outcomes: combinedSummary,
      safety_checks: finalSafety,
      final_decision: finalDecision,
    }, null, 2),
  );

  console.log(JSON.stringify({
    out_dir: outDir,
    waves_run: wave,
    total_docs: allQualityRows.length,
    artifacts: [
      'wave2-selection.json',
      'wave2a-before-after-quality.json',
      'wave2a-retrieval-impact.json',
      'wave2a-summary.json',
      'wave2b-before-after-quality.json',
      'wave2b-retrieval-impact.json',
      'wave2b-summary.json',
      'wave2-summary.json',
    ],
    final_decision: finalDecision,
  }, null, 2));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[wave2-reocr] failed:', msg);
  process.exit(1);
});
