import fs from 'node:fs';
import path from 'node:path';
import { extractInteractionEntityPair } from '../src/lib/queryIntent';

type MatrixEntry = {
  category: string;
  question: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
};

type QueryFlags = {
  hasMadcapTestTypeList: boolean;
  hasAppendix1321: boolean;
  hasWeakBoilerplate: boolean;
};

type QueryChecks = {
  hasNonEmptyAnswer: boolean;
  hasVisibleAnswerToken: boolean;
  hasSources: boolean;
  hasSourceCitations: boolean;
  hasCanonicalAuthoritySignal: boolean;
};

type InteractionDiagnostics = {
  tier1Count: number;
  tier2Count: number;
  tier3Count: number;
  uniqueDocCount: number;
  hasMechanismChunk?: boolean;
  tierBalanceRatio?: string;
  tier1and2Pct?: number;
};

type QueryResult = {
  category: string;
  question: string;
  answer: string;
  citationsInAnswer: string[];
  topSources: Array<{
    citation_label: string;
    doc_title: string;
    section_title: string;
    source_type: string | null;
  }>;
  sourceCount: number;
  interactionDiagnostics?: InteractionDiagnostics;
  flags: QueryFlags;
  checks: QueryChecks;
  failures: string[];
  error?: string;
};

const INTERACTION_MECHANISM_REGEX =
  /\b(integration|interface|web\s*service|api|middleware|automatic\s*(?:data\s*)?entry|import|export|file\s*transfer|setup|configuration|connection|protocol|trigger|flow|exchange|result\s*entry)\b/i;

function entityMentioned(corpus: string, entity?: string): boolean {
  if (!entity?.trim()) return false;
  const escaped = entity.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(corpus);
}

function buildInteractionDiagnostics(
  question: string,
  sources: Array<{
    citation_label?: string;
    doc_title?: string;
    section_title?: string;
    source_type?: string | null;
    content_preview?: string;
    content?: string;
  }>,
): InteractionDiagnostics {
  const pair = extractInteractionEntityPair(question);
  const hasPair = Boolean(pair?.systemA && pair?.systemB);
  const uniqueDocs = new Set<string>();
  let tier1Count = 0;
  let tier2Count = 0;
  let tier3Count = 0;

  for (const source of sources) {
    const corpus = [
      source.citation_label ?? '',
      source.doc_title ?? '',
      source.section_title ?? '',
      source.content_preview ?? '',
      source.content ?? '',
    ].join(' ');

    if (source.doc_title) {
      uniqueDocs.add(source.doc_title);
    }

    const hasA = entityMentioned(corpus, pair?.systemA);
    const hasB = entityMentioned(corpus, pair?.systemB);
    const hasMechanism = INTERACTION_MECHANISM_REGEX.test(corpus);

    if (hasA && hasB) {
      tier1Count += 1;
    } else if (hasMechanism && (!hasPair || hasA || hasB)) {
      tier2Count += 1;
    } else {
      tier3Count += 1;
    }
  }

  const totalSources = tier1Count + tier2Count + tier3Count;
  const hasMechanismChunk = tier1Count > 0 || tier2Count > 0;
  const tier1and2Pct = totalSources > 0
    ? Number(((tier1Count + tier2Count) / totalSources * 100).toFixed(0))
    : 0;

  return {
    tier1Count,
    tier2Count,
    tier3Count,
    uniqueDocCount: uniqueDocs.size,
    hasMechanismChunk,
    tier1and2Pct,
  };
}

type CategorySummary = {
  category: string;
  count: number;
  failures: number;
  nonEmptyAnswers: number;
  avgSourceCount: number;
};

type Report = {
  generatedAt: string;
  matrixSize: number;
  requiredCategories: string[];
  coveredCategories: string[];
  missingCategories: string[];
  results: QueryResult[];
  categorySummary: CategorySummary[];
  acceptance: Record<string, boolean>;
  summary: {
    totalQueries: number;
    failedQueries: number;
    passRate: number;
  };
};

const BASE_URL = 'http://localhost:3000/api/chat';
const MATRIX_PATH = path.join(process.cwd(), 'scripts/runtime-coverage-matrix.json');
const OUT_DIR = path.join(process.cwd(), 'docs/reports/2026-04-19-live-validation');
const DEFAULT_OUT_FILE = path.join(OUT_DIR, 'chat-runtime-broad-coverage.json');
const QUERY_TIMEOUT_MS = 120_000;
const MAX_ATTEMPTS = 2;

