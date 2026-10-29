// 翻译缓存（三层）
// L1 内存 Map           —— 热数据，查询零开销
// L2 chrome.storage.session —— L1 的落地副本：service worker 空闲约 30 秒就被回收，
//                          以前缓存跟着全丢，刷新页面 / 关开一次都要重翻。session 区不写磁盘，关浏览器即清
// L3 chrome.storage.local   —— 重启浏览器后还在；只存短文本（按钮、标题、导航），按字节预算 LRU
//
// 键 = 版本 | 目标语言 | 风格 | 服务商:模型 | 域名 | 提示词/术语/专业策略 | 接口身份 \n 原文
// - 版本：提示词 / 解析规则改了就 +1，老缓存整体作废
// - 服务商:模型：换模型后不再命中旧模型的译文
// - 域名：某个页面诱导出的坏译文（提示词注入）只污染它自己的站点，不会落盘后在所有网站生效
//
// 存储读写通过 createCache({ session, local }) 注入，单测用假存储（test/cache.test.mjs）。

const SCHEMA = 'v1';
// 0.8.8 及以前：每一层整份存在一个键里，每次落盘都把整层（session 最多约 4MB）重写一遍。
// 现在分段存：dt.cache.v1.<层>.<段号>，外加一个段号清单；落盘只写有改动的段。读到旧格式时迁移过来并删掉
const LEGACY_KEY = 'dt.cache.v1';
const SEG_PREFIX = 'dt.cache.v1.';

export const LIMITS = {
  memoryEntries: 8000,
  memoryBytes: 4 * 1024 * 1024, // session 区配额 10MB，留足余量
  diskBytes: 512 * 1024,
  diskEntryChars: 160, // 原文 + 译文 ≤ 160 字符才进磁盘层
  memorySegmentBytes: 256 * 1024, // 落盘分段大小（估算字节）：新写入只追加在最新一段
  diskSegmentBytes: 64 * 1024,
  flushMs: 2500
};

// scope: { target, style, model, host, glossary, prompt, endpoint }
export function makeKey(scope, text) {
  const s = scope || {};
  // glossary / prompt 是术语表与自定义提示词的指纹：改了之后旧译文必须失效。
  // prompt 为空时不加这一段，避免升级后把所有旧缓存键都换掉、全站重翻。
  const parts = [SCHEMA, s.target || '', s.style || 'plain', s.model || '', s.host || '', s.glossary || 'none'];
  if (s.prompt) parts.push(s.prompt);
  // 自定义语言的名称 / 代码 / 说明参与提示词：只有自定义目标带这一段，内置语言旧键逐字不变。
  if (s.lang) parts.push(s.lang);
  // 趣味风格强度 / 风格提示词版本：只在非 plain 风格追加，普通翻译旧键不变。
  if (s.styleVersion) parts.push(s.styleVersion);
  // AI 精翻：开启时即使上下文为空也隔离身份，避免把普通模式译文当成带上下文的译文复用。
  if (s.ai) parts.push(s.ai);
  // 医学模式只在自己开启时追加：旧普通缓存键逐字不变，专业译文也不会读普通条目。
  if (s.medical) parts.push(s.medical);
  if (s.professional) parts.push(s.professional);
  // 视频字幕按平台 / 视频 / cid / 轨道 / 源语言隔离；普通请求不追加，旧缓存键逐字不变。
  if (s.subtitle) parts.push(s.subtitle);
  // 协议和规范化地址同时隔离持久缓存、对齐旁路和在途请求；无身份的旧条目不会命中。
  if (s.endpoint) parts.push('endpoint-v1:' + s.endpoint);
  return parts.join('|') + '\n' + text;
}

function textOf(key) {
  const i = key.indexOf('\n');
  return i >= 0 ? key.slice(i + 1) : key;
}

// 视频字幕条目的键带 subtitle-v1: 段（Bilibili 已被压成内容键 subtitle-v1:content，
// YouTube 仍带平台 / 视频 / 轨道）。磁盘层重启后还在，这些条目写进去就成了「看过哪些视频」的记录：
// 只留在内存层和 session 层（关浏览器即清）。判据只看前缀，不看身份细节。
function memoryOnly(key) {
  const i = key.indexOf('\n');
  return (i >= 0 ? key.slice(0, i) : key).indexOf('|subtitle-v1:') >= 0;
}

// 估算落盘字节：storage 按 JSON 的 UTF-8 计，中日韩字符 3 字节，再加数组括号引号的开销
function cost(key, value) {
  return (key.length + value.length) * 3 + 16;
}

function isPair(pair) {
  return Array.isArray(pair) && typeof pair[0] === 'string' && typeof pair[1] === 'string';
}

