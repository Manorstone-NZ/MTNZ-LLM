/**
 * Continuous ranked selective re-OCR processing.
 *
 * Moves rollout from manual "waves" to a repeatable batch cycle.
 * Each cycle:
 * 1) Select top-N ranked reprocess candidates not previously processed
 * 2) Capture retrieval BEFORE
 * 3) Reprocess selected docs via ingestion pipeline
 * 4) Capture retrieval AFTER + quality deltas
 * 5) Evaluate stop thresholds and continue/stop
 *
 * Usage:
 *   npx tsx scripts/run-continuous-reocr.ts
 *   npx tsx scripts/run-continuous-reocr.ts --batch-size 15 --max-cycles 5
 */
import { config } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildDocQueries,
  evaluateContinuousStop,
  excludedRatio,
  type PilotDocDelta,
  type PilotDocMetrics,
} from '@/lib/reocrPilot';

config({ path: '.env.local' });

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

const CONTINUOUS_CHAT_TIMEOUT_MS = Number.parseInt(
  process.env.CONTINUOUS_CHAT_TIMEOUT_MS ?? '45000',
  10,
);

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

type CycleSummary = {
  cycle: number;
  doc_count: number;
  average_excluded_ratio_delta: number;
  retrieval_improvement_rate: number;
  material_improvement_docs: number;
  retrieval_improved_docs: number;
  low_priority_share: number;
  safety_checks: {
    no_spike_in_junk_chunks: boolean;
    no_obvious_source_spam: boolean;
    ingest_dashboard_reconciliation_ok: boolean;
  };
  stop_decision: {
    should_stop: boolean;
    reasons: string[];
  };
};

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

