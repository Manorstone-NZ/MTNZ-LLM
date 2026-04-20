import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildAnswerStylePolicy,
  inferAnswerStyleFromQuestion,
  resolveAnswerStyle,
} from './answerPolicy';

test('infers concise by default', () => {
  assert.equal(inferAnswerStyleFromQuestion('What is MADCAP?'), 'concise');
});

test('infers detailed when question explicitly asks for depth', () => {
  assert.equal(inferAnswerStyleFromQuestion('Give a detailed step-by-step explanation'), 'detailed');
});

test('explicit requested style overrides inference', () => {
  assert.equal(resolveAnswerStyle('concise', 'Give me a detailed answer'), 'concise');
  assert.equal(resolveAnswerStyle('detailed', 'Keep it short'), 'detailed');
});

test('style policy text includes mode-specific guidance', () => {
  assert.match(buildAnswerStylePolicy('concise'), /Default to concise responses/i);
  assert.match(buildAnswerStylePolicy('detailed'), /Provide a detailed, structured answer/i);
});