// 一层缓存在存储里的分段镜像。每条记在写入时所在的段：新写入追加到最新一段（写满换下一段），
// 删除 / 淘汰只让它所在的那段变脏。落盘时只写脏段和段号清单。
// 读取（LRU 提升）不改落盘内容，所以恢复后的顺序是「最后写入的顺序」，近似 LRU
function createMirror(area, tag, segmentBytes) {
  const indexKey = SEG_PREFIX + tag + '.index';
  const segKey = (id) => SEG_PREFIX + tag + '.' + id;
  const segOf = new Map(); // 键 → 段号
  const segs = new Map(); // 段号 → Map(键 → 译文)
  const sizes = new Map(); // 段号 → 估算字节
  const dirty = new Set();
  let current = 0;
  let indexDirty = false;
  let legacy = false; // 存储里还有旧格式的整层键，下次落盘时删掉

  function drop(key) {
    const id = segOf.get(key);
    if (id === undefined) return;
    const seg = segs.get(id);
    sizes.set(id, sizes.get(id) - cost(key, seg.get(key)));
    seg.delete(key);
    segOf.delete(key);
    dirty.add(id);
  }

  // id：恢复时传它原来所在的段（不算改动）；平时不传，写进最新一段
  function put(key, value, id) {
    drop(key);
    let seg = id;
    if (seg === undefined) {
      if ((sizes.get(current) || 0) >= segmentBytes) current += 1;
      seg = current;
    } else if (seg > current) {
      current = seg;
    }
    if (!segs.has(seg)) {
      segs.set(seg, new Map());
      sizes.set(seg, 0);
      indexDirty = true;
    }
    segs.get(seg).set(key, value);
    sizes.set(seg, sizes.get(seg) + cost(key, value));
    segOf.set(key, seg);
    if (id === undefined) dirty.add(seg);
  }

  // 读出存储里的全部条目：[[键, 译文, 段号], ...]，按段号、段内顺序（旧 → 新）；旧格式的条目不带段号
  async function read() {
    if (!area) return [];
    try {
      const got = (await area.get([indexKey, LEGACY_KEY])) || {};
      const out = [];
      const blob = got[LEGACY_KEY];
      if (blob && Array.isArray(blob.entries)) {
        legacy = true;
        blob.entries.forEach((pair) => {
          if (isPair(pair)) out.push([pair[0], pair[1]]);
        });
      }
      const ids = (Array.isArray(got[indexKey]) ? got[indexKey] : [])
        .filter((id) => Number.isInteger(id) && id >= 0)
        .sort((a, b) => a - b);
      if (ids.length) {
        const parts = (await area.get(ids.map(segKey))) || {};
        ids.forEach((id) => {
          const rows = parts[segKey(id)];
          if (!Array.isArray(rows)) return;
          rows.forEach((pair) => {
            if (isPair(pair)) out.push([pair[0], pair[1], id]);
          });
        });
      }
      return out;
    } catch (err) {
      return [];
    }
  }

  async function flush() {
    if (!area) {
      dirty.clear();
      return;
    }
    const writes = {};
    const removes = [];
    dirty.forEach((id) => {
      const seg = segs.get(id);
      if (seg && seg.size) {
        writes[segKey(id)] = Array.from(seg.entries());
      } else {
        removes.push(segKey(id));
        segs.delete(id);
        sizes.delete(id);
        indexDirty = true;
      }
    });
    dirty.clear();
    if (indexDirty) {
      writes[indexKey] = Array.from(segs.keys()).sort((a, b) => a - b);
      indexDirty = false;
    }
    if (legacy) {
      removes.push(LEGACY_KEY);
      legacy = false;
    }
    try {
      if (Object.keys(writes).length) await area.set(writes);
      if (removes.length) await area.remove(removes);
    } catch (err) {
      /* 配额满 / 存储不可用：内存层照常工作 */
    }
  }

  async function clear() {
    const ids = new Set(segs.keys());
    segOf.clear();
    segs.clear();
    sizes.clear();
    dirty.clear();
    current = 0;
    indexDirty = false;
    legacy = false;
    if (!area) return;
    try {
      // 还没加载进来的段也要删：以存储里的清单为准
      const got = (await area.get(indexKey)) || {};
      (Array.isArray(got[indexKey]) ? got[indexKey] : []).forEach((id) => ids.add(id));
      await area.remove(Array.from(ids).map(segKey).concat(indexKey, LEGACY_KEY));
    } catch (err) {
      /* 存储不可用 */
    }
  }

  return {
    put,
    drop,
    read,
    flush,
    clear,
    get dirty() {
      return dirty.size > 0 || indexDirty || legacy;
    },
    keys: () => Array.from(segs.keys()).map(segKey).concat(indexKey)
  };
}

