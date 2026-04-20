import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveQualityReasons,
  summarizeQualityReasons,
  type QualityExplainabilityDoc,
} from './qualityReasons';

function makeDoc(overrides: Partial<QualityExplainabilityDoc> = {}): QualityExplainabilityDoc {
  return {
    id: 'doc-1',
    is_active: true,
    source_type: 'pdf',
    extraction_method: null,
    text_quality_tier: 'partial',
    text_quality_score: 0.62,
    needs_review: false,
    ocr_used: false,
    chunk_count: 20,
    excluded_chunk_count: 0,
    heading_chunk_count: 4,
    table_chunk_count: 0,
    appendix_chunk_count: 0,
    list_chunk_count: 0,
    ...overrides,
  };
}

test('deriveQualityReasons adds strong signal reasons for partial docs', () => {
  const reasons = deriveQualityReasons(
    makeDoc({
      ocr_used: true,
      extraction_method: 'ocr',
      excluded_chunk_count: 8,
      chunk_count: 20,
      heading_chunk_count: 0,
      needs_review: true,
    }),
  );

  assert.ok(reasons.includes('OCR used'));
  assert.ok(reasons.includes('Fallback extraction'));
  assert.ok(reasons.includes('High excluded chunk ratio'));
  assert.ok(reasons.includes('Weak headings'));
  assert.ok(reasons.includes('Needs review'));
});

test('deriveQualityReasons gives unclassified docs at least one reason', () => {
  const reasons = deriveQualityReasons(
    makeDoc({
      text_quality_tier: null,
      ocr_used: false,
      extraction_method: null,
      chunk_count: 40,
      excluded_chunk_count: 1,
      heading_chunk_count: 8,
      table_chunk_count: 0,
      appendix_chunk_count: 0,
      list_chunk_count: 0,
      needs_review: false,
    }),
  );

  assert.ok(reasons.includes('Unclassified inputs'));
  assert.ok(reasons.length >= 1);
});

test('summarizeQualityReasons reconciles partial totals', () => {
  const docs: QualityExplainabilityDoc[] = [
    makeDoc({ id: 'p1', text_quality_tier: 'partial', ocr_used: true, extraction_method: 'ocr' }),
    makeDoc({ id: 'p2', text_quality_tier: 'partial', needs_review: true, heading_chunk_count: 0 }),
    makeDoc({ id: 'u1', text_quality_tier: null, heading_chunk_count: 0, chunk_count: 3 }),
    makeDoc({ id: 'g1', text_quality_tier: 'good', heading_chunk_count: 6 }),
    makeDoc({ id: 'h1', is_active: false, text_quality_tier: 'partial', ocr_used: true }),
  ];

  const summary = summarizeQualityReasons(docs);

  assert.equal(summary.partial_docs, 2);
  assert.equal(summary.unclassified_docs, 1);
  assert.equal(summary.partial_docs_with_reasons, 2);
  assert.equal(summary.unclassified_docs_with_reasons, 1);
  assert.equal(summary.partial_docs_with_reasons === summary.partial_docs, true);
  assert.equal(summary.unclassified_docs_with_reasons === summary.unclassified_docs, true);
  assert.ok(summary.partial_reason_counts['OCR used'] >= 1);
});
