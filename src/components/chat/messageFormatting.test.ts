import { formatAssistantContent } from './messageFormatting';

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

function testConvertsBreakTagsToNewlines(): void {
  const input = 'Line one<br>Line two<br />Line three<br/>Line four';
  const output = formatAssistantContent(input);
  assert(!output.includes('<br'), 'replaces HTML break tags');
  const breakCount = (output.match(/<line-break \/>/g) ?? []).length;
  assert(breakCount === 3, 'preserves line breaks as placeholders');
}

function testPreservesSourceBadges(): void {
  const input = 'Fact [Source: Doc A]';
  const output = formatAssistantContent(input);
  assert(output.includes('<source-badge label="Doc A" />'), 'converts citations to source badge placeholders');
}

function main(): void {
  console.log('=== message formatting tests ===');
  testConvertsBreakTagsToNewlines();
  testPreservesSourceBadges();
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
