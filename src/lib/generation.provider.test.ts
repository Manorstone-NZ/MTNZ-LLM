import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveProviderMode, type ModelProviderMode } from './generation';

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
