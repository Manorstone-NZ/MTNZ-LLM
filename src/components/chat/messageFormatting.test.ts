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

function testRemovesTrailingReferencesSection(): void {
  const input = [
    'Operational summary for sorter workflow.',
    '',
    'References:',
    '- [Source: LOP-CR 003, 3]',
    '- [Source: EOP 022, 1]',
  ].join('\n');

  const output = formatAssistantContent(input);
  assert(!output.includes('References:'), 'removes trailing References heading');
  assert(!output.includes('LOP-CR 003'), 'removes trailing references list entries');
  assert(output.includes('Operational summary for sorter workflow.'), 'keeps main answer text');
}

function testRemovesEmptyReferencesSection(): void {
  const input = [
    'Main answer text here.',
    '',
    'References:',
    '- ',
    '- ',
    '- ',
  ].join('\n');

  const output = formatAssistantContent(input);
  assert(!output.includes('References:'), 'removes References heading even when bullets are empty');
  assert(output.includes('Main answer text here.'), 'keeps main answer text');
}

function testRemovesMarkdownHeadingReferencesSection(): void {
  const input = [
    'Main answer text here.',
    '',
    '## References',
    '- ',
    '- ',
    '- ',
    '- ',
    '- ',
    '- ',
    '- ',
    '- ',
    '- ',
  ].join('\n');

  const output = formatAssistantContent(input);
  assert(!output.includes('## References'), 'removes ## References heading');
  assert(!output.includes('References'), 'no References text remains');
  assert(output.includes('Main answer text here.'), 'keeps main answer text');
}

function testRemovesInteractionContextComment(): void {
  const input = 'Answer text.\n\n<!-- INTERACTION_CONTEXT:{"systemA":"Analyser","systemB":"MADCAP","lastIntent":"interaction_explanation","retrievedDocIds":["doc-1"],"hintTerms":["import"]} -->';
  const output = formatAssistantContent(input);
  assert(!output.includes('INTERACTION_CONTEXT'), 'removes interaction context comment');
  assert(!output.includes('<!--'), 'removes HTML comment marker');
  assert(output.includes('Answer text.'), 'keeps main answer text');
}

function testRemovesMultipleReferencesSections(): void {
  const input = [
    'Supporting Documentation',
    '- LOP-BS 002',
    '',
    'References:',
    '- ',
    '- ',
    '',
    'Additional context line.',
    '',
    'References:',
    '- [Source: LOP-BS 002, 1]',
    '- [Source: LOP-BM 009, 2]',
  ].join('\n');

  const output = formatAssistantContent(input);
  assert(!output.includes('References:'), 'removes all References headings from body text');
  assert(!output.match(/^\s*[-*+]\s*$/m), 'removes blank reference bullet lines');
  assert(output.includes('Supporting Documentation'), 'keeps earlier answer sections');
  assert(output.includes('Additional context line.'), 'keeps non-reference body lines');
}

function main(): void {
  console.log('=== message formatting tests ===');
  testConvertsBreakTagsToNewlines();
  testPreservesSourceBadges();
  testRemovesTrailingReferencesSection();
  testRemovesEmptyReferencesSection();
  testRemovesMarkdownHeadingReferencesSection();
  testRemovesInteractionContextComment();
  testRemovesMultipleReferencesSections();
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
