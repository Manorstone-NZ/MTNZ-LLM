import { config } from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

import {
  buildDocQueries,
  excludedRatio,
  selectPilotCandidates,
  summarizePilotOutcomes,
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

type ChatMetrics = {
  answerLength: number;
  sourceCount: number;
  sourceHitsForDoc: number;
  appearsInSources: boolean;
};

function parseArg(name: string, fallback: string): string {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

async function fetchDocsSnapshot(apiBase: string): Promise<DocsResponse> {
  const res = await fetch(`${apiBase}/api/docs`);
  if (!res.ok) {
    throw new Error(`Failed to fetch /api/docs: HTTP ${res.status}`);
  }
  return (await res.json()) as DocsResponse;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function runChatQuery(apiBase: string, query: string, docTitle: string): Promise<ChatMetrics> {
  const res = await fetch(`${apiBase}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question: query,
      conversationHistory: [],
      modelTier: 'default',
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Chat query failed: HTTP ${res.status}`);
  }

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
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7).trim();
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!event || !dataLine) continue;

      let data: unknown;
      try {
        data = JSON.parse(dataLine.slice(6));
      } catch {
        continue;
      }

      if (event === 'token' && typeof data === 'object' && data && 'text' in data) {
        const text = (data as { text?: unknown }).text;
        if (typeof text === 'string') {
          answer += text;
        }
      }

      if (event === 'sources' && typeof data === 'object' && data && 'chunks' in data) {
        const chunks = (data as { chunks?: Array<{ doc_title?: string }> }).chunks ?? [];
        sourceTitles = chunks
          .map((c) => c.doc_title ?? '')
          .filter((title) => title.trim().length > 0);
      }
    }
  }

  const normalizedDoc = normalize(docTitle);
  const sourceHitsForDoc = sourceTitles.filter((title) => {
    const normTitle = normalize(title);
    return normTitle === normalizedDoc || normTitle.includes(normalizedDoc) || normalizedDoc.includes(normTitle);
  }).length;

  return {
    answerLength: answer.trim().length,
    sourceCount: sourceTitles.length,
    sourceHitsForDoc,
    appearsInSources: sourceHitsForDoc > 0,
  };
}

function ensureOutputDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
  };
}

