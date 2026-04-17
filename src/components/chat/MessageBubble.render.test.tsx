import { renderToStaticMarkup } from 'react-dom/server';
import MessageBubble from './MessageBubble';

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

function testBreakTagsRenderAsHtmlBreaks(): void {
  const html = renderToStaticMarkup(
    <MessageBubble role="assistant" content={'Line one<br>Line two'} sources={[]} />
  );
  assert(html.includes('<br/>') || html.includes('<br />'), 'renders line break tags as HTML breaks');
}

function main(): void {
  console.log('=== message bubble render tests ===');
  testBreakTagsRenderAsHtmlBreaks();
  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    process.exit(1);
  }
}

main();
