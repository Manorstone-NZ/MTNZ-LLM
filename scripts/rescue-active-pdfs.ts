import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local', quiet: true });

const sql = postgres(process.env.DATABASE_URL!);

async function main() {
  const { ingestDocuments } = await import('@/lib/ingestion');

  const sourcePath = process.env.SOURCE_PATH;
  if (!sourcePath) {
    throw new Error('SOURCE_PATH is not configured');
  }

  const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined;
  const matchArg = process.argv.find((arg) => arg.startsWith('--match='));
  const match = matchArg ? matchArg.split('=')[1].toLowerCase() : null;
  const typeArg = process.argv.find((arg) => arg.startsWith('--type='));
  const type = typeArg ? typeArg.split('=')[1].toLowerCase() : 'pdf';
  const docIdArg = process.argv.find((arg) => arg.startsWith('--doc-id='));
  const docId = docIdArg ? docIdArg.split('=')[1] : null;
  const sourcePathArg = process.argv.find((arg) => arg.startsWith('--source-path='));
  const sourcePathMatch = sourcePathArg ? sourcePathArg.split('=')[1] : null;
  const allActive = process.argv.includes('--all-active');

  const activeDocs = await sql<{ id: string; source_path: string; title: string; source_type: string }[]>`
    SELECT id, source_path, title, source_type
    FROM documents
    WHERE is_active = true
      ${allActive ? sql`` : sql`AND lower(source_type) = ${type}`}
    ORDER BY title ASC
  `;

  let matchedDocs = Array.from(activeDocs);

  if (docId) {
    matchedDocs = matchedDocs.filter((doc) => doc.id === docId);
  }

  if (sourcePathMatch) {
    matchedDocs = matchedDocs.filter((doc) => doc.source_path === sourcePathMatch);
  }

  if (match) {
    matchedDocs = matchedDocs.filter((doc) =>
      doc.title.toLowerCase().includes(match) || doc.source_path.toLowerCase().includes(match),
    );
  }

  const docs = Number.isFinite(limit) ? matchedDocs.slice(0, limit) : matchedDocs;

  console.error(
    `Rescuing ${docs.length} active ${allActive ? 'documents' : `${type.toUpperCase()} documents`}` +
    `${docId ? ` (doc-id: ${docId})` : ''}`,
  );

  let processed = 0;
  let failed = 0;

  for (const doc of docs) {
    console.error(`\n[rescue] ${doc.title} (${doc.source_type})`);
    try {
      const result = await ingestDocuments({
        sourcePath,
        forceReprocess: true,
        singleFile: doc.source_path,
      });

      processed += result.processed;
      failed += result.failed;
      console.error(`  processed=${result.processed} failed=${result.failed} skipped=${result.skipped}`);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  FAILED: ${message}`);
    }
  }

  console.log(JSON.stringify({
    total: docs.length,
    processed,
    failed,
  }, null, 2));

  await sql.end();
}

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await sql.end();
  process.exit(1);
});