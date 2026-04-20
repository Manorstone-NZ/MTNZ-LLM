import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectSectionsForStructuralPass } from './extraction/pdf';

test('recovers split numbered heading lines', () => {
  const pages = [
    '13.2.1\nMICROBIOLOGY TEST CODES\nUse the following codes for reporting.',
  ];

  const sections = detectSectionsForStructuralPass(pages);

  assert.equal(sections[0]?.type, 'heading');
  assert.equal(sections[0]?.content, '13.2.1 MICROBIOLOGY TEST CODES');
  assert.equal(sections[1]?.type, 'paragraph');
  assert.match(sections[1]?.content ?? '', /Use the following codes/);
});

test('cleans footer contamination from heading candidates', () => {
  const pages = [
    'Page 3 of 12 7.2 RESULT ENTRY CONTROLLED COPY\nRecord values in MADCAP and save.',
  ];

  const sections = detectSectionsForStructuralPass(pages);

  assert.equal(sections[0]?.type, 'heading');
  assert.equal(sections[0]?.content, '7.2 RESULT ENTRY');
});

test('keeps list intro attached to list block', () => {
  const pages = [
    '4.1.2 Manual result entry\nFollow these steps:\n1. Open MADCAP\n2. Enter result code',
  ];

  const sections = detectSectionsForStructuralPass(pages);
  const list = sections.find((section) => section.type === 'list');

  assert.ok(list);
  assert.match(list?.content ?? '', /^Follow these steps:/);
  assert.match(list?.content ?? '', /1\. Open MADCAP/);
});

test('removes OCR header footer contamination but preserves body text', () => {
  const pages = [
    'THIS DOCUMENT IS UNCONTROLLED\nIF THIS LINE IS GREEN CONTROLLED COPY\nInstrument calibration must be recorded daily.\nPage 2 of 5',
  ];

  const sections = detectSectionsForStructuralPass(pages);
  const paragraph = sections.find((section) => section.type === 'paragraph');

  assert.ok(paragraph);
  assert.match(paragraph?.content ?? '', /Instrument calibration must be recorded daily/);
  assert.doesNotMatch(paragraph?.content ?? '', /THIS DOCUMENT IS UNCONTROLLED/i);
  assert.doesNotMatch(paragraph?.content ?? '', /Page 2 of 5/i);
});

test('detects simple delimited reference tables as table blocks', () => {
  const pages = [
    'Code | Description | Limit\nAPC | Aerobic Plate Count | <= 10000\nCC | Coliform Count | <= 10',
  ];

  const sections = detectSectionsForStructuralPass(pages);

  assert.equal(sections[0]?.type, 'table');
  assert.match(sections[0]?.content ?? '', /Code \| Description \| Limit/);
});

test('does not promote random short all-caps fragments to headings', () => {
  const pages = [
    'TEMP\nreading value is 12 and should remain paragraph text.',
  ];

  const sections = detectSectionsForStructuralPass(pages);

  assert.notEqual(sections[0]?.type, 'heading');
});