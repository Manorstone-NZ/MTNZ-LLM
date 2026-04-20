import fs from 'node:fs';
import path from 'node:path';

type AnswerStyle = 'concise' | 'detailed';

type TestCase = {
  category: string;
  question: string;
};

type QueryRun = {
  mode: 'default' | AnswerStyle;
  answer: string;
  answerChars: number;
  sentenceCount: number;
  sourceCount: number;
  citationsInAnswer: number;
  hasNonEmptyAnswer: boolean;
  hasVisibleAnswerToken: boolean;
};

type CaseResult = {
  category: string;
  question: string;
  runs: QueryRun[];
  checks: {
    conciseShorterThanDetailed: boolean;
    defaultLeansConcise: boolean;
    allModesGrounded: boolean;
    allModesNonEmpty: boolean;
  };
};

type Report = {
  generatedAt: string;
  baseUrl: string;
  cases: CaseResult[];
  acceptance: {
    conciseShorterInAllCases: boolean;
    defaultLeansConciseInMostCases: boolean;
    allModesGroundedAcrossCases: boolean;
    allModesNonEmptyAcrossCases: boolean;
  };
};

const BASE_URL = 'http://localhost:3000/api/chat';
const OUT_DIR = path.join(process.cwd(), 'docs/reports/2026-04-19-live-validation');
const OUT_FILE = path.join(OUT_DIR, 'answer-style-integration.json');

const CASES: TestCase[] = [
  {
    category: 'interaction / it-ot integration',
    question: 'How does the integration chain connect instrument outputs into IT systems for release workflows?',
  },
  {
    category: 'interaction / reporting-export',
    question: 'How are result exports prepared for downstream reporting consumers?',
  },
  {
    category: 'interaction / billing-downstream',
    question: 'How do released results connect to billing or invoicing downstream in SAP pathways?',
  },
  {
    category: 'interaction / data-platform-analytics',
    question: 'How are lab results integrated into ODS or Qlik analytics layers?',
  },
  {
    category: 'procedural / non-madcap',
    question: 'Summarise corpus-level sample-to-release procedures in system-neutral terms.',
  },
];

function hasVisibleAnswerToken(answer: string): boolean {
  const normalized = answer
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/[*_`~>|\-]+/g, ' ')
    .trim();

  return /[A-Za-z0-9]{2,}/.test(normalized);
}

function sentenceCount(answer: string): number {
  const parts = answer
    .split(/[.!?]\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return parts.length;
}

async function ask(question: string, mode: 'default' | AnswerStyle): Promise<QueryRun> {
  const body: Record<string, unknown> = {
    question,
    modelTier: 'default',
  };

  if (mode !== 'default') {
    body.answerStyle = mode;
  }

  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let sources: Array<{ citation_label?: string }> = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const raw of events) {
      const lines = raw.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!eventLine || !dataLine) continue;

      const event = eventLine.slice(7).trim();
      const data = JSON.parse(dataLine.slice(6));

      if (event === 'token' && typeof data?.text === 'string') {
        answer += data.text;
      } else if (event === 'sources' && Array.isArray(data?.chunks)) {
        sources = data.chunks;
      }
    }
  }

  const citationMatches = answer.match(/\[Source:\s*[^\]]+\]/g) ?? [];

  return {
    mode,
    answer,
    answerChars: answer.trim().length,
    sentenceCount: sentenceCount(answer),
    sourceCount: sources.length,
    citationsInAnswer: citationMatches.length,
    hasNonEmptyAnswer: answer.trim().length > 0,
    hasVisibleAnswerToken: hasVisibleAnswerToken(answer),
  };
}

async function main() {
  const cases: CaseResult[] = [];

  for (const entry of CASES) {
    const defaultRun = await ask(entry.question, 'default');
    const conciseRun = await ask(entry.question, 'concise');
    const detailedRun = await ask(entry.question, 'detailed');

    const checks = {
      conciseShorterThanDetailed: conciseRun.answerChars < detailedRun.answerChars,
      defaultLeansConcise:
        Math.abs(defaultRun.answerChars - conciseRun.answerChars)
        <= Math.abs(defaultRun.answerChars - detailedRun.answerChars),
      allModesGrounded:
        [defaultRun, conciseRun, detailedRun].every((run) => run.sourceCount > 0 && run.citationsInAnswer > 0),
      allModesNonEmpty:
        [defaultRun, conciseRun, detailedRun].every((run) => run.hasNonEmptyAnswer && run.hasVisibleAnswerToken),
    };

    const caseResult: CaseResult = {
      category: entry.category,
      question: entry.question,
      runs: [defaultRun, conciseRun, detailedRun],
      checks,
    };

    cases.push(caseResult);
    console.log(`[done] ${entry.category}`);
  }

  const conciseShorterCount = cases.filter((result) => result.checks.conciseShorterThanDetailed).length;
  const defaultLeansConciseCount = cases.filter((result) => result.checks.defaultLeansConcise).length;

  const report: Report = {
    generatedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    cases,
    acceptance: {
      conciseShorterInAllCases: conciseShorterCount === cases.length,
      defaultLeansConciseInMostCases: defaultLeansConciseCount >= Math.ceil(cases.length * 0.6),
      allModesGroundedAcrossCases: cases.every((result) => result.checks.allModesGrounded),
      allModesNonEmptyAcrossCases: cases.every((result) => result.checks.allModesNonEmpty),
    },
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));

  console.log(
    JSON.stringify(
      {
        outFile: OUT_FILE,
        acceptance: report.acceptance,
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
