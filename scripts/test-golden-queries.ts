import { config } from 'dotenv';
config({ path: '.env.local' });
import { readFileSync } from 'fs';

async function main() {
  const { hybridSearch } = await import('../src/lib/retrieval.js');

  const queries = JSON.parse(readFileSync('scripts/golden-queries.json', 'utf-8'));
  for (const q of queries) {
    const results = await hybridSearch(q.query);
    const topDocs = results.slice(0, 3).map((r: any) => r.doc_title?.substring(0, 60));
    const scores = results.slice(0, 3).map((r: any) => r.score.toFixed(3));
    const downranked = results.filter((r: any) => r.retrieval_downranked);
    console.log(`[${q.type}] ${q.query}`);
    console.log(`  Top 3: ${topDocs.join(' | ')}`);
    console.log(`  Scores: ${scores.join(', ')}`);
    console.log(`  Downranked in results: ${downranked.length}`);
    console.log('');
  }
  process.exit(0);
}
main();
