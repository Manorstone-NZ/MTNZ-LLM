import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync } from 'fs';

async function main() {
  const snapshotPath = process.argv[2];
  if (!snapshotPath) { console.error('Usage: npx tsx scripts/compare-metrics.ts <snapshot.json>'); process.exit(1); }

  const v1 = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
  const sql = (await import('../src/lib/db.js')).default;

  // V2 metrics
  const [v2Docs] = await sql`SELECT count(*) as total, count(*) FILTER (WHERE extraction_status = 'completed') as completed FROM documents WHERE is_active = true AND pipeline_version = 'v2'`;
  const [v2Chunks] = await sql`SELECT count(*) as total, avg(token_count)::numeric(10,1) as avg_tokens FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE is_active = true AND pipeline_version = 'v2') AND retrieval_excluded = false`;
  const [v2Excluded] = await sql`SELECT count(*) as total FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE is_active = true AND pipeline_version = 'v2') AND retrieval_excluded = true`;
  const v2Buckets = await sql`
    SELECT
      CASE WHEN token_count < 20 THEN 'under_20' WHEN token_count < 50 THEN '20_to_49' WHEN token_count < 100 THEN '50_to_99' WHEN token_count < 200 THEN '100_to_199' WHEN token_count < 500 THEN '200_to_499' ELSE '500_plus' END as bucket,
      count(*) as count
    FROM chunks WHERE document_id IN (SELECT id FROM documents WHERE is_active = true AND pipeline_version = 'v2') AND retrieval_excluded = false GROUP BY 1 ORDER BY min(token_count)
  `;

  console.log('\n=== V1 vs V2 Comparison ===\n');
  console.log(`Documents:    v1=${v1.documents.total}  v2=${v2Docs.total}`);
  console.log(`Chunks (retrieval):  v1=${v1.chunks.total}  v2=${v2Chunks.total}`);
  console.log(`Excluded chunks:     v2=${v2Excluded.total}`);
  console.log(`Avg tokens:   v1=${v1.chunks.avg_tokens}  v2=${v2Chunks.avg_tokens}`);

  console.log('\nChunk distribution (retrieval-eligible):');
  const v2Dist: Record<string, number> = Object.fromEntries(v2Buckets.map((b: any) => [b.bucket, Number(b.count)]));
  for (const bucket of ['under_20', '20_to_49', '50_to_99', '100_to_199', '200_to_499', '500_plus']) {
    console.log(`  ${bucket}: v1=${v1.chunk_distribution[bucket] || 0}  v2=${v2Dist[bucket] || 0}`);
  }

  // Acceptance criteria checks
  const totalRetrieval = Number(v2Chunks.total);
  const under50 = (v2Dist['under_20'] || 0) + (v2Dist['20_to_49'] || 0);
  const under20 = v2Dist['under_20'] || 0;

  console.log('\n=== Acceptance Criteria ===');
  console.log(`Under 50 tokens: ${under50} / ${totalRetrieval} = ${(under50/totalRetrieval*100).toFixed(1)}% (target: <15%)`);
  console.log(`Under 20 tokens: ${under20} / ${totalRetrieval} = ${(under20/totalRetrieval*100).toFixed(1)}% (target: <2%)`);
  console.log(`Avg token count: ${v2Chunks.avg_tokens} (target: >150)`);

  process.exit(0);
}
main();
