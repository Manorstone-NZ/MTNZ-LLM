import { config } from 'dotenv';
config({ path: '.env.local' });

async function main() {
  // Dynamic import so dotenv has loaded before db.ts reads DATABASE_URL
  const { ingestDocuments } = await import('../src/lib/ingestion');

  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const rebuild = args.includes('--rebuild');
  const fileIdx = args.indexOf('--file');
  const singleFile = fileIdx >= 0 ? args[fileIdx + 1] : undefined;

  const sourcePath = process.env.SOURCE_PATH;
  if (!sourcePath) {
    console.error('SOURCE_PATH not set in .env.local');
    process.exit(1);
  }

  console.log(`Ingesting from: ${sourcePath}`);
  if (force) console.log('  --force: reprocessing all files');
  if (rebuild) console.log('  --rebuild: two-pass mode enabled');
  if (singleFile) console.log(`  --file: ${singleFile}`);

  const result = await ingestDocuments({
    sourcePath,
    forceReprocess: force,
    singleFile,
    rebuild,
    onProgress: (e) => console.log(`[${e.status}] ${e.file} (${e.processed}/${e.total})`),
  });

  console.log(`\nIngest complete:`);
  console.log(`  Scanned: ${result.scanned}`);
  console.log(`  Processed: ${result.processed}`);
  console.log(`  Failed: ${result.failed}`);
  console.log(`  Skipped: ${result.skipped}`);

  // V2 metrics
  if (result.embedded_chunks !== undefined) {
    console.log(`\nV2 pipeline metrics:`);
    console.log(`  Quarantined docs: ${result.quarantined ?? 0}`);
    console.log(`  Embedded chunks: ${result.embedded_chunks}`);
    console.log(`  Excluded chunks: ${result.excluded_chunks ?? 0}`);
    console.log(`  Downranked chunks: ${result.downranked_chunks ?? 0}`);
    console.log(`  Skipped embeddings: ${result.skipped_embeddings ?? 0}`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
