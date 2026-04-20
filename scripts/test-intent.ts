import { classifyQueryIntent } from '@/lib/queryIntent';

const queries = [
  'List all MADCAP test types used across active databases.',
  'Define MADCAP based on the corpus evidence.',
  'How does MADCAP interact with the sorter?',
];

for (const q of queries) {
  const result = classifyQueryIntent(q);
  console.log(`Q: ${q}`);
  console.log(`  Intent: ${result.intent}`);
  console.log(`  Signals: ${result.signals.join(', ') || '(none)'}`);
  console.log();
}
