// 翻译缓存单测：三层读写、落地恢复、字节预算、清空（用假存储，不依赖浏览器）。
// 运行：node test/cache.test.mjs
import assert from 'node:assert/strict';

import { createCache, makeKey, LIMITS } from '../lib/cache.js';

let pass = 0;
let fail = 0;

async function t(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('  ✓ ' + name);
  } catch (err) {
    fail += 1;
    console.log('  ✗ ' + name + '\n      ' + (err && err.message));
  }
}

// chrome.storage.session / local 的替身：存进去的是 JSON 拷贝，和真存储一样不共享引用
function fakeArea() {
  const data = {};
  return {
    data,
    async get(key) {
      return key in data ? { [key]: JSON.parse(data[key]) } : {};
    },
    async set(obj) {
      Object.keys(obj).forEach((k) => {
        data[k] = JSON.stringify(obj[k]);
      });
    },
    async remove(key) {
      delete data[key];
    }
  };
}

const scope = { target: 'zh-CN', model: 'deepseek:deepseek-chat', host: 'github.com' };
const long = 'This is a long paragraph. '.repeat(10);

// ---------------- 键 ----------------
console.log('\n[缓存键]');

await t('同样的输入得到同样的键', () => {
  assert.equal(makeKey(scope, 'Code'), makeKey({ ...scope }, 'Code'));
});

await t('目标语言 / 风格 / 模型 / 域名不同 → 键不同', () => {
  const base = makeKey(scope, 'Code');
  assert.notEqual(makeKey({ ...scope, target: 'ja' }, 'Code'), base);
  assert.notEqual(makeKey({ ...scope, style: 'classical' }, 'Code'), base);
  assert.notEqual(makeKey({ ...scope, model: 'openai:gpt-4o-mini' }, 'Code'), base);
  assert.notEqual(makeKey({ ...scope, host: 'evil.example' }, 'Code'), base);
});

await t('术语表指纹不同 → 键不同（改了术语旧译文失效）', () => {
  const base = makeKey(scope, 'Code');
  assert.notEqual(makeKey({ ...scope, glossary: 'abc123' }, 'Code'), base);
  assert.notEqual(makeKey({ ...scope, glossary: 'abc123' }, 'Code'), makeKey({ ...scope, glossary: 'def456' }, 'Code'));
});

// ---------------- 读写与恢复 ----------------
console.log('\n[读写与恢复]');

await t('写入后命中，未写入的返回 undefined，命中率计数正确', async () => {
  const c = createCache(null);
  await c.ready;
  c.set(makeKey(scope, 'Code'), '代码');
  assert.equal(c.get(makeKey(scope, 'Code')), '代码');
  assert.equal(c.get(makeKey(scope, 'Issues')), undefined);
  const s = c.stats();
  assert.equal(s.hits, 1);
  assert.equal(s.misses, 1);
});

await t('service worker 被回收后：从 session 层恢复，长段落也在', async () => {
  const session = fakeArea();
  const local = fakeArea();
  const a = createCache({ session, local });
  await a.ready;
  a.set(makeKey(scope, long), '长段落译文');
  a.set(makeKey(scope, 'Code'), '代码');
  await a.flush();
  const b = createCache({ session, local }); // 新的 service worker
  await b.ready;
  assert.equal(b.get(makeKey(scope, long)), '长段落译文');
  assert.equal(b.get(makeKey(scope, 'Code')), '代码');
});

await t('重启浏览器后（session 清空）：短文本从磁盘层命中，长段落要重翻', async () => {
  const local = fakeArea();
  const a = createCache({ session: fakeArea(), local });
  await a.ready;
  a.set(makeKey(scope, long), '长段落译文');
  a.set(makeKey(scope, 'Code'), '代码');
  await a.flush();
  const b = createCache({ session: fakeArea(), local });
  await b.ready;
  assert.equal(b.get(makeKey(scope, 'Code')), '代码');
  assert.equal(b.get(makeKey(scope, long)), undefined);
});

await t('存储里的坏数据被忽略，不影响使用', async () => {
  const session = fakeArea();
  await session.set({ 'dt.cache.v1': { entries: [['ok', '好'], 'garbage', [1, 2], null] } });
  const c = createCache({ session, local: fakeArea() });
  await c.ready;
  assert.equal(c.get('ok'), '好');
  assert.equal(c.size(), 1);
});

// ---------------- 上限 ----------------
console.log('\n[上限]');

await t('内存层按条数 LRU 淘汰最旧的', async () => {
  const c = createCache(null);
  await c.ready;
  // 原文 + 译文超过 160 字符：只进内存层，淘汰后不会再从磁盘层读到
  const value = 'x'.repeat(LIMITS.diskEntryChars);
  for (let i = 0; i <= LIMITS.memoryEntries; i += 1) c.set('k' + i, value);
  assert.equal(c.size(), LIMITS.memoryEntries);
  assert.equal(c.get('k0'), undefined);
  assert.equal(c.get('k' + LIMITS.memoryEntries), value);
});

await t('磁盘层不超过字节预算，淘汰最旧、保留最新', async () => {
  const local = fakeArea();
  const c = createCache({ session: fakeArea(), local });
  await c.ready;
  const n = 6000; // 每条约 150 字节估算，总量远超 512KB
  for (let i = 0; i < n; i += 1) c.set(makeKey(scope, 'Button label ' + i), '按钮 ' + i);
  const disk = c.stats().disk;
  assert.ok(disk.bytes <= LIMITS.diskBytes, '磁盘层估算 ' + disk.bytes + ' 超过上限');
  assert.ok(disk.entries < n, '没有发生淘汰');
  await c.flush();
  const saved = JSON.parse(local.data['dt.cache.v1']).entries;
  assert.equal(saved[saved.length - 1][1], '按钮 ' + (n - 1));
  assert.ok(!saved.some((pair) => pair[1] === '按钮 0'), '最旧的一条没被淘汰');
});

await t('磁盘里的条目被读到后提升进内存层', async () => {
  const local = fakeArea();
  const a = createCache({ session: fakeArea(), local });
  await a.ready;
  a.set(makeKey(scope, 'Code'), '代码');
  await a.flush();
  const session = fakeArea();
  const b = createCache({ session, local });
  await b.ready;
  b.get(makeKey(scope, 'Code'));
  await b.flush();
  assert.ok(session.data['dt.cache.v1'], 'session 层没有写入');
});

// ---------------- 清空 ----------------
console.log('\n[清空]');

await t('清空后两层存储里的 dt.cache.v1 都消失', async () => {
  const session = fakeArea();
  const local = fakeArea();
  const c = createCache({ session, local });
  await c.ready;
  c.set(makeKey(scope, 'Code'), '代码');
  await c.flush();
  assert.ok(local.data['dt.cache.v1']);
  await c.clear();
  assert.equal(local.data['dt.cache.v1'], undefined);
  assert.equal(session.data['dt.cache.v1'], undefined);
  assert.equal(c.get(makeKey(scope, 'Code')), undefined);
  assert.equal(c.stats().disk.entries, 0);
});

await t('清空时还在路上的旧数据不会被加载回来', async () => {
  const session = fakeArea();
  await session.set({ 'dt.cache.v1': { entries: [['old', '旧']] } });
  const c = createCache({ session, local: fakeArea() });
  await c.clear(); // load 还没完成就清空
  await c.ready;
  assert.equal(c.get('old'), undefined);
});

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
if (fail) process.exit(1);
