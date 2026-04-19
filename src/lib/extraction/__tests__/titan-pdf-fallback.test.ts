import { readFileSync, existsSync } from 'fs';
import { extractPdf } from '../pdf';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label}`);
    failed++;
  }
}

async function testTitanManualExtractsViaFallback(): Promise<void> {
  console.log('\nTest 1: TITAN scanned PDF extracts text via fallback');

  const filePath = '/Users/damian/Projects/Claude Cowork/IDD/Project Data/Transcripts/Supporting/TITAN Admin Reference Manual V7 Chapter 1 - 5.pdf';
  if (!existsSync(filePath)) {
    console.log('  SKIP: TITAN test file not present in this environment');
    return;
  }

  const result = await extractPdf(readFileSync(filePath), 'TITAN Admin Reference Manual V7 Chapter 1 - 5.pdf');

  assert(result.sections.length > 0, `Expected extracted sections, got ${result.sections.length}`);
  assert(result.text.trim().length > 100, `Expected extracted text > 100 chars, got ${result.text.trim().length}`);
  assert(result.metadata?.error === undefined, `Expected no extraction error, got ${String(result.metadata?.error)}`);
}

async function main(): Promise<void> {
  console.log('=== TITAN PDF fallback tests ===');
  await testTitanManualExtractsViaFallback();
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
