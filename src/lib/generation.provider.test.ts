import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isAnthropicProviderAvailableFromEnv,
  resolveLmStudioBaseUrlFromEnv,
  resolveProviderMode,
  type ModelProviderMode,
} from './generation';

test('resolveProviderMode returns anthropic when explicitly requested and key is present', () => {
  const out = resolveProviderMode('anthropic', true);
  assert.equal(out, 'anthropic');
});

test('resolveProviderMode falls back to lmstudio when anthropic requested but key missing', () => {
  const out = resolveProviderMode('anthropic', false);
  assert.equal(out, 'lmstudio');
});

test('resolveProviderMode returns lmstudio when explicitly requested', () => {
  const out = resolveProviderMode('lmstudio', true);
  assert.equal(out, 'lmstudio');
});

test('resolveProviderMode with auto prefers anthropic when key exists', () => {
  const out = resolveProviderMode('auto', true);
  assert.equal(out, 'anthropic');
});

test('resolveProviderMode with auto falls back to lmstudio when key missing', () => {
  const out = resolveProviderMode('auto', false);
  assert.equal(out, 'lmstudio');
});

test('ModelProviderMode union accepts expected values', () => {
  const values: ModelProviderMode[] = ['auto', 'anthropic', 'lmstudio'];
  assert.equal(values.length, 3);
});

test('isAnthropicProviderAvailableFromEnv returns true when ANTHROPIC_API_KEY is set', () => {
  const out = isAnthropicProviderAvailableFromEnv({
    ANTHROPIC_API_KEY: 'abc123',
  });
  assert.equal(out, true);
});

test('isAnthropicProviderAvailableFromEnv supports CLAUDE_API_KEY alias', () => {
  const out = isAnthropicProviderAvailableFromEnv({
    CLAUDE_API_KEY: 'abc123',
  });
  assert.equal(out, true);
});

test('isAnthropicProviderAvailableFromEnv returns false when disabled via ANTHROPIC_ENABLED=false', () => {
  const out = isAnthropicProviderAvailableFromEnv({
    ANTHROPIC_API_KEY: 'abc123',
    ANTHROPIC_ENABLED: 'false',
  });
  assert.equal(out, false);
});

test('isAnthropicProviderAvailableFromEnv returns false when disabled via CLAUDE_ENABLED=false', () => {
  const out = isAnthropicProviderAvailableFromEnv({
    CLAUDE_API_KEY: 'abc123',
    CLAUDE_ENABLED: 'false',
  });
  assert.equal(out, false);
});

test('resolveLmStudioBaseUrlFromEnv appends /v1 when missing', () => {
  const out = resolveLmStudioBaseUrlFromEnv({ LMSTUDIO_URL: 'http://localhost:1234' });
  assert.equal(out, 'http://localhost:1234/v1');
});

test('resolveLmStudioBaseUrlFromEnv preserves existing /v1', () => {
  const out = resolveLmStudioBaseUrlFromEnv({ LMSTUDIO_URL: 'http://localhost:1234/v1' });
  assert.equal(out, 'http://localhost:1234/v1');
});
