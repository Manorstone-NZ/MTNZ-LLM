import { config } from 'dotenv';
config({ path: '.env.local' });

async function main() {
  const { readFileSync } = await import('fs');
  const { join } = await import('path');
  const { extractPdf } = await import('../src/lib/extraction/pdf.js');
  const { normalise } = await import('../src/lib/normalise/index.js');
  const { chunkProse } = await import('../src/lib/chunking/prose.js');

  const buf = readFileSync(join(process.env.SOURCE_PATH!, 'LOP/LOP-MC 001 (V1) MADCAP Procedures Manual.pdf'));
  const ex = await extractPdf(buf, 'LOP-MC 001.pdf');
  const norm = await normalise(ex.sections, 'LOP-MC 001', 'rebuild');
  const eligible = norm.sections.filter(s => !s.retrieval_excluded);
  const chunks = chunkProse(eligible, 'LOP-MC 001');
  const retrieval = chunks.filter(c => !c.retrieval_excluded);

  // Show 20 smallest chunks
  const smallest = [...retrieval].sort((a, b) => a.token_count - b.token_count).slice(0, 20);
  console.log('=== 20 SMALLEST RETRIEVAL CHUNKS ===');
  for (const c of smallest) {
    console.log(`${c.token_count}t | ${c.section_type || 'unknown'} | ${c.content.substring(0, 100).replace(/\n/g, ' ')}`);
  }

  // Distribution by section_type for small chunks
  const smallChunks = retrieval.filter(c => c.token_count < 50);
  const typeCounts: Record<string, number> = {};
  for (const c of smallChunks) {
    const t = c.section_type || 'unknown';
    typeCounts[t] = (typeCounts[t] || 0) + 1;
  }
  console.log('\n=== UNDER-50 CHUNKS BY TYPE ===');
  for (const [t, n] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${t}: ${n}`);
  }

  process.exit(0);
}
main();
