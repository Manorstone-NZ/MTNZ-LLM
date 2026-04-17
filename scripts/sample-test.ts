import { config } from 'dotenv';
config({ path: '.env.local' });

async function main() {
  const { readFileSync } = await import('fs');
  const { join } = await import('path');
  const { extractPdf } = await import('../src/lib/extraction/pdf.js');
  const { extractDocx } = await import('../src/lib/extraction/docx.js');
  const { normalise } = await import('../src/lib/normalise/index.js');
  const { chunkProse } = await import('../src/lib/chunking/prose.js');

  const base = process.env.SOURCE_PATH!;

  const sampleFiles = [
    'LOP/LOP-MC 001 (V1) MADCAP Procedures Manual.pdf',
    'LOP/LOP-AH 002 (V6) Mycoplasma bovis Manual.pdf',
    'LOP/LOP-QM 001 (V9) Proficiency Testing Manual.pdf',
    'LOP/LOP-CR 001 (V2) CRV Vial Washing Manual.pdf',
    'LOP/LOP-MB 005 (V2) Aerobic Plate Count (via Petrifilm) Manual.pdf',
    'LOP/LOP-SR 002 (V15) Receipt of Casual Samples Manual.pdf',
    'LOP/LOP-TI 004 (V3) TITAN Manual - Approval and Reporting Privileges.pdf',
    'EOP/EOP 014 (V1) CombiFoss Manual.pdf',
    'Recordings/Callie.docx',
    'Recordings/Scott Madcap Part 1.docx',
    'Recordings/Gavin.docx',
  ];

  let totalRetrieval = 0;
  let under20 = 0;
  let under50 = 0;
  let tokenSum = 0;

  for (const relPath of sampleFiles) {
    const absPath = join(base, relPath);
    const ext = relPath.split('.').pop()!;
    const filename = relPath.split('/').pop()!;

    let extracted;
    try {
      const buf = readFileSync(absPath);
      if (ext === 'pdf') {
        extracted = await extractPdf(buf, filename);
      } else {
        extracted = await extractDocx(buf, filename);
      }
    } catch (e: any) {
      console.log(`SKIP ${relPath}: ${e.message}`);
      continue;
    }

    const norm = await normalise(extracted.sections, filename.replace(/\.[^.]+$/, ''), 'rebuild');
    const eligible = norm.sections.filter(s => !s.retrieval_excluded);
    const chunks = chunkProse(eligible, filename.replace(/\.[^.]+$/, ''));
    const retrievalChunks = chunks.filter(c => !c.retrieval_excluded);

    const u20 = retrievalChunks.filter(c => c.token_count < 20).length;
    const u50 = retrievalChunks.filter(c => c.token_count < 50).length;
    const avgT = retrievalChunks.length > 0 ? retrievalChunks.reduce((s, c) => s + c.token_count, 0) / retrievalChunks.length : 0;

    console.log(`${relPath}: sections=${extracted.sections.length} -> norm=${norm.sections.length} (excl=${norm.stats.excluded}) -> chunks=${retrievalChunks.length} avg=${avgT.toFixed(0)} u50=${u50} u20=${u20}${norm.sanity_warning ? ' SANITY-WARN' : ''}`);

    totalRetrieval += retrievalChunks.length;
    for (const c of retrievalChunks) {
      tokenSum += c.token_count;
      if (c.token_count < 20) under20++;
      if (c.token_count < 50) under50++;
    }
  }

  console.log(`\n=== SAMPLE TOTALS (${sampleFiles.length} docs) ===`);
  console.log(`Retrieval chunks: ${totalRetrieval}`);
  console.log(`Under 50 tokens: ${under50} (${(under50/totalRetrieval*100).toFixed(1)}%)`);
  console.log(`Under 20 tokens: ${under20} (${(under20/totalRetrieval*100).toFixed(1)}%)`);
  console.log(`Avg tokens: ${(tokenSum/totalRetrieval).toFixed(1)}`);

  process.exit(0);
}
main();