// 一个按插入顺序 LRU、带条数和字节上限的 Map；mirror 跟着记落盘分段（单测不落盘时为 null）
function makeLayer(maxEntries, maxBytes, mirror) {
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
    // seg：恢复时这条原来所在的落盘分段
    set(key, value, seg) {
      if (map.has(key)) bytes -= cost(key, map.get(key));
      map.delete(key);
      map.set(key, value);
      bytes += cost(key, value);
      if (mirror) mirror.put(key, value, seg);
      while (map.size > 1 && (map.size > maxEntries || bytes > maxBytes)) {
        const oldest = map.keys().next().value;
        bytes -= cost(oldest, map.get(oldest));
        map.delete(oldest);
        if (mirror) mirror.drop(oldest);
      }
    },
    delete(key) {
      if (!map.has(key)) return false;
      bytes -= cost(key, map.get(key));
      map.delete(key);
      if (mirror) mirror.drop(key);
      return true;
    },
    clear() {
      map.clear();
      bytes = 0;
    },
    // 从存储恢复：[键, 译文, 段号?]，顺序即 LRU 顺序（旧 → 新）
    restore(entries) {
      entries.forEach((row) => this.set(row[0], row[1], row[2]));
    }
  };
}

export function createCache(storage) {
  const session = storage && storage.session;
  const local = storage && storage.local;
  const sessionMirror = session ? createMirror(session, 's', LIMITS.memorySegmentBytes) : null;
  const localMirror = local ? createMirror(local, 'l', LIMITS.diskSegmentBytes) : null;
  const memory = makeLayer(LIMITS.memoryEntries, LIMITS.memoryBytes, sessionMirror);
  const disk = makeLayer(Infinity, LIMITS.diskBytes, localMirror);
  let timer = 0;
  let generation = 0; // clear() 之后，还在路上的 load 结果作废
  let epoch = 0; // 给调用方判断“请求开始后是否发生过清空”；set 不能复活旧结果
  let hits = 0;
  let misses = 0;

  async function load() {
    const gen = generation;
    const [s, l] = await Promise.all([
      sessionMirror ? sessionMirror.read() : [],
      localMirror ? localMirror.read() : []
    ]);
    if (gen !== generation) return;
    // 磁盘层不整份灌进内存层：用到哪条再提升哪条（见 get），免得 session 区再存一份重复的
    disk.restore(l);
    // 0.12.6 开发版曾把字幕条目写进磁盘层：读到就删掉，下次落盘时一并清出磁盘。
    for (const key of Array.from(disk.map.keys())) if (memoryOnly(key)) disk.delete(key);
    memory.restore(s);
    // 旧格式迁移过来的条目、恢复时超出预算被淘汰的：尽快落盘
    if ((sessionMirror && sessionMirror.dirty) || (localMirror && localMirror.dirty)) scheduleFlush();
  }

  const ready = load();

  async function flush() {
    clearTimeout(timer);
    timer = 0;
    await Promise.all([sessionMirror && sessionMirror.flush(), localMirror && localMirror.flush()]);
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
          scheduleFlush();
        }
      }
      if (value === undefined) misses += 1;
      else hits += 1;
      return value;
    },

    set(key, value) {
      memory.set(key, value);
      if (!memoryOnly(key) && textOf(key).length + value.length <= LIMITS.diskEntryChars) disk.set(key, value);
      scheduleFlush();
    },

    epoch: () => epoch,

    // 删掉一条（读出来发现是坏译文时用）：内存层和磁盘层都删，照常延迟落盘
    remove(key) {
      const fromMemory = memory.delete(key);
      const fromDisk = disk.delete(key);
      if (fromMemory || fromDisk) scheduleFlush();
    },

    async clear() {
      generation += 1;
      epoch += 1;
      clearTimeout(timer);
      timer = 0;
      memory.clear();
      disk.clear();
      hits = 0;
      misses = 0;
      await Promise.all([sessionMirror && sessionMirror.clear(), localMirror && localMirror.clear()]);
    },

    size: () => memory.map.size,

    // 存储里属于缓存的键（设置页显示实际占用用）
    storageKeys() {
      return {
        session: sessionMirror ? sessionMirror.keys() : [],
        local: localMirror ? localMirror.keys() : []
      };
    },

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
export const epoch = () => shared.epoch();
export const remove = (key) => shared.remove(key);
export const clear = () => shared.clear();
export const stats = () => shared.stats();

// 设置页显示用：浏览器实际记的磁盘占用（估算值只用来做 LRU 预算）
export async function bytesInUse() {
  const out = { session: null, local: null };
  if (!chromeStorage) return out;
  const keys = shared.storageKeys();
  for (const area of ['session', 'local']) {
    try {
      if (chromeStorage[area] && chromeStorage[area].getBytesInUse) {
        out[area] = await chromeStorage[area].getBytesInUse(keys[area]);
      }
    } catch (err) {
      /* 旧版浏览器的 session 区没有 getBytesInUse */
    }
  }
  return out;
}
