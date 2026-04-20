import test from 'node:test';
import assert from 'node:assert/strict';

import { buildSynthesisEvidencePolicyHint } from './prompts';
import type { EvidenceSummary } from './evidenceSummary';

function makeSummary(overrides: Partial<EvidenceSummary> = {}): EvidenceSummary {
  return {
    documentCount: overrides.documentCount ?? 2,
    chunkCount: overrides.chunkCount ?? 6,
    sectionTitleCount: overrides.sectionTitleCount ?? 3,
    ruleSignalCount: overrides.ruleSignalCount ?? 0,
    listSignalCount: overrides.listSignalCount ?? 4,
    authoritativeChunkCount: overrides.authoritativeChunkCount ?? 2,
    structuredSourceCount: overrides.structuredSourceCount ?? 1,
    ruleCategoryCount: overrides.ruleCategoryCount ?? 1,
    hasStrongSynthesisCoverage: overrides.hasStrongSynthesisCoverage ?? true,
    hasAuthoritativeSource: overrides.hasAuthoritativeSource ?? true,
    hasBroadRuleCoverage: overrides.hasBroadRuleCoverage ?? false,
  };
}

test('buildSynthesisEvidencePolicyHint forbids source-unavailable claims when authoritative evidence exists', () => {
  const hint = buildSynthesisEvidencePolicyHint('canonical_lookup', makeSummary());
  assert.match(hint ?? '', /Do NOT claim that you lack access to the required list, mapping, register, or reference source/i);
});

test('buildSynthesisEvidencePolicyHint does not add authoritative-access guard without authoritative evidence', () => {
  const hint = buildSynthesisEvidencePolicyHint('synthesis_list', makeSummary({ hasAuthoritativeSource: false, structuredSourceCount: 0, authoritativeChunkCount: 0 }));
  assert.doesNotMatch(hint ?? '', /Do NOT claim that you lack access/i);
});