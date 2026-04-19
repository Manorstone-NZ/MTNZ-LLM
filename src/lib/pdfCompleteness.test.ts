import test from 'node:test';
import assert from 'node:assert/strict';
import { auditPdfCompleteness } from './pdfCompleteness';

test('flags missing appendix content when only reference is present', () => {
  const result = auditPdfCompleteness(
    {
      title: 'LOP-RR 001 (V7) Result Release Manual',
      source_path: 'LOP/LOP-RR 001 (V7) Result Release Manual.pdf',
      extraction_method: 'native_pdf',
      text_quality_tier: 'partial',
      text_quality_score: 0.768,
      needs_review: false,
      quarantined: false,
      chunk_count: 12,
    },
    [
      {
        page_number: 10,
        section_title: '7.2 MICROBIOLOGY RESULT RELEASE',
        content:
          'In MADCAP every test has a specific test type number. Microbiology test numbers are listed in Appendix 13.2.1 Microbiology Test Codes.',
      },
      {
        page_number: 11,
        section_title: '7.2.1 COLIFORM AND THERMODURIC RELEASING (020)',
        content: 'Result release workflow content.',
      },
      {
        page_number: 12,
        section_title: '7.2.2 MASTITIS RELEASING (026)',
        content: 'Result release workflow content.',
      },
    ],
  );

  assert.equal(result.risk, 'medium');
  assert.ok(result.missing_referenced_appendices.includes('13.2.1'));
  assert.ok(result.reasons.some((r) => r.includes('Missing appendix content')));
});

test('does not flag appendix as missing when section_title is the appendix heading (no "appendix" prefix in title)', () => {
  // Real-world pattern: chunk section_title is "13.2.1 MICROBIOLOGY TEST CODES" but body
  // text only has one occurrence of "appendix 13.2.1" (the in-text reference).
  const result = auditPdfCompleteness(
    {
      title: 'LOP-RR 001 (V7) Result Release Manual',
      source_path: 'LOP/LOP-RR 001 (V7) Result Release Manual.pdf',
      extraction_method: 'native_pdf',
      text_quality_tier: 'good',
      text_quality_score: 0.9,
      needs_review: false,
      quarantined: false,
      chunk_count: 5,
    },
    [
      {
        page_number: 10,
        section_title: '7.2 MICROBIOLOGY RESULT RELEASE',
        content:
          'Microbiology test numbers are listed in Appendix 13.2.1 Microbiology Test Codes.',
      },
      {
        // The appendix heading chunk (short, may be excluded) — has number-prefixed title
        page_number: 31,
        section_title: '13.2.1 MICROBIOLOGY TEST CODES',
        content: 'Test Type Test Type Number\nBactoScan 2',
      },
      {
        // The actual data chunk that follows
        page_number: 31,
        section_title: 'APC/SPC 3',
        content: 'APC/SPC 3\nColiform 4\nThermoduric 5',
      },
    ],
  );

  assert.equal(result.missing_referenced_appendices.length, 0, 'Should not flag 13.2.1 as missing');
});

test('does not flag appendix as missing when appendix heading/content exists', () => {
  const result = auditPdfCompleteness(
    {
      title: 'Appendix-rich manual',
      source_path: 'LOP/Example.pdf',
      extraction_method: 'native_pdf',
      text_quality_tier: 'partial',
      text_quality_score: 0.8,
      needs_review: false,
      quarantined: false,
      chunk_count: 4,
    },
    [
      {
        page_number: 1,
        section_title: '7.2 MICROBIOLOGY RESULT RELEASE',
        content: 'Refer to Appendix 13.2.1 Microbiology Test Codes.',
      },
      {
        page_number: 2,
        section_title: 'Appendix 13.2.1 Microbiology Test Codes',
        content: '13.2.1 Microbiology Test Codes\n020 Coliform and Thermoduric\n026 Mastitis',
      },
      {
        page_number: 3,
        section_title: '13.2.1 Microbiology Test Codes',
        content: 'Additional code rows',
      },
      {
        page_number: 4,
        section_title: '13.2.2 Other',
        content: 'Other appendix content',
      },
    ],
  );

  assert.equal(result.missing_referenced_appendices.length, 0);
});

test('ignores table-of-contents appendix references when detecting missing appendices', () => {
  const result = auditPdfCompleteness(
    {
      title: 'LOP-MC 001 (V1) MADCAP Procedures Manual',
      source_path: 'LOP/LOP-MC 001 (V1) MADCAP Procedures Manual.pdf',
      extraction_method: 'native_pdf',
      text_quality_tier: 'partial',
      text_quality_score: 0.76,
      needs_review: true,
      quarantined: false,
      chunk_count: 120,
    },
    [
      {
        page_number: 4,
        section_title: 'TABLE OF CONTENTS',
        content:
          '17.2 Legacy Setup .................................. 101\n17.7 Migration Notes .................................. 109',
      },
      {
        page_number: 90,
        section_title: '14.1 ANALYSER CONFIGURATION',
        content: 'See Appendix 17.2 for historical context.',
      },
      {
        page_number: 94,
        section_title: '14.2 ENTRY METHOD CONFIGURATION',
        content: 'Refer to Appendix 17.7 for archive operation notes.',
      },
      {
        page_number: 108,
        section_title: '17.8 AUTOMATED SELECTION FILE LOADING',
        content: 'Operational guidance for selection loading.',
      },
    ],
  );

  assert.equal(result.missing_referenced_appendices.length, 0, 'TOC refs should not cause missing appendix flags');
});