const REQUIRED_CATEGORIES = [
  'catalogue/list',
  'forms',
  'codes',
  'registers',
  'mappings',
  'program lists',
  'appendix / structural',
  'appendix content',
  'section-number questions',
  'table questions',
  'rules / validation',
  'operational rules',
  'acceptance criteria',
  'release conditions',
  'definitions',
  'what is X',
  'what does Y do',
  'process',
  'comparison',
  'ambiguous reference',
  'negative / sparse',
  'interaction / direct integration',
  'interaction / middleware',
  'interaction / file-based',
  'interaction / reporting',
  'interaction / generic',
  'interaction / ambiguous',
  'interaction / indirect',
  'interaction / weak evidence',
  'interaction / follow-up chain',
  'interaction / cross-system',
  'interaction / failure-path',
  'interaction / pattern',
  'interaction / it-ot integration',
  'interaction / reporting-export',
  'interaction / billing-downstream',
  'interaction / data-platform-analytics',
  'procedural / non-madcap',
];

function hasVisibleAnswerToken(answer: string): boolean {
  const normalized = answer
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/[*_`~>|\-]+/g, ' ')
    .trim();

  return /[A-Za-z0-9]{2,}/.test(normalized);
}

function evaluateFailures(category: string, checks: QueryChecks): string[] {
  const failures: string[] = [];

  if (!checks.hasNonEmptyAnswer) failures.push('empty_answer');
  if (!checks.hasVisibleAnswerToken) failures.push('no_visible_answer_tokens');
  if (checks.hasSources && !checks.hasNonEmptyAnswer) failures.push('sources_present_but_answer_empty');
  if (checks.hasSourceCitations && !checks.hasNonEmptyAnswer) failures.push('source_citations_present_but_answer_empty');

  const categoryLower = category.toLowerCase();
  const isCanonicalLike =
    categoryLower.includes('catalogue') ||
    categoryLower.includes('codes') ||
    categoryLower.includes('appendix') ||
    categoryLower.includes('mapping') ||
    categoryLower.includes('register');

  if (isCanonicalLike && checks.hasCanonicalAuthoritySignal && !checks.hasNonEmptyAnswer) {
    failures.push('authoritative_signal_but_empty_answer');
  }

  return failures;
}

function loadMatrix(): MatrixEntry[] {
  const parsed = JSON.parse(fs.readFileSync(MATRIX_PATH, 'utf8')) as MatrixEntry[];
  return parsed.filter((entry) => entry.category && entry.question);
}

function resolveOutFile(): string {
  const argIndex = process.argv.findIndex((arg) => arg === '--out');
  const outArg =
    argIndex >= 0
      ? process.argv[argIndex + 1]
      : process.argv.find((arg) => arg.startsWith('--out='))?.slice('--out='.length);

  if (!outArg || outArg.trim().length === 0) {
    return DEFAULT_OUT_FILE;
  }

  return path.isAbsolute(outArg) ? outArg : path.join(OUT_DIR, outArg);
}

async function assertApiReachable(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const res = await fetch(BASE_URL, {
      method: 'GET',
      signal: controller.signal,
    });

    // 404/405 still prove the app is up and route is mounted.
    if (![200, 400, 404, 405].includes(res.status)) {
      throw new Error(`Unexpected health status ${res.status}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`API unreachable at ${BASE_URL}: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function ask(entry: MatrixEntry): Promise<QueryResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), QUERY_TIMEOUT_MS);

  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      question: entry.question,
      modelTier: 'default',
      conversationHistory: entry.conversationHistory ?? [],
    }),
    signal: controller.signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let answer = '';
  let sources: Array<{
    citation_label?: string;
    doc_title?: string;
    section_title?: string;
    source_type?: string | null;
  }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const events = buf.split('\n\n');
    buf = events.pop() || '';

    for (const raw of events) {
      const lines = raw.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) continue;

      const event = eventLine.slice(7).trim();
      const data = JSON.parse(dataLine.slice(6));

      if (event === 'token' && data?.text) {
        answer += data.text;
      } else if (event === 'sources' && Array.isArray(data?.chunks)) {
        sources = data.chunks;
      }
    }
  }

  clearTimeout(timeout);

  const citationsInAnswer = Array.from(
    new Set(
      (answer.match(/\[Source:\s*([^\]]+)\]/g) || []).map((citation) =>
        citation.replace(/^\[Source:\s*/, '').replace(/\]$/, ''),
      ),
    ),
  );

  const sourceText = JSON.stringify(sources).toLowerCase();
  const answerText = answer.toLowerCase();

  const flags: QueryFlags = {
    hasMadcapTestTypeList:
      sourceText.includes('madcap test type list') || answerText.includes('madcap test type list'),
    hasAppendix1321: sourceText.includes('13.2.1') || answerText.includes('13.2.1'),
    hasWeakBoilerplate: /available sources do not fully cover|do not provide comprehensive details/i.test(answer),
  };

  const checks: QueryChecks = {
    hasNonEmptyAnswer: answer.trim().length > 0,
    hasVisibleAnswerToken: hasVisibleAnswerToken(answer),
    hasSources: sources.length > 0,
    hasSourceCitations: sources.some((source) => Boolean(source.citation_label && source.citation_label.trim().length > 0)),
    hasCanonicalAuthoritySignal: flags.hasMadcapTestTypeList || flags.hasAppendix1321,
  };

  return {
    category: entry.category,
    question: entry.question,
    answer,
    citationsInAnswer,
    topSources: sources.slice(0, 8).map((source) => ({
      citation_label: source.citation_label ?? '',
      doc_title: source.doc_title ?? '',
      section_title: source.section_title ?? '',
      source_type: source.source_type ?? null,
    })),
    sourceCount: sources.length,
    interactionDiagnostics: entry.category.toLowerCase().startsWith('interaction')
      ? buildInteractionDiagnostics(entry.question, sources)
      : undefined,
    flags,
    checks,
    failures: evaluateFailures(entry.category, checks),
  };
}

async function askWithRetry(entry: MatrixEntry): Promise<QueryResult> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await ask(entry);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const isRetryable = /aborted|timeout|network|fetch failed/i.test(message);
      if (!isRetryable || attempt === MAX_ATTEMPTS) {
        throw error;
      }
      console.log(`[retry] ${entry.category}: attempt ${attempt + 1} after ${message}`);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Unknown query failure');
}

function buildCategorySummary(results: QueryResult[]): CategorySummary[] {
  const grouped = new Map<string, QueryResult[]>();
  for (const result of results) {
    const existing = grouped.get(result.category) ?? [];
    existing.push(result);
    grouped.set(result.category, existing);
  }

  return Array.from(grouped.entries())
    .map(([category, rows]) => {
      const totalSources = rows.reduce((sum, row) => sum + row.sourceCount, 0);
      return {
        category,
        count: rows.length,
        failures: rows.filter((row) => row.failures.length > 0).length,
        nonEmptyAnswers: rows.filter((row) => row.checks.hasNonEmptyAnswer).length,
        avgSourceCount: Number((totalSources / rows.length).toFixed(2)),
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category));
}

async function main() {
  const outFile = resolveOutFile();
  await assertApiReachable();

  const matrix = loadMatrix();
  const results: QueryResult[] = [];

  for (const entry of matrix) {
    try {
      const result = await askWithRetry(entry);
      results.push(result);
      if (result.interactionDiagnostics) {
        const d = result.interactionDiagnostics;
        console.log(
          `[diag] ${entry.category}: sources=${result.sourceCount}, tier1=${d.tier1Count}, tier2=${d.tier2Count}, tier3=${d.tier3Count}, tier1+2=${d.tier1and2Pct ?? 0}%, mechanism=${d.hasMechanismChunk ?? false}, docs=${d.uniqueDocCount}`,
        );
      }
      console.log(`[done] ${entry.category}: ${entry.question}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failedResult: QueryResult = {
        category: entry.category,
        question: entry.question,
        answer: '',
        citationsInAnswer: [],
        topSources: [],
        sourceCount: 0,
        flags: {
          hasMadcapTestTypeList: false,
          hasAppendix1321: false,
          hasWeakBoilerplate: false,
        },
        checks: {
          hasNonEmptyAnswer: false,
          hasVisibleAnswerToken: false,
          hasSources: false,
          hasSourceCitations: false,
          hasCanonicalAuthoritySignal: false,
        },
        failures: ['query_error'],
        error: message,
      };
      results.push(failedResult);
      console.log(`[error] ${entry.category}: ${entry.question} :: ${message}`);
    }
  }

  const coveredCategorySet = new Set(results.map((result) => result.category));
  const coveredCategories = Array.from(coveredCategorySet).sort((a, b) => a.localeCompare(b));
  const missingCategories = REQUIRED_CATEGORIES.filter((category) => !coveredCategorySet.has(category));

  const failedQueries = results.filter((result) => result.failures.length > 0).length;
  const passRate = results.length > 0 ? Number((((results.length - failedQueries) / results.length) * 100).toFixed(2)) : 0;

  const allAnswersNonEmptyAndVisible = results.every(
    (result) => result.checks.hasNonEmptyAnswer && result.checks.hasVisibleAnswerToken,
  );
  const noSourcesWithEmptyAnswers = results.every(
    (result) => !(result.checks.hasSources && !result.checks.hasNonEmptyAnswer),
  );
  const noSourceCitationsWithEmptyAnswers = results.every(
    (result) => !(result.checks.hasSourceCitations && !result.checks.hasNonEmptyAnswer),
  );

  const categorySummary = buildCategorySummary(results);
  const interactionResults = results.filter((result) => result.category.toLowerCase().startsWith('interaction'));
  const interactionFollowUpResults = results.filter((result) => result.category.toLowerCase() === 'interaction / follow-up chain');

  // Evaluate interaction quality on evidence-bearing queries only.
  // Very sparse (1-2 source) interaction queries are tracked, but excluded from strict ratio guards.
  const interactionGuardEligible = interactionResults.filter((result) => {
    if (!result.interactionDiagnostics) return false;
    const totalTiers = result.interactionDiagnostics.tier1Count
      + result.interactionDiagnostics.tier2Count
      + result.interactionDiagnostics.tier3Count;
    return totalTiers >= 5;
  });

  const interactionTierPctValues = interactionGuardEligible.map((result) => {
    const diagnostics = result.interactionDiagnostics!;
    const totalTiers = diagnostics.tier1Count + diagnostics.tier2Count + diagnostics.tier3Count;
    return totalTiers > 0 ? ((diagnostics.tier1Count + diagnostics.tier2Count) / totalTiers) * 100 : 0;
  });

  const interactionMechanismFlags = interactionGuardEligible.map((result) => {
    const diagnostics = result.interactionDiagnostics!;
    return diagnostics.tier1Count > 0 || diagnostics.tier2Count > 0;
  });

  const avgInteractionTierPct = interactionTierPctValues.length > 0
    ? interactionTierPctValues.reduce((sum, value) => sum + value, 0) / interactionTierPctValues.length
    : 0;

  const pctInteractionQueriesAbove60 = interactionTierPctValues.length > 0
    ? (interactionTierPctValues.filter((value) => value >= 60).length / interactionTierPctValues.length) * 100
    : 0;

  const pctInteractionMechanismPresent = interactionMechanismFlags.length > 0
    ? (interactionMechanismFlags.filter(Boolean).length / interactionMechanismFlags.length) * 100
    : 0;

  // Regression guard 1: stable tier distribution across eligible interaction queries.
  const interactionTierHealthy = avgInteractionTierPct >= 55 && pctInteractionQueriesAbove60 >= 60;

  // Regression guard 2: mechanism coverage remains high across eligible interaction queries.
  const interactionMechanismHealthy = pctInteractionMechanismPresent >= 90;

  const report: Report = {
    generatedAt: new Date().toISOString(),
    matrixSize: matrix.length,
    requiredCategories: REQUIRED_CATEGORIES,
    coveredCategories,
    missingCategories,
    results,
    categorySummary,
    acceptance: {
      allRequiredCategoriesCovered: missingCategories.length === 0,
      allAnswersNonEmptyAndVisible,
      noSourcesWithEmptyAnswers,
      noSourceCitationsWithEmptyAnswers,
      rulesNoWeakBoilerplate: results
        .filter((result) => result.category.toLowerCase().includes('rule') || result.category.toLowerCase().includes('validation'))
        .every((result) => !result.flags.hasWeakBoilerplate),
      noObviousSourceSpam: results.every((result) => result.sourceCount <= 24),
      interactionQueriesProduceNonEmptyAnswers: results
        .filter((result) => result.category.toLowerCase().startsWith('interaction'))
        .every((result) => result.checks.hasNonEmptyAnswer && result.checks.hasVisibleAnswerToken),
      interactionSourceCapRespected: interactionResults.every((result) => result.sourceCount <= 20),
      followUpChainQueriesProduceAnswers: interactionFollowUpResults.every(
        (result) => result.checks.hasNonEmptyAnswer && result.checks.hasVisibleAnswerToken,
      ),
      interactionTierDistributionHealthy: interactionTierHealthy,
      interactionMechanismDetectionHealthy: interactionMechanismHealthy,
    },
    summary: {
      totalQueries: results.length,
      failedQueries,
      passRate,
    },
  };

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(
    JSON.stringify(
      {
        outFile,
        acceptance: report.acceptance,
        summary: report.summary,
        missingCategories,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
