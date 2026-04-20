import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RoutingDecisionError,
  parseAnswerMode,
  resolveConfiguredAnswerModeFromEnv,
  resolveRoutingDecision,
  type AnswerMode,
} from './answerRouting';

test('parseAnswerMode accepts supported values', () => {
  const values: Array<AnswerMode | undefined> = [
    parseAnswerMode('lmstudio_only'),
    parseAnswerMode('anthropic_only'),
    parseAnswerMode('two_tier_auto'),
    parseAnswerMode('invalid'),
  ];

  assert.deepEqual(values, ['lmstudio_only', 'anthropic_only', 'two_tier_auto', undefined]);
});

test('resolveConfiguredAnswerModeFromEnv defaults to two_tier_auto', () => {
  const out = resolveConfiguredAnswerModeFromEnv({});
  assert.equal(out, 'two_tier_auto');
});

test('lmstudio_only routes to selected local model', () => {
  const out = resolveRoutingDecision({
    configuredAnswerMode: 'lmstudio_only',
    requestLmStudioModel: 'qwen3:8b',
    modelTier: 'default',
    question: 'What is section 2.1?',
    bestScore: 0.62,
    lowConfidenceThreshold: 0.3,
    intent: 'standard',
    retrievalMode: 'standard',
    chunks: [{ score: 0.62, document_id: 'doc-a' }],
    anthropicAvailable: true,
    availableLmStudioModelIds: ['qwen3:8b', 'gpt-oss-20b'],
    defaultLmStudioModel: 'gpt-oss-20b',
    qualityLmStudioModel: 'gpt-oss-20b',
    defaultAnthropicModel: 'claude-sonnet-4-5',
    qualityAnthropicModel: 'claude-opus-4-5',
  });

  assert.equal(out.answer_mode_used, 'lmstudio_only');
  assert.equal(out.provider_used, 'lmstudio');
  assert.equal(out.model_used, 'qwen3:8b');
  assert.equal(out.quality_mode_triggered, false);
  assert.equal(out.request_override_applied, false);
});

test('anthropic_only throws when Claude unavailable', () => {
  assert.throws(
    () =>
      resolveRoutingDecision({
        configuredAnswerMode: 'anthropic_only',
        modelTier: 'default',
        question: 'Explain this',
        bestScore: 0.71,
        lowConfidenceThreshold: 0.3,
        intent: 'standard',
        retrievalMode: 'standard',
        chunks: [{ score: 0.71, document_id: 'doc-a' }],
        anthropicAvailable: false,
        availableLmStudioModelIds: ['gpt-oss-20b'],
        defaultLmStudioModel: 'gpt-oss-20b',
        qualityLmStudioModel: 'gpt-oss-20b',
        defaultAnthropicModel: 'claude-sonnet-4-5',
        qualityAnthropicModel: 'claude-opus-4-5',
      }),
    (err) => {
      assert.ok(err instanceof RoutingDecisionError);
      assert.equal((err as RoutingDecisionError).code, 'ANTHROPIC_UNAVAILABLE');
      return true;
    },
  );
});

test('two_tier_auto keeps simple query on local model', () => {
  const out = resolveRoutingDecision({
    configuredAnswerMode: 'two_tier_auto',
    modelTier: 'default',
    question: 'What does appendix 2 contain?',
    bestScore: 0.74,
    lowConfidenceThreshold: 0.3,
    intent: 'structural',
    retrievalMode: 'standard',
    chunks: [
      { score: 0.74, document_id: 'doc-a' },
      { score: 0.52, document_id: 'doc-a' },
    ],
    anthropicAvailable: true,
    availableLmStudioModelIds: ['gpt-oss-20b'],
    defaultLmStudioModel: 'gpt-oss-20b',
    qualityLmStudioModel: 'qwen3:14b',
    defaultAnthropicModel: 'claude-sonnet-4-5',
    qualityAnthropicModel: 'claude-opus-4-5',
  });

  assert.equal(out.provider_used, 'lmstudio');
  assert.equal(out.model_used, 'gpt-oss-20b');
  assert.equal(out.quality_mode_triggered, false);
  assert.equal(out.quality_mode_reason, 'none');
});

