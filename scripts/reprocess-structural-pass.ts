import * as fs from 'fs';

interface CohortDoc {
  id: string;
  title: string;
}

function parseArg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

async function reprocessDocument(documentId: string, title: string, baseUrl: string): Promise<boolean> {
  try {
    console.log(`[structural-reprocess] -> ${title}`);

    const response = await fetch(`${baseUrl}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'reprocess_one',
        documentId,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[structural-reprocess] HTTP ${response.status}: ${body}`);
      return false;
    }

    const reader = response.body?.getReader();
    if (!reader) return false;

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const payload = JSON.parse(line.slice(6));
          if (payload.status) console.log(`   ${payload.status}`);
        } catch {
          // Ignore malformed progress events.
        }
      }
    }

    return true;
  } catch (err) {
    console.error(`[structural-reprocess] Exception for ${title}:`, err);
    return false;
  }
}

async function main() {
  const inputPath = parseArg('--input')
    ?? 'docs/reports/2026-04-20-live-validation/structural-quality-analysis-before.json';
  const baseUrl = parseArg('--baseUrl') ?? process.env.API_BASE_URL ?? 'http://localhost:3000';

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input artifact not found: ${inputPath}`);
  }

  const artifact = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as {
    per_document?: Array<{ id: string; title: string }>;
  };

  const cohort: CohortDoc[] = (artifact.per_document ?? []).map((doc) => ({
    id: doc.id,
    title: doc.title,
  }));

  console.log(`[structural-reprocess] Cohort size: ${cohort.length}`);

  let success = 0;
  let failed = 0;

  for (const doc of cohort) {
    const ok = await reprocessDocument(doc.id, doc.title, baseUrl);
    if (ok) success += 1;
    else failed += 1;
  }

  console.log(`[structural-reprocess] Success: ${success}`);
  console.log(`[structural-reprocess] Failed: ${failed}`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[structural-reprocess] Fatal:', err);
  process.exit(1);
});