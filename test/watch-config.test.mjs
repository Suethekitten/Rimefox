// watchConfig：外部配置变化后读配置失败（后台忙、读超时）要退避重试，不能把这次改动丢掉。
import test from 'node:test';
import assert from 'node:assert/strict';

const listeners = new Set();
globalThis.chrome = {
  runtime: { id: 'test-extension' },
  storage: { onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) } }
};
const { watchConfig } = await import('../lib/ui-appearance.js');
const fire = () => listeners.forEach((fn) => fn({ config: { newValue: {} } }, 'local'));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a failed read is retried until the change is delivered', async () => {
  let reads = 0;
  const seen = [];
  const stop = watchConfig((cfg) => seen.push(cfg.uiLang), {
    read: async () => { reads += 1; if (reads < 3) throw new Error('timeout'); return { uiLang: 'en', n: reads }; },
    debounceMs: 5, retryDelays: [10, 10, 10]
  });
  fire();
  await wait(120);
  stop();
  assert.equal(reads, 3);
  assert.deepEqual(seen, ['en']);
});

test('retries are bounded and a new change restarts them', async () => {
  let reads = 0;
  const seen = [];
  let fail = true;
  const stop = watchConfig((cfg) => seen.push(cfg.uiLang), {
    read: async () => { reads += 1; if (fail) throw new Error('timeout'); return { uiLang: 'zh', n: 'later' }; },
    debounceMs: 5, retryDelays: [10, 10]
  });
  fire();
  await wait(120);
  assert.equal(reads, 3, 'one read plus two retries, then it stops');
  assert.deepEqual(seen, []);
  fail = false;
  fire();
  await wait(60);
  stop();
  assert.deepEqual(seen, ['zh']);
});

test('no retry once the extension context is gone', async () => {
  let reads = 0;
  const stop = watchConfig(() => {}, {
    read: async () => { reads += 1; chrome.runtime.id = undefined; throw new Error('Extension context invalidated'); },
    debounceMs: 5, retryDelays: [10, 10, 10]
  });
  fire();
  await wait(100);
  stop();
  chrome.runtime.id = 'test-extension';
  assert.equal(reads, 1);
});
