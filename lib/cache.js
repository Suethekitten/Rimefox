// 翻译缓存（三层）
// L1 内存 Map           —— 热数据，查询零开销
// L2 chrome.storage.session —— L1 的落地副本：service worker 空闲约 30 秒就被回收，
//                          以前缓存跟着全丢，刷新页面 / 关开一次都要重翻。session 区不写磁盘，关浏览器即清
// L3 chrome.storage.local   —— 重启浏览器后还在；只存短文本（按钮、标题、导航），按字节预算 LRU
//
// 键 = 版本 | 目标语言 | 风格 | 服务商:模型 | 域名 \n 原文
// - 版本：提示词 / 解析规则改了就 +1，老缓存整体作废
// - 服务商:模型：换模型后不再命中旧模型的译文
// - 域名：某个页面诱导出的坏译文（提示词注入）只污染它自己的站点，不会落盘后在所有网站生效
//
// 存储读写通过 createCache({ session, local }) 注入，单测用假存储（test/cache.test.mjs）。

const SCHEMA = 'v1';
const STORE_KEY = 'dt.cache.v1';

export const LIMITS = {
  memoryEntries: 8000,
  memoryBytes: 4 * 1024 * 1024, // session 区配额 10MB，留足余量
  diskBytes: 512 * 1024,
  diskEntryChars: 160, // 原文 + 译文 ≤ 160 字符才进磁盘层
  flushMs: 2500
};

// scope: { target, style, model, host, glossary, prompt }
export function makeKey(scope, text) {
  const s = scope || {};
  // glossary / prompt 是术语表与自定义提示词的指纹：改了之后旧译文必须失效。
  // prompt 为空时不加这一段，避免升级后把所有旧缓存键都换掉、全站重翻。
  const parts = [SCHEMA, s.target || '', s.style || 'plain', s.model || '', s.host || '', s.glossary || 'none'];
  if (s.prompt) parts.push(s.prompt);
  return parts.join('|') + '\n' + text;
}

function textOf(key) {
  const i = key.indexOf('\n');
  return i >= 0 ? key.slice(i + 1) : key;
}

// 估算落盘字节：storage 按 JSON 的 UTF-8 计，中日韩字符 3 字节，再加数组括号引号的开销
function cost(key, value) {
  return (key.length + value.length) * 3 + 16;
}

// 一个按插入顺序 LRU、带条数和字节上限的 Map
function makeLayer(maxEntries, maxBytes) {
  const map = new Map();
  let bytes = 0;
  return {
    map,
    get bytes() {
      return bytes;
    },
    has: (key) => map.has(key),
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (map.has(key)) bytes -= cost(key, map.get(key));
      map.delete(key);
      map.set(key, value);
      bytes += cost(key, value);
      while (map.size > 1 && (map.size > maxEntries || bytes > maxBytes)) {
        const oldest = map.keys().next().value;
        bytes -= cost(oldest, map.get(oldest));
        map.delete(oldest);
      }
    },
    clear() {
      map.clear();
      bytes = 0;
    },
    // 从存储恢复：只收 [字符串, 字符串] 对，顺序即 LRU 顺序（旧 → 新）
    restore(entries) {
      if (!Array.isArray(entries)) return;
      entries.forEach((pair) => {
        if (Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string') {
          this.set(pair[0], pair[1]);
        }
      });
    },
    dump: () => Array.from(map.entries())
  };
}

async function read(area) {
  if (!area) return null;
  try {
    const got = await area.get(STORE_KEY);
    const blob = got && got[STORE_KEY];
    return blob && blob.entries ? blob.entries : null;
  } catch (err) {
    return null;
  }
}

async function write(area, entries) {
  if (!area) return;
  try {
    if (entries.length) await area.set({ [STORE_KEY]: { entries } });
    else await area.remove(STORE_KEY);
  } catch (err) {
    /* 配额满 / 存储不可用：内存层照常工作 */
  }
}

export function createCache(storage) {
  const session = storage && storage.session;
  const local = storage && storage.local;
  const memory = makeLayer(LIMITS.memoryEntries, LIMITS.memoryBytes);
  const disk = makeLayer(Infinity, LIMITS.diskBytes);
  let dirtySession = false;
  let dirtyLocal = false;
  let timer = 0;
  let generation = 0; // clear() 之后，还在路上的 load 结果作废
  let hits = 0;
  let misses = 0;

  async function load() {
    const gen = generation;
    const [s, l] = await Promise.all([read(session), read(local)]);
    if (gen !== generation) return;
    // 磁盘层不整份灌进内存层：用到哪条再提升哪条（见 get），免得 session 区再存一份重复的
    disk.restore(l);
    memory.restore(s);
  }

  const ready = load();

  async function flush() {
    clearTimeout(timer);
    timer = 0;
    const jobs = [];
    if (dirtySession) {
      dirtySession = false;
      jobs.push(write(session, memory.dump()));
    }
    if (dirtyLocal) {
      dirtyLocal = false;
      jobs.push(write(local, disk.dump()));
    }
    await Promise.all(jobs);
  }

  function scheduleFlush() {
    if (timer) return;
    timer = setTimeout(flush, LIMITS.flushMs);
  }

  return {
    ready,
    flush,

    get(key) {
      let value = memory.get(key);
      if (value === undefined) {
        value = disk.get(key);
        if (value !== undefined) {
          memory.set(key, value);
          dirtySession = true;
          scheduleFlush();
        }
      }
      if (value === undefined) misses += 1;
      else hits += 1;
      return value;
    },

    set(key, value) {
      memory.set(key, value);
      dirtySession = true;
      if (textOf(key).length + value.length <= LIMITS.diskEntryChars) {
        disk.set(key, value);
        dirtyLocal = true;
      }
      scheduleFlush();
    },

    async clear() {
      generation += 1;
      clearTimeout(timer);
      timer = 0;
      dirtySession = false;
      dirtyLocal = false;
      memory.clear();
      disk.clear();
      hits = 0;
      misses = 0;
      await Promise.all([write(session, []), write(local, [])]);
    },

    size: () => memory.map.size,

    stats() {
      return {
        memory: { entries: memory.map.size, bytes: memory.bytes, maxEntries: LIMITS.memoryEntries, maxBytes: LIMITS.memoryBytes },
        disk: { entries: disk.map.size, bytes: disk.bytes, maxBytes: LIMITS.diskBytes, maxEntryChars: LIMITS.diskEntryChars },
        hits,
        misses
      };
    }
  };
}

// 扩展里用的实例；不在扩展环境（单测）时没有 chrome.storage，只剩内存层
const chromeStorage =
  typeof chrome !== 'undefined' && chrome.storage ? { session: chrome.storage.session, local: chrome.storage.local } : null;

const shared = createCache(chromeStorage);

export const ready = shared.ready;
export const get = (key) => shared.get(key);
export const set = (key, value) => shared.set(key, value);
export const clear = () => shared.clear();
export const stats = () => shared.stats();

// 设置页显示用：浏览器实际记的磁盘占用（估算值只用来做 LRU 预算）
export async function bytesInUse() {
  const out = { session: null, local: null };
  if (!chromeStorage) return out;
  for (const area of ['session', 'local']) {
    try {
      if (chromeStorage[area] && chromeStorage[area].getBytesInUse) {
        out[area] = await chromeStorage[area].getBytesInUse(STORE_KEY);
      }
    } catch (err) {
      /* 旧版浏览器的 session 区没有 getBytesInUse */
    }
  }
  return out;
}