function parseFloatArg(name: string, fallback: number): number {
  const val = parseArg(name, String(fallback));
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label}_timeout`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function fetchDocsSnapshot(apiBase: string): Promise<DocsResponse> {
  const res = await fetch(`${apiBase}/api/docs`);
  if (!res.ok) throw new Error(`Failed to fetch /api/docs: HTTP ${res.status}`);
  return (await res.json()) as DocsResponse;
}

async function runChatQuery(apiBase: string, query: string, docTitle: string): Promise<ChatMetrics> {
  const controller = new AbortController();
  const startedAt = Date.now();

  try {
    const res = await withTimeout(
      fetch(`${apiBase}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: query, conversationHistory: [], modelTier: 'default' }),
        signal: controller.signal,
      }),
      CONTINUOUS_CHAT_TIMEOUT_MS,
      'chat_fetch',
    );

    if (!res.ok || !res.body) throw new Error(`Chat query failed: HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    let sourceTitles: string[] = [];

    while (true) {
      const elapsed = Date.now() - startedAt;
      const remainingMs = CONTINUOUS_CHAT_TIMEOUT_MS - elapsed;
      if (remainingMs <= 0) {
        throw new Error('chat_stream_timeout');
      }

      const { done, value } = await withTimeout(reader.read(), remainingMs, 'chat_stream');
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

    return {
      answerLength: answer.trim().length,
      sourceCount: sourceTitles.length,
      sourceHitsForDoc,
      appearsInSources: sourceHitsForDoc > 0,
    };
  } catch (err) {
    const isTimeout = err instanceof Error
      && (err.name === 'AbortError' || err.message.includes('chat_fetch_timeout') || err.message.includes('chat_stream_timeout'));
    if (isTimeout) {
      controller.abort();
      console.warn(`[continuous] chat query timed out after ${CONTINUOUS_CHAT_TIMEOUT_MS}ms: ${query}`);
      return {
        answerLength: 0,
        sourceCount: 0,
        sourceHitsForDoc: 0,
        appearsInSources: false,
      };
    }
    throw err;
  }
}

function selectContinuousCandidates(docs: PilotDocMetrics[], excludedSourcePaths: Set<string>, batchSize: number): PilotDocMetrics[] {
  const count = Math.max(5, Math.min(20, batchSize));

  return docs
    .filter((doc) => doc.reprocess_candidate === true)
    .filter((doc) => doc.ocr_quality_status === 'ocr_mixed' || doc.ocr_quality_status === 'ocr_noisy')
    .filter((doc) => !excludedSourcePaths.has(doc.source_path))
    .sort((a, b) => {
      const rankA = a.reprocess_rank ?? Number.MAX_SAFE_INTEGER;
      const rankB = b.reprocess_rank ?? Number.MAX_SAFE_INTEGER;
      if (rankA !== rankB) return rankA - rankB;
      return excludedRatio(b) - excludedRatio(a);
    })
    .slice(0, count);
}

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
    document_priority: doc?.document_priority ?? null,
  };
}

function loadExcludedSourcePaths(paths: string[]): Set<string> {
  const out = new Set<string>();

  for (const p of paths) {
    if (!p || !fs.existsSync(p)) continue;
    const content = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;

    // pilot-selection shape
    const selected = (content.selected_documents as Array<{ source_path?: string }> | undefined) ?? [];
    for (const row of selected) {
      if (row?.source_path) out.add(row.source_path);
    }

    // wave2-selection shape
    const wave2aDocs = ((content.wave2a as { documents?: Array<{ source_path?: string }> } | undefined)?.documents) ?? [];
    const wave2bDocs = ((content.wave2b as { documents?: Array<{ source_path?: string }> } | undefined)?.documents) ?? [];
    for (const row of [...wave2aDocs, ...wave2bDocs]) {
      if (row?.source_path) out.add(row.source_path);
    }
  }

  return out;
}

async function runCycle(opts: {
  cycle: number;
  selected: PilotDocMetrics[];
  beforeSnapshot: DocsResponse;
  apiBase: string;
  outDir: string;
  sourcePath: string;
  minRatioImprovement: number;
  minRetrievalImprovementRate: number;
  maxLowPriorityShare: number;
}) {
  const {
    cycle,
    selected,
    beforeSnapshot,
    apiBase,
    outDir,
    sourcePath,
    minRatioImprovement,
    minRetrievalImprovementRate,
    maxLowPriorityShare,
  } = opts;

  const cycleId = `cycle-${String(cycle).padStart(2, '0')}`;
  console.log(`\n[continuous] ${cycleId}: running ${selected.length} documents`);

  const retrievalBeforeByDoc = new Map<string, Array<{ query: string; metrics: ChatMetrics }>>();
  for (const doc of selected) {
    const queries = buildDocQueries(doc.title);
    const checks: Array<{ query: string; metrics: ChatMetrics }> = [];
    for (const query of queries) {
      checks.push({ query, metrics: await runChatQuery(apiBase, query, doc.title) });
    }
    retrievalBeforeByDoc.set(doc.id, checks);
  }

  const { ingestDocuments } = await import('@/lib/ingestion');
  const reprocessRuns: Array<{ title: string; source_path: string; processed: number; failed: number; skipped: number }> = [];

  for (const doc of selected) {
    console.log(`[continuous] ${cycleId}: reprocessing ${doc.title}`);
    const result = await ingestDocuments({ sourcePath, forceReprocess: true, singleFile: doc.source_path, rebuild: true });
    reprocessRuns.push({ title: doc.title, source_path: doc.source_path, processed: result.processed, failed: result.failed, skipped: result.skipped });
  }

  const afterSnapshot = await fetchDocsSnapshot(apiBase);
  const afterBySourcePath = new Map(afterSnapshot.documents.map((d) => [d.source_path, d]));

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
        before: {
          source_count: bc.metrics.sourceCount,
          appears_in_sources: bc.metrics.appearsInSources,
          source_hits_for_doc: bc.metrics.sourceHitsForDoc,
          answer_length: bc.metrics.answerLength,
        },
        after: {
          source_count: afterM.sourceCount,
          appears_in_sources: afterM.appearsInSources,
          source_hits_for_doc: afterM.sourceHitsForDoc,
          answer_length: afterM.answerLength,
        },
        improved,
      });
    }

    retrievalImpact.push({
      title: doc.title,
      source_path: doc.source_path,
      checks,
      doc_level_retrieval_improved: checks.some((c) => c.improved),
    });
  }

  const deltas: PilotDocDelta[] = qualityRows.map((row) => ({
    title: row.title,
    excluded_ratio_before: row.before.excluded_ratio,
    excluded_ratio_after: row.after.excluded_ratio,
    status_before: row.before.status,
    status_after: row.after.status,
    retrieval_improved: retrievalImpact.find((r) => r.source_path === row.source_path)?.doc_level_retrieval_improved ?? false,
  }));

  const materialImprovementDocs = deltas.filter((d) =>
    (d.excluded_ratio_before - d.excluded_ratio_after) >= 0.05 || d.status_before !== d.status_after,
  ).length;
  const retrievalImprovedDocs = deltas.filter((d) => d.retrieval_improved).length;
  const avgExcludedRatioDelta = deltas.length === 0
    ? 0
    : Number((deltas.reduce((sum, d) => sum + (d.excluded_ratio_after - d.excluded_ratio_before), 0) / deltas.length).toFixed(4));

  const avgExcludedRatioImprovement = Math.max(0, Number((-avgExcludedRatioDelta).toFixed(4)));
  const retrievalImprovementRate = deltas.length === 0 ? 0 : Number((retrievalImprovedDocs / deltas.length).toFixed(4));
  const lowPriorityShare = selected.length === 0
    ? 0
    : Number((selected.filter((d) => (d.document_priority ?? 'low') === 'low').length / selected.length).toFixed(4));

  const stopDecision = evaluateContinuousStop({
    avgExcludedRatioImprovement,
    retrievalImprovementRate,
    lowPriorityShare,
    minRatioImprovement,
    minRetrievalImprovementRate,
    maxLowPriorityShare,
  });

  const safetyChecks = {
    no_spike_in_junk_chunks: (afterSnapshot.health.ocr_summary?.ocr_unusable ?? 0) <= (beforeSnapshot.health.ocr_summary?.ocr_unusable ?? 0) + 1,
    no_obvious_source_spam: retrievalImpact.every((doc) => doc.checks.every((c) => c.after.source_count <= 24)),
    ingest_dashboard_reconciliation_ok: Boolean((afterSnapshot.health.diagnostics as Record<string, unknown>)?.quality_reconciles ?? true),
  };

  fs.writeFileSync(
    path.join(outDir, `${cycleId}-before-after-quality.json`),
    JSON.stringify({
      generated_at: new Date().toISOString(),
      cycle,
      reprocess_runs: reprocessRuns,
      before_ocr_summary: beforeSnapshot.health.ocr_summary ?? null,
      after_ocr_summary: afterSnapshot.health.ocr_summary ?? null,
      per_document: qualityRows,
    }, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, `${cycleId}-retrieval-impact.json`),
    JSON.stringify({
      generated_at: new Date().toISOString(),
      cycle,
      method: 'API chat SSE checks with practical procedure/calibration/quality queries per doc',
      per_document: retrievalImpact,
    }, null, 2),
  );

  const summary: CycleSummary = {
    cycle,
    doc_count: selected.length,
    average_excluded_ratio_delta: avgExcludedRatioDelta,
    retrieval_improvement_rate: retrievalImprovementRate,
    material_improvement_docs: materialImprovementDocs,
    retrieval_improved_docs: retrievalImprovedDocs,
    low_priority_share: lowPriorityShare,
    safety_checks: safetyChecks,
    stop_decision: {
      should_stop: stopDecision.shouldStop || !safetyChecks.no_spike_in_junk_chunks || !safetyChecks.no_obvious_source_spam || !safetyChecks.ingest_dashboard_reconciliation_ok,
      reasons: [
        ...stopDecision.reasons,
        ...(!safetyChecks.no_spike_in_junk_chunks ? ['junk chunk spike detected'] : []),
        ...(!safetyChecks.no_obvious_source_spam ? ['source spam risk detected'] : []),
        ...(!safetyChecks.ingest_dashboard_reconciliation_ok ? ['ingest reconciliation failed'] : []),
      ],
    },
  };

  fs.writeFileSync(path.join(outDir, `${cycleId}-summary.json`), JSON.stringify({ generated_at: new Date().toISOString(), ...summary }, null, 2));

  return { summary, selected, qualityRows, retrievalImpact };
}

async function main() {
  const batchSize = parseIntArg('--batch-size', 10);
  const maxCycles = parseIntArg('--max-cycles', 5);
  const apiBase = parseArg('--api-base', 'http://localhost:3000');
  const outDir = parseArg('--out-dir', 'docs/reports/2026-04-20-continuous-reocr');
  const dryRun = hasFlag('--dry-run');

  const minRatioImprovement = parseFloatArg('--min-ratio-improvement', 0.15);
  const minRetrievalImprovementRate = parseFloatArg('--min-retrieval-improvement', 0.6);
  const maxLowPriorityShare = parseFloatArg('--max-low-priority-share', 0.5);

  const excludePilotSelection = parseArg('--pilot-selection', 'docs/reports/2026-04-20-reocr-pilot/pilot-selection.json');
  const excludeWave2Selection = parseArg('--wave2-selection', 'docs/reports/2026-04-20-wave2-reocr/wave2-selection.json');

  const sourcePath = process.env.SOURCE_PATH;
  if (!sourcePath) throw new Error('SOURCE_PATH not set in .env.local');

  ensureDir(outDir);

  const excludedSourcePaths = loadExcludedSourcePaths([excludePilotSelection, excludeWave2Selection]);
  console.log(`[continuous] excluded ${excludedSourcePaths.size} already-processed docs from prior artifacts`);

  if (dryRun) {
    const snapshot = await fetchDocsSnapshot(apiBase);
    const selected = selectContinuousCandidates(snapshot.documents, excludedSourcePaths, batchSize);
    fs.writeFileSync(
      path.join(outDir, 'dry-run-selection.json'),
      JSON.stringify({
        generated_at: new Date().toISOString(),
        mode: 'dry_run',
        batch_size: batchSize,
        selected_count: selected.length,
        selected_documents: selected.map((doc) => ({
          title: doc.title,
          source_path: doc.source_path,
          ocr_quality_status: doc.ocr_quality_status,
          excluded_ratio: Number(excludedRatio(doc).toFixed(4)),
          document_priority: doc.document_priority,
          reprocess_rank: doc.reprocess_rank,
          reprocess_reasons: doc.reprocess_reason,
        })),
      }, null, 2),
    );
    console.log(JSON.stringify({
      out_dir: outDir,
      mode: 'dry_run',
      selected_count: selected.length,
      artifact: 'dry-run-selection.json',
    }, null, 2));
    return;
  }

  const cycleSummaries: CycleSummary[] = [];
  const processedInRun = new Set<string>();

  for (let cycle = 1; cycle <= maxCycles; cycle += 1) {
    const beforeSnapshot = await fetchDocsSnapshot(apiBase);
    const excludedForCycle = new Set<string>([...excludedSourcePaths, ...processedInRun]);
    const selected = selectContinuousCandidates(beforeSnapshot.documents, excludedForCycle, batchSize);

    if (selected.length === 0) {
      console.log(`[continuous] cycle-${String(cycle).padStart(2, '0')}: no eligible candidates left, stopping`);
      break;
    }

    const cycleId = `cycle-${String(cycle).padStart(2, '0')}`;
    fs.writeFileSync(
      path.join(outDir, `${cycleId}-selection.json`),
      JSON.stringify({
        generated_at: new Date().toISOString(),
        cycle,
        batch_size: batchSize,
        selected_documents: selected.map((doc) => ({
          title: doc.title,
          source_path: doc.source_path,
          ocr_quality_status: doc.ocr_quality_status,
          excluded_ratio: Number(excludedRatio(doc).toFixed(4)),
          document_priority: doc.document_priority,
          reprocess_rank: doc.reprocess_rank,
          reprocess_reasons: doc.reprocess_reason,
        })),
      }, null, 2),
    );

    const result = await runCycle({
      cycle,
      selected,
      beforeSnapshot,
      apiBase,
      outDir,
      sourcePath,
      minRatioImprovement,
      minRetrievalImprovementRate,
      maxLowPriorityShare,
    });

    cycleSummaries.push(result.summary);
    for (const doc of selected) processedInRun.add(doc.source_path);

    if (result.summary.stop_decision.should_stop) {
      console.log(`[continuous] ${cycleId}: stop criteria met -> ${result.summary.stop_decision.reasons.join('; ')}`);
      break;
    }

    console.log(`[continuous] ${cycleId}: continue (ratio=${(-result.summary.average_excluded_ratio_delta).toFixed(3)}, retrieval=${result.summary.retrieval_improvement_rate.toFixed(3)})`);
  }

  const totalDocs = cycleSummaries.reduce((sum, c) => sum + c.doc_count, 0);
  const totalMaterialImproved = cycleSummaries.reduce((sum, c) => sum + c.material_improvement_docs, 0);
  const totalRetrievalImproved = cycleSummaries.reduce((sum, c) => sum + c.retrieval_improved_docs, 0);
  const weightedAvgRatioDelta = totalDocs === 0
    ? 0
    : Number((cycleSummaries.reduce((sum, c) => sum + (c.average_excluded_ratio_delta * c.doc_count), 0) / totalDocs).toFixed(4));

  const finalDecision = {
    cycles_completed: cycleSummaries.length,
    total_docs_processed: totalDocs,
    worthwhile: totalMaterialImproved > 0 && totalRetrievalImproved > 0,
    recommendation: cycleSummaries.length === 0
      ? 'stop_no_candidates'
      : (cycleSummaries[cycleSummaries.length - 1]?.stop_decision.should_stop ?? false)
        ? 'stop_threshold_reached'
        : 'continue_next_cycle',
  };

  fs.writeFileSync(
    path.join(outDir, 'continuous-summary.json'),
    JSON.stringify({
      generated_at: new Date().toISOString(),
      mode: 'continuous_ranked_reocr',
      config: {
        batch_size: batchSize,
        max_cycles: maxCycles,
        min_ratio_improvement: minRatioImprovement,
        min_retrieval_improvement_rate: minRetrievalImprovementRate,
        max_low_priority_share: maxLowPriorityShare,
      },
      cumulative_outcomes: {
        total_docs_processed: totalDocs,
        material_improvement_docs: totalMaterialImproved,
        retrieval_improved_docs: totalRetrievalImproved,
        weighted_average_excluded_ratio_delta: weightedAvgRatioDelta,
      },
      cycles: cycleSummaries,
      final_decision: finalDecision,
    }, null, 2),
  );

  console.log(JSON.stringify({
    out_dir: outDir,
    cycles_completed: cycleSummaries.length,
    total_docs_processed: totalDocs,
    final_decision: finalDecision,
  }, null, 2));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error('[continuous-reocr] failed:', msg);
  process.exit(1);
});