test('two_tier_auto escalates hard synthesis query to Claude', () => {
  const out = resolveRoutingDecision({
    configuredAnswerMode: 'two_tier_auto',
    modelTier: 'default',
    question: 'Compare implications across documents and explain why they differ',
    bestScore: 0.26,
    lowConfidenceThreshold: 0.3,
    intent: 'synthesis_rules',
    retrievalMode: 'synthesis',
    chunks: [
      { score: 0.26, document_id: 'doc-a' },
      { score: 0.24, document_id: 'doc-b' },
      { score: 0.23, document_id: 'doc-c' },
    ],
    anthropicAvailable: true,
    availableLmStudioModelIds: ['gpt-oss-20b'],
    defaultLmStudioModel: 'gpt-oss-20b',
    qualityLmStudioModel: 'qwen3:14b',
    defaultAnthropicModel: 'claude-sonnet-4-5',
    qualityAnthropicModel: 'claude-opus-4-5',
  });

  assert.equal(out.answer_mode_used, 'two_tier_auto');
  assert.equal(out.provider_used, 'anthropic');
  assert.equal(out.model_used, 'claude-sonnet-4-5');
  assert.equal(out.quality_mode_triggered, true);
  assert.match(out.quality_mode_reason, /low_grounded_score/);
  assert.match(out.quality_mode_reason, /synthesis_or_canonical_query/);
});

test('two_tier_auto falls back to local when Claude unavailable and logs reason', () => {
  const out = resolveRoutingDecision({
    configuredAnswerMode: 'two_tier_auto',
    modelTier: 'quality',
    question: 'Explain implications across the full corpus',
    bestScore: 0.22,
    lowConfidenceThreshold: 0.3,
    intent: 'synthesis_list',
    retrievalMode: 'synthesis',
    chunks: [
      { score: 0.22, document_id: 'doc-a' },
      { score: 0.2, document_id: 'doc-b' },
    ],
    anthropicAvailable: false,
    availableLmStudioModelIds: ['gpt-oss-20b', 'qwen3:14b'],
    defaultLmStudioModel: 'gpt-oss-20b',
    qualityLmStudioModel: 'qwen3:14b',
    defaultAnthropicModel: 'claude-sonnet-4-5',
    qualityAnthropicModel: 'claude-opus-4-5',
  });

  assert.equal(out.provider_used, 'lmstudio');
  assert.equal(out.model_used, 'qwen3:14b');
  assert.equal(out.quality_mode_triggered, true);
  assert.match(out.quality_mode_reason, /anthropic_unavailable_fallback_local/);
});

test('request answer mode override takes precedence', () => {
  const out = resolveRoutingDecision({
    configuredAnswerMode: 'lmstudio_only',
    requestAnswerMode: 'anthropic_only',
    modelTier: 'default',
    question: 'What is this?',
    bestScore: 0.6,
    lowConfidenceThreshold: 0.3,
    intent: 'standard',
    retrievalMode: 'standard',
    chunks: [{ score: 0.6, document_id: 'doc-a' }],
    anthropicAvailable: true,
    availableLmStudioModelIds: ['gpt-oss-20b'],
    defaultLmStudioModel: 'gpt-oss-20b',
    qualityLmStudioModel: 'qwen3:14b',
    defaultAnthropicModel: 'claude-sonnet-4-5',
    qualityAnthropicModel: 'claude-opus-4-5',
  });

  assert.equal(out.answer_mode_used, 'anthropic_only');
  assert.equal(out.provider_used, 'anthropic');
  assert.equal(out.request_override_applied, true);
});

test('selected local model must be available', () => {
  assert.throws(
    () =>
      resolveRoutingDecision({
        configuredAnswerMode: 'lmstudio_only',
        requestLmStudioModel: 'non-existent-model',
        modelTier: 'default',
        question: 'what is this',
        bestScore: 0.7,
        lowConfidenceThreshold: 0.3,
        intent: 'standard',
        retrievalMode: 'standard',
        chunks: [{ score: 0.7, document_id: 'doc-a' }],
        anthropicAvailable: false,
        availableLmStudioModelIds: ['gpt-oss-20b'],
        defaultLmStudioModel: 'gpt-oss-20b',
        qualityLmStudioModel: 'qwen3:14b',
        defaultAnthropicModel: 'claude-sonnet-4-5',
        qualityAnthropicModel: 'claude-opus-4-5',
      }),
    (err) => {
      assert.ok(err instanceof RoutingDecisionError);
      assert.equal((err as RoutingDecisionError).code, 'LMSTUDIO_MODEL_UNAVAILABLE');
      return true;
    },
  );
});
