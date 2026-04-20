import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import sql from '../src/lib/db';
import { ingestDocuments } from '../src/lib/ingestion';

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || '.env.local' });

function getArgValue(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

type CohortDoc = { id: string; title: string; source_path: string };

async function main() {
  const sourcePath = process.env.SOURCE_PATH;
  if (!sourcePath) {
    throw new Error('SOURCE_PATH is required to run selective reprocessing.');
  }

  const idsFrom = getArgValue('--ids-from');

  let ids: string[] = [];
  if (idsFrom) {
    const parsed = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), idsFrom), 'utf8')) as {
      per_document?: Array<{ id: string }>;
    };
    ids = (parsed.per_document ?? []).map((d) => d.id);
  }

  const docs = ids.length > 0
    ? await sql<CohortDoc[]>`
        SELECT DISTINCT ON (source_path)
          id::text,
          title,
          source_path
        FROM documents
        WHERE source_path IN (
          SELECT source_path FROM documents WHERE id::text IN ${sql(ids)}
        )
        ORDER BY source_path, is_active DESC, created_at DESC
      `
    : await sql<CohortDoc[]>`
        SELECT id::text, title, source_path
        FROM documents
        WHERE is_active = true
          AND text_quality_tier = 'partial'
          AND chunk_count > 0
          AND (excluded_chunk_count::numeric / chunk_count::numeric) >= 0.25
        ORDER BY (excluded_chunk_count::numeric / chunk_count::numeric) DESC,
                 excluded_chunk_count DESC,
                 title ASC
        LIMIT 20
      `;

  const total = docs.length;
  let processed = 0;

  for (const doc of docs) {
    processed += 1;
    console.log(`[${processed}/${total}] Reprocessing ${doc.title} (${doc.source_path})`);
    await ingestDocuments({
      sourcePath,
      forceReprocess: true,
      singleFile: doc.source_path,
    });
  }

  console.log(JSON.stringify({ processed: total }, null, 2));
  await sql.end({ timeout: 2 });
}

main().catch(async (err) => {
  console.error(err);
  await sql.end({ timeout: 2 });
  process.exit(1);
});