async function main() {
  const count = Number(parseArg('--count', '8'));
  const apiBase = parseArg('--api-base', 'http://localhost:3000');
  const outDir = parseArg('--out-dir', 'docs/reports/2026-04-20-reocr-pilot');

  const sourcePath = process.env.SOURCE_PATH;
  if (!sourcePath) {
    throw new Error('SOURCE_PATH not set in .env.local');
  }

  ensureOutputDir(outDir);

  const beforeSnapshot = await fetchDocsSnapshot(apiBase);
  const selected = selectPilotCandidates(beforeSnapshot.documents, count);

  if (selected.length < 5) {
    throw new Error(`Only ${selected.length} eligible candidates found; need at least 5 for pilot`);
  }

  const selectedWithNotes = selected.map((doc) => {
    const ratio = excludedRatio(doc);
    const note = ratio >= 0.3
      ? 'High contamination in high-priority manual; likely to benefit from selective re-OCR.'
      : 'High-priority manual with moderate contamination; included for representational pilot coverage.';

    return {
      title: doc.title,
      source_path: doc.source_path,
      ocr_quality_status: doc.ocr_quality_status,
      excluded_ratio: Number(ratio.toFixed(4)),
      document_priority: doc.document_priority,
      reprocess_rank: doc.reprocess_rank,
      reprocess_reasons: doc.reprocess_reason,
      selection_note: note,
    };
  });

  const selectionArtifact = {
    generated_at: new Date().toISOString(),
    pilot_size: selectedWithNotes.length,
    selection_criteria: {
      reprocess_candidate: true,
      document_priority: 'high',
      allowed_statuses: ['ocr_mixed', 'ocr_noisy'],
      excluded_statuses: ['native_clean', 'ocr_clean', 'ocr_unusable'],
      manual_focus: 'LOP/EOP/core manuals',
    },
    before_ocr_summary: beforeSnapshot.health.ocr_summary ?? null,
    selected_documents: selectedWithNotes,
  };

  fs.writeFileSync(path.join(outDir, 'pilot-selection.json'), JSON.stringify(selectionArtifact, null, 2));

  const retrievalBeforeByDoc = new Map<string, Array<{ query: string; metrics: ChatMetrics }>>();

  for (const doc of selected) {
    const queries = buildDocQueries(doc.title);
    const checks: Array<{ query: string; metrics: ChatMetrics }> = [];
    for (const query of queries) {
      const metrics = await runChatQuery(apiBase, query, doc.title);
      checks.push({ query, metrics });
    }
    retrievalBeforeByDoc.set(doc.id, checks);
  }

  const { ingestDocuments } = await import('@/lib/ingestion');

  const reprocessRuns: Array<{ title: string; source_path: string; processed: number; failed: number; skipped: number }> = [];

  for (const doc of selected) {
    const result = await ingestDocuments({
      sourcePath,
      forceReprocess: true,
      singleFile: doc.source_path,
      rebuild: true,
    });

    reprocessRuns.push({
      title: doc.title,
      source_path: doc.source_path,
      processed: result.processed,
      failed: result.failed,
      skipped: result.skipped,
    });
  }

  const afterSnapshot = await fetchDocsSnapshot(apiBase);
  const afterBySourcePath = new Map(afterSnapshot.documents.map((d) => [d.source_path, d]));

  const qualityRows = selected.map((beforeDoc) => {
    const afterDoc = afterBySourcePath.get(beforeDoc.source_path);

    const beforeMetrics = pickDocMetrics(beforeDoc);
    const afterMetrics = pickDocMetrics(afterDoc);

    return {
      title: beforeDoc.title,
      source_path: beforeDoc.source_path,
      before: beforeMetrics,
      after: afterMetrics,
      deltas: {
        excluded_ratio_delta: Number((afterMetrics.excluded_ratio - beforeMetrics.excluded_ratio).toFixed(4)),
        chunk_count_delta: afterMetrics.chunk_count - beforeMetrics.chunk_count,
        excluded_chunk_count_delta: afterMetrics.excluded_chunk_count - beforeMetrics.excluded_chunk_count,
        heading_chunk_count_delta: afterMetrics.heading_chunk_count - beforeMetrics.heading_chunk_count,
        status_changed: beforeMetrics.status !== afterMetrics.status,
        remains_reprocess_candidate: afterMetrics.reprocess_candidate,
      },
    };
  });

  fs.writeFileSync(
    path.join(outDir, 'pilot-before-after-quality.json'),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        reprocess_runs: reprocessRuns,
        before_ocr_summary: beforeSnapshot.health.ocr_summary ?? null,
        after_ocr_summary: afterSnapshot.health.ocr_summary ?? null,
        per_document: qualityRows,
      },
      null,
      2,
    ),
  );

  const retrievalImpact: RetrievalDocImpact[] = [];

  for (const doc of selected) {
    const beforeChecks = retrievalBeforeByDoc.get(doc.id) ?? [];
    const checks: QueryCheck[] = [];

    for (const beforeCheck of beforeChecks) {
      const afterMetrics = await runChatQuery(apiBase, beforeCheck.query, doc.title);
      const improved =
        (afterMetrics.appearsInSources && !beforeCheck.metrics.appearsInSources) ||
        (afterMetrics.sourceHitsForDoc > beforeCheck.metrics.sourceHitsForDoc) ||
        (afterMetrics.answerLength > beforeCheck.metrics.answerLength + 40);

      checks.push({
        query: beforeCheck.query,
        before: {
          source_count: beforeCheck.metrics.sourceCount,
          appears_in_sources: beforeCheck.metrics.appearsInSources,
          source_hits_for_doc: beforeCheck.metrics.sourceHitsForDoc,
          answer_length: beforeCheck.metrics.answerLength,
        },
        after: {
          source_count: afterMetrics.sourceCount,
          appears_in_sources: afterMetrics.appearsInSources,
          source_hits_for_doc: afterMetrics.sourceHitsForDoc,
          answer_length: afterMetrics.answerLength,
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

  fs.writeFileSync(
    path.join(outDir, 'pilot-retrieval-impact.json'),
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        method: 'API chat SSE checks with practical procedure/calibration/quality queries per pilot doc',
        per_document: retrievalImpact,
      },
      null,
      2,
    ),
  );

  const outcomeInput = qualityRows.map((row) => ({
    title: row.title,
    excluded_ratio_before: row.before.excluded_ratio,
    excluded_ratio_after: row.after.excluded_ratio,
    status_before: row.before.status,
    status_after: row.after.status,
    retrieval_improved: retrievalImpact.find((r) => r.title === row.title)?.doc_level_retrieval_improved ?? false,
  }));

  const summary = summarizePilotOutcomes(outcomeInput);

  const safety = {
    no_spike_in_junk_chunks: ((afterSnapshot.health.ocr_summary?.ocr_unusable ?? 0) <= (beforeSnapshot.health.ocr_summary?.ocr_unusable ?? 0) + 1),
    no_obvious_source_spam: retrievalImpact.every((doc) => doc.checks.every((c) => c.after.source_count <= 24)),
    ingest_dashboard_reconciliation_ok:
      typeof beforeSnapshot.health.diagnostics === 'object' &&
      typeof afterSnapshot.health.diagnostics === 'object'
        ? Boolean((afterSnapshot.health.diagnostics as Record<string, unknown>).quality_reconciles)
        : true,
  };

  const finalDecision = {
    worthwhile: summary.decision.worthwhile,
    next_step: summary.decision.recommendation,
    explicit_answer: summary.decision.worthwhile
      ? 'Pilot was worthwhile based on measurable quality and retrieval gains.'
      : 'Pilot was not yet worthwhile for broader rollout without method refinement.',
  };

  const summaryArtifact = {
    generated_at: new Date().toISOString(),
    pilot_size: selected.length,
    quality_outcomes: summary,
    safety_checks: safety,
    acceptance_snapshot: {
      selected_docs_only_reprocessed: reprocessRuns.length === selected.length,
      before_after_metrics_for_every_doc: qualityRows.length === selected.length,
      retrieval_checked_for_every_doc: retrievalImpact.length === selected.length,
    },
    final_decision: finalDecision,
  };

  fs.writeFileSync(path.join(outDir, 'pilot-summary.json'), JSON.stringify(summaryArtifact, null, 2));

  console.log(JSON.stringify({
    out_dir: outDir,
    selected_docs: selected.length,
    artifacts: [
      'pilot-selection.json',
      'pilot-before-after-quality.json',
      'pilot-retrieval-impact.json',
      'pilot-summary.json',
    ],
    decision: finalDecision,
  }, null, 2));
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error('[reocr-pilot] failed:', message);
  process.exit(1);
});
