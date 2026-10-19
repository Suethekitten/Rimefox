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

// chrome.storage.session / local 的替身：存进去的是 JSON 拷贝，和真存储一样不共享引用；
// get / remove 和真存储一样接受单个键或键数组。writes 记每次 set 写了多少字符（看落盘量）
function fakeArea() {
  const data = {};
  const area = {
    data,
    writes: [],
    async get(keys) {
      const out = {};
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
        if (key in data) out[key] = JSON.parse(data[key]);
      });
      return out;
    },
    async set(obj) {
      let chars = 0;
      Object.keys(obj).forEach((k) => {
        data[k] = JSON.stringify(obj[k]);
        chars += data[k].length;
      });
      area.writes.push(chars);
    },
    async remove(keys) {
      (Array.isArray(keys) ? keys : [keys]).forEach((key) => {
        delete data[key];
      });
    }
  };
  return area;
}

// 存储里的缓存条目（按段号、段内顺序拼起来）：[[键, 译文], ...]
function storedEntries(area, tag) {
  const index = area.data['dt.cache.v1.' + tag + '.index'];
  if (!index) return [];
  return JSON.parse(index).flatMap((id) => JSON.parse(area.data['dt.cache.v1.' + tag + '.' + id] || '[]'));
}
const cacheKeys = (area) => Object.keys(area.data).filter((k) => k.indexOf('dt.cache.v1') === 0);

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

await t('自定义提示词指纹不同 → 键不同（改了提示词旧译文失效）', () => {
  const base = makeKey(scope, 'Code');
  assert.notEqual(makeKey({ ...scope, prompt: 'abc123' }, 'Code'), base);
  assert.notEqual(makeKey({ ...scope, prompt: 'abc123' }, 'Code'), makeKey({ ...scope, prompt: 'def456' }, 'Code'));
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

await t('存储里的坏数据被忽略，不影响使用（旧格式的整层键）', async () => {
  const session = fakeArea();
  await session.set({ 'dt.cache.v1': { entries: [['ok', '好'], 'garbage', [1, 2], null] } });
  const c = createCache({ session, local: fakeArea() });
  await c.ready;
  assert.equal(c.get('ok'), '好');
  assert.equal(c.size(), 1);
});

await t('删除一条：内存层和磁盘层都删，落盘后重启也不会再命中，其它条目不受影响', async () => {
  const session = fakeArea();
  const local = fakeArea();
  const a = createCache({ session, local });
  await a.ready;
  a.set(makeKey(scope, 'Bad'), '{"translation": "x"}');
  a.set(makeKey(scope, 'Code'), '代码');
  await a.flush();
  a.remove(makeKey(scope, 'Bad'));
  a.remove(makeKey(scope, 'Missing')); // 不存在的键：什么也不做
  assert.equal(a.get(makeKey(scope, 'Bad')), undefined);
  await a.flush();
  const b = createCache({ session, local });
  await b.ready;
  assert.equal(b.get(makeKey(scope, 'Bad')), undefined, '重启后也不能再命中');
  assert.equal(b.get(makeKey(scope, 'Code')), '代码');
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
  const saved = storedEntries(local, 'l');
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
  assert.ok(storedEntries(session, 's').length, 'session 层没有写入');
});

// ---------------- 分段落盘 ----------------
console.log('\n[分段落盘]');

await t('落盘只写有改动的段：缓存满了以后新增一条，不再把整层几 MB 重写一遍', async () => {
  const session = fakeArea();
  const c = createCache({ session, local: fakeArea() });
  await c.ready;
  for (let i = 0; i < 4000; i += 1) c.set(makeKey(scope, long + i), '长段落译文 ' + i);
  await c.flush();
  const total = Object.values(session.data).reduce((n, v) => n + v.length, 0);
  session.writes.length = 0;
  c.set(makeKey(scope, long + 'new'), '新的一条');
  await c.flush();
  const written = session.writes.reduce((n, v) => n + v, 0);
  assert.ok(total > 1000000, '前提：session 层已经有 1MB 以上');
  assert.ok(written < total / 4, '新增一条写了 ' + written + ' 字符，整层 ' + total);
});

await t('旧格式（整层一个键）读进来后迁移成分段，旧键删掉', async () => {
  const session = fakeArea();
  await session.set({ 'dt.cache.v1': { entries: [[makeKey(scope, 'Code'), '代码']] } });
  const a = createCache({ session, local: fakeArea() });
  await a.ready;
  assert.equal(a.get(makeKey(scope, 'Code')), '代码');
  await a.flush();
  assert.equal(session.data['dt.cache.v1'], undefined, '旧格式的键应删掉');
  const b = createCache({ session, local: fakeArea() });
  await b.ready;
  assert.equal(b.get(makeKey(scope, 'Code')), '代码', '迁移后重启照样命中');
});

await t('恢复后保持写入顺序：淘汰时先淘汰更早写入的', async () => {
  const local = fakeArea();
  const a = createCache({ session: fakeArea(), local });
  await a.ready;
  for (let i = 0; i < 3000; i += 1) a.set(makeKey(scope, 'Label ' + i), '标签 ' + i);
  await a.flush();
  const saved = storedEntries(local, 'l');
  const b = createCache({ session: fakeArea(), local });
  await b.ready;
  assert.equal(b.stats().disk.entries, saved.length);
  assert.equal(b.get(makeKey(scope, 'Label 2999')), '标签 2999');
  for (let i = 0; i < 200; i += 1) b.set(makeKey(scope, 'More ' + i), '更多 ' + i);
  assert.equal(b.get(makeKey(scope, 'More 199')), '更多 199');
  assert.equal(b.get(makeKey(scope, saved[0][0].slice(saved[0][0].indexOf('\n') + 1))), undefined, '最早写入的应先被淘汰');
});

// ---------------- 清空 ----------------
console.log('\n[清空]');

await t('清空后两层存储里的缓存键（分段、清单、旧格式）都消失', async () => {
  const session = fakeArea();
  const local = fakeArea();
  const c = createCache({ session, local });
  await c.ready;
  c.set(makeKey(scope, 'Code'), '代码');
  await c.flush();
  assert.ok(cacheKeys(local).length);
  await c.clear();
  assert.deepEqual(cacheKeys(local), []);
  assert.deepEqual(cacheKeys(session), []);
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
