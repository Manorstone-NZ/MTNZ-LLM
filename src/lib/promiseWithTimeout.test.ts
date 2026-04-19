import test from 'node:test';
import assert from 'node:assert/strict';

import { promiseWithTimeout } from './promiseWithTimeout';

test('promiseWithTimeout returns the original result before timeout', async () => {
  const result = await promiseWithTimeout(Promise.resolve('ok'), 50, 'timed out');
  assert.equal(result, 'ok');
});

test('promiseWithTimeout rejects when the timeout elapses first', async () => {
  const never = new Promise<string>(() => {});

  await assert.rejects(
    promiseWithTimeout(never, 10, 'timed out'),
    /timed out/,
  );
});