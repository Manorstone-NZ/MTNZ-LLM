/**
 * Test: image extraction via OCR path
 *
 * Verifies the image extractor is robust even when OCR tools are unavailable
 * or input bytes are invalid.
 *
 * Run with: npx tsx src/lib/extraction/__tests__/image-extraction.test.ts
 */

import { extractImage } from '../image';

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

async function testNoCrashOnEmptyImageBuffer(): Promise<void> {
  console.log('\nTest 1: extractImage handles empty image buffer');

  const result = await extractImage(Buffer.alloc(0), 'empty.jpg');

  assert(result !== null && result !== undefined, 'Returns a result object');
  assert(typeof result.text === 'string', 'Returns text field');
  assert(Array.isArray(result.sections), 'Returns sections array');
  assert(
    result.metadata.extraction_method === 'ocr_image',
    `extraction_method is ocr_image (got ${String(result.metadata.extraction_method)})`,
  );
  assert(
    typeof result.metadata.error === 'string',
    'Returns explicit OCR failure reason for empty image buffer',
  );
}

async function main(): Promise<void> {
  console.log('=== Image Extraction Tests ===');

  await testNoCrashOnEmptyImageBuffer();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
