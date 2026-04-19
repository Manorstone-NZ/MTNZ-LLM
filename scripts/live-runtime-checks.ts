import fs from 'node:fs';
import path from 'node:path';

type SuiteName = 'canonical' | 'rules' | 'regression';

type QueryFlags = {
  hasMadcapTestTypeList: boolean;
  hasAppendix1321: boolean;
  hasWeakBoilerplate: boolean;
};

type QueryResult = {
  suite: SuiteName;
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
  flags: QueryFlags;
  checks: {
    hasNonEmptyAnswer: boolean;
    hasVisibleAnswerToken: boolean;
    hasSources: boolean;
    hasSourceCitations: boolean;
    hasCanonicalAuthoritySignal: boolean;
  };
  failures: string[];
};

type Report = {
  generatedAt: string;
  suites: Record<SuiteName, QueryResult[]>;
  acceptance: Record<string, boolean>;
  summary: {
    totalQueries: number;
    failedQueries: number;
    failedBySuite: Record<SuiteName, number>;
  };
};

const baseUrl = 'http://localhost:3000/api/chat';

const suites: Record<SuiteName, string[]> = {
  canonical: [
    'What MADCAP tests are there?',
    'Show the full list of MADCAP test types.',
    'What test codes are defined for MADCAP?',
    'What is in Appendix 13.2.1?',
  ],
  rules: [
    'What operational rules and validation conditions for MADCAP are described across the corpus?',
    'Summarise the MADCAP-related validation conditions, entry requirements, release criteria, and exceptions across the manuals.',
  ],
  regression: [
    'What is MADCAP?',
    'What is the result release process?',
    'What is section 7.2 about?',
  ],
};

function hasVisibleAnswerToken(answer: string): boolean {
  const normalized = answer
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/[*_`~>|\-]+/g, ' ')
    .trim();

  return /[A-Za-z0-9]{2,}/.test(normalized);
}

function evaluateFailures(result: Omit<QueryResult, 'failures'>): string[] {
  const failures: string[] = [];
  const { suite, checks } = result;

  if (!checks.hasNonEmptyAnswer) {
    failures.push('empty_answer');
  }

  if (!checks.hasVisibleAnswerToken) {
    failures.push('no_visible_answer_tokens');
  }

  if (checks.hasSources && !checks.hasNonEmptyAnswer) {
    failures.push('sources_present_but_answer_empty');
  }

  if (checks.hasSourceCitations && !checks.hasNonEmptyAnswer) {
    failures.push('source_citations_present_but_answer_empty');
  }

  if (suite === 'canonical' && checks.hasCanonicalAuthoritySignal && !checks.hasNonEmptyAnswer) {
    failures.push('canonical_authoritative_sources_but_empty_answer');
  }

  return failures;
}

async function ask(suite: SuiteName, question: string): Promise<QueryResult> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ question, modelTier: 'default' }),
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

  const checks = {
    hasNonEmptyAnswer: answer.trim().length > 0,
    hasVisibleAnswerToken: hasVisibleAnswerToken(answer),
    hasSources: sources.length > 0,
    hasSourceCitations: sources.some((source) => Boolean(source.citation_label && source.citation_label.trim().length > 0)),
    hasCanonicalAuthoritySignal: flags.hasMadcapTestTypeList || flags.hasAppendix1321,
  };

  const partial: Omit<QueryResult, 'failures'> = {
    suite,
    question,
    answer,
    citationsInAnswer,
    topSources: sources.slice(0, 8).map((source) => ({
      citation_label: source.citation_label ?? '',
      doc_title: source.doc_title ?? '',
      section_title: source.section_title ?? '',
      source_type: source.source_type ?? null,
    })),
    sourceCount: sources.length,
    flags,
    checks,
  };

  return {
    ...partial,
    failures: evaluateFailures(partial),
  };
}

async function main() {
  const report: Report = {
    generatedAt: new Date().toISOString(),
    suites: {
      canonical: [],
      rules: [],
      regression: [],
    },
    acceptance: {},
    summary: {
      totalQueries: 0,
      failedQueries: 0,
      failedBySuite: {
        canonical: 0,
        rules: 0,
        regression: 0,
      },
    },
  };

  for (const [suite, questions] of Object.entries(suites) as Array<[SuiteName, string[]]>) {
    for (const question of questions) {
      const result = await ask(suite, question);
      report.suites[suite].push(result);
      console.log(`[done] ${suite}: ${question}`);
    }
  }

  const canonicalResults = report.suites.canonical;
  const rulesResults = report.suites.rules;
  const regressionResults = report.suites.regression;

  const all = [...canonicalResults, ...rulesResults, ...regressionResults];
  const allHaveNonEmptyVisibleAnswer = all.every((result) => result.checks.hasNonEmptyAnswer && result.checks.hasVisibleAnswerToken);
  const noSourcesWithEmptyAnswers = all.every((result) => !(result.checks.hasSources && !result.checks.hasNonEmptyAnswer));
  const noCitationsWithEmptyAnswers = all.every((result) => !(result.checks.hasSourceCitations && !result.checks.hasNonEmptyAnswer));
  const canonicalAuthorityNeverEmpty = canonicalResults.every(
    (result) => !(result.checks.hasCanonicalAuthoritySignal && !result.checks.hasNonEmptyAnswer),
  );

  report.acceptance = {
    canonicalQuestionsCiteAuthoritativeSource: canonicalResults.every(
      (result) => result.flags.hasMadcapTestTypeList || result.flags.hasAppendix1321,
    ),
    distributedListConsolidatesWithoutExampleOnlyFallback: canonicalResults.some((result) =>
      /consolidated|grouped|categories|test type/i.test(result.answer),
    ),
    rulesNoWeakBoilerplateWhenEvidenceStrong: rulesResults.every((result) => !result.flags.hasWeakBoilerplate),
    normalFactualQueriesNotOverSynthesized: regressionResults.every(
      (result) => !/corpus-derived consolidated|authoritative source/i.test(result.answer),
    ),
    noObviousSourceSpam: all.every((result) => result.sourceCount <= 24),
    allAnswersNonEmptyAndVisible: allHaveNonEmptyVisibleAnswer,
    noSourcesWithEmptyAnswers,
    noSourceCitationsWithEmptyAnswers: noCitationsWithEmptyAnswers,
    canonicalAuthoritativeSignalsRequireAnswer: canonicalAuthorityNeverEmpty,
  };

  report.summary.totalQueries = all.length;
  report.summary.failedQueries = all.filter((result) => result.failures.length > 0).length;
  report.summary.failedBySuite = {
    canonical: canonicalResults.filter((result) => result.failures.length > 0).length,
    rules: rulesResults.filter((result) => result.failures.length > 0).length,
    regression: regressionResults.filter((result) => result.failures.length > 0).length,
  };

  const outDir = path.join(process.cwd(), 'docs/reports/2026-04-19-live-validation');
  fs.mkdirSync(outDir, { recursive: true });

  const outFile = path.join(outDir, 'chat-runtime-checks.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

  console.log(
    JSON.stringify(
      {
        outFile,
        acceptance: report.acceptance,
        summary: report.summary,
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
