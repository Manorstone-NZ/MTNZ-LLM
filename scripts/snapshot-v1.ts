import { config } from 'dotenv';
config({ path: '.env.local' });

async function main() {
  const sql = (await import('../src/lib/db.js')).default;

  // Capture v1 metrics
  const [docCounts] = await sql`SELECT count(*) as total, count(*) FILTER (WHERE extraction_status = 'completed') as completed, count(*) FILTER (WHERE extraction_status = 'failed') as failed FROM documents WHERE is_active = true`;
  const [chunkCounts] = await sql`SELECT count(*) as total, avg(token_count)::numeric(10,1) as avg_tokens FROM chunks`;
  const chunkBuckets = await sql`
    SELECT
      CASE
        WHEN token_count < 20 THEN 'under_20'
        WHEN token_count < 50 THEN '20_to_49'
        WHEN token_count < 100 THEN '50_to_99'
        WHEN token_count < 200 THEN '100_to_199'
        WHEN token_count < 500 THEN '200_to_499'
        ELSE '500_plus'
      END as bucket,
      count(*) as count
    FROM chunks GROUP BY 1 ORDER BY min(token_count)
  `;

  const snapshot = {
    timestamp: new Date().toISOString(),
    version: 'v1',
    documents: { total: Number(docCounts.total), completed: Number(docCounts.completed), failed: Number(docCounts.failed) },
    chunks: { total: Number(chunkCounts.total), avg_tokens: Number(chunkCounts.avg_tokens) },
    chunk_distribution: Object.fromEntries(chunkBuckets.map((b: any) => [b.bucket, Number(b.count)])),
  };

  console.log(JSON.stringify(snapshot, null, 2));
  process.exit(0);
}
main();
