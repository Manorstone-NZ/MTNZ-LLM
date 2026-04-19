import test from 'node:test';
import assert from 'node:assert/strict';

import { summariseRuleEvidence } from './evidenceSummary';

test('detects broad rule coverage across multiple documents', () => {
  const chunks = [
    {
      doc_title: 'Doc A',
      folder: 'LOP',
      section_title: 'Result Release',
      content_preview: 'Results must be entered and confirmed before release.',
    },
    {
      doc_title: 'Doc B',
      folder: 'LOP',
      section_title: 'Manual Entry',
      content_preview: 'A numeric result is required.',
    },
    {
      doc_title: 'Doc C',
      folder: 'EOP',
      section_title: 'Validation',
      content_preview: 'If the value is outside range, notify technical staff.',
    },
    {
      doc_title: 'Doc D',
      folder: 'LOP',
      section_title: 'Adjustment',
      content_preview: 'Existing results must be adjusted using the defined process.',
    },
    {
      doc_title: 'Doc A',
      folder: 'LOP',
      section_title: 'Sample Rules',
      content_preview: 'When processing colostrum, use the designated product.',
    },
    {
      doc_title: 'Doc B',
      folder: 'LOP',
      section_title: 'Criteria',
      content_preview: 'Acceptance criteria apply before release.',
    },
    {
      doc_title: 'Doc C',
      folder: 'EOP',
      section_title: 'Processing',
      content_preview: 'Only approved codes may be entered.',
    },
    {
      doc_title: 'Doc D',
      folder: 'LOP',
      section_title: 'Exception Handling',
      content_preview: 'If missing fields exist, reject entry.',
    },
  ] as any;

  const out = summariseRuleEvidence(chunks);
  assert.equal(out.hasBroadRuleCoverage, true);
  assert.equal(out.hasStrongSynthesisCoverage, true);
  assert.equal(out.hasAuthoritativeSource, true);
});
