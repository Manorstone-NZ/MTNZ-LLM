import assert from 'node:assert/strict';
import test from 'node:test';
import { findHelpGuideByDocPath, listHelpGuides, resolveHelpGuideById } from './helpGuides';

test('listHelpGuides returns non-empty guide catalog', () => {
  const guides = listHelpGuides();
  assert.ok(guides.length > 0);
  assert.equal(guides[0].id, 'overview');
});

test('resolveHelpGuideById falls back to overview when missing', () => {
  const selected = resolveHelpGuideById('does-not-exist');
  assert.equal(selected.id, 'overview');
});

test('findHelpGuideByDocPath maps docs to help guides', () => {
  const mapped = findHelpGuideByDocPath('docs/guides/adding-documents.md');
  assert.ok(mapped);
  assert.equal(mapped?.id, 'adding-documents');
});
