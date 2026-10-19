// 术语表：纯函数（解析 CSV / 清洗 / 匹配 / 拼提示词片段 / 缓存指纹）
// 不碰 DOM、不读 storage，可以用 node 直接测（test/glossary.test.mjs）。

export const GLOSSARY_MAX = 500; // 最多保留的术语条数
export const GLOSSARY_PROMPT_LIMIT = 20; // 每批最多注入的术语条数

const MAX_SIDE = 200; // 单侧最长字符数（防止整段塞进来）

function cleanOne(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SIDE);
}

// 统一成 [{ source, target, category? }]：去空、去重（按小写原文）、截断、限条数。
// category 是设置页分组的元数据，不参与匹配 / 提示词 / 缓存指纹；没有分类时不写这个键。
export function normalizeGlossary(list) {
  const out = [];
  const seen = new Set();
  const rows = Array.isArray(list) ? list : [];

  for (const row of rows) {
    if (!row) continue;
    let source = '';
    let target = '';
    let category = '';
    if (typeof row === 'string') {
      const parts = row.split(',');
      source = parts[0];
      target = parts[1];
      category = parts[2];
    } else if (Array.isArray(row)) {
      source = row[0];
      target = row[1];
      category = row[2];
    } else if (typeof row === 'object') {
      source = row.source;
      target = row.target;
      category = row.category;
    }
    const s = cleanOne(source);
    const t = cleanOne(target);
    if (!s || !t) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const item = { source: s, target: t };
    const c = cleanOne(category).slice(0, 40);
    if (c) item.category = c;
    out.push(item);
    if (out.length >= GLOSSARY_MAX) break;
  }
  return out;
}

// 一键收录（划词气泡「加入术语表」）：把一条（原文, 译法）并进列表，不改原数组。
// 返回 { list, action }：
//   'added'    新增了一条
//   'updated'  覆盖了同原文的旧译法（分类保留）
//   'conflict' 原文已有、译法不同，等用户确认后再带 overwrite 调用
//   'same'     原文和译法都已存在，什么都不用改
//   'full'     已经到 GLOSSARY_MAX 条，不再新增（改已有条目仍然可以）
//   'invalid'  原文或译法为空
export function upsertGlossaryEntry(list, entry, opts) {
  const rows = normalizeGlossary(list);
  const source = cleanOne(entry && entry.source);
  const target = cleanOne(entry && entry.target);
  if (!source || !target) return { list: rows, action: 'invalid' };

  const key = source.toLowerCase();
  const at = rows.findIndex((one) => one.source.toLowerCase() === key);

  if (at < 0) {
    if (rows.length >= GLOSSARY_MAX) return { list: rows, action: 'full' };
    return { list: rows.concat([{ source: source, target: target }]), action: 'added' };
  }

  const old = rows[at];
  if (old.target === target) return { list: rows, action: 'same' };
  if (!(opts && opts.overwrite)) return { list: rows, action: 'conflict', current: old.target };

  const next = rows.slice();
  const item = { source: old.source, target: target };
  if (old.category) item.category = old.category;
  next[at] = item;
  return { list: next, action: 'updated' };
}

// 一个 CSV 单元格：带逗号 / 引号 / 换行时用双引号包起来，内部引号写两次
function csvCell(value) {
  const s = String(value == null ? '' : value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// 逐字符解析 CSV（支持引号、引号内逗号与换行、"" 转义）
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const s = String(text == null ? '' : text).replace(/^\uFEFF/, '');

  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// 解析 CSV：原文,译法[,分类]（多余列忽略），首行表头自动跳过
export function parseGlossaryCsv(text) {
  const rows = parseCsvRows(text);
  const list = [];

  rows.forEach((row, index) => {
    if (!row) return;
    const first = String(row[0] == null ? '' : row[0]).trim().toLowerCase();
    if (index === 0 && (first === 'source' || first === '原文' || first === '术语')) return; // 表头
    list.push({ source: row[0], target: row[1], category: row[2] });
  });

  return normalizeGlossary(list);
}

export function toGlossaryCsv(list) {
  const rows = ['source,target,category'];
  normalizeGlossary(list).forEach((one) => {
    rows.push(csvCell(one.source) + ',' + csvCell(one.target) + ',' + csvCell(one.category || ''));
  });
  return rows.join('\n') + '\n';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 纯拉丁 / 数字的术语按词边界匹配（避免 cat 命中 category）；含中日韩字符的按子串匹配
function matcherFor(source) {
  const source_l = source.toLowerCase();
  if (/^[\x00-\x7F]+$/.test(source)) {
    let re;
    try {
      // 零宽断言：连续出现（"Gamma Gamma"）也能全部数到；消费边界字符会漏掉相邻的下一个
      re = new RegExp('(?<![A-Za-z0-9_])' + escapeRegExp(source) + '(?![A-Za-z0-9_])', 'gi');
    } catch (err) {
      re = new RegExp('(^|[^A-Za-z0-9_])' + escapeRegExp(source) + '(?![A-Za-z0-9_])', 'gi');
    }
    return (text) => {
      re.lastIndex = 0;
      let count = 0;
      while (re.exec(text) !== null) {
        count += 1;
        if (re.lastIndex === 0) re.lastIndex += 1;
      }
      return count;
    };
  }
  return (text) => {
    const hay = text.toLowerCase();
    let count = 0;
    let from = 0;
    for (;;) {
      const at = hay.indexOf(source_l, from);
      if (at < 0) break;
      count += 1;
      from = at + source_l.length;
    }
    return count;
  };
}

// 在一批文本里找命中的术语：按出现次数降序，同次数时长的优先
export function matchGlossary(list, texts, limit) {
  const max = limit == null ? GLOSSARY_PROMPT_LIMIT : limit;
  const rows = normalizeGlossary(list);
  if (!rows.length) return [];
  const input = (Array.isArray(texts) ? texts : []).map((t) => String(t == null ? '' : t));
  if (!input.length) return [];

  const hits = [];
  rows.forEach((one) => {
    const countOf = matcherFor(one.source);
    let count = 0;
    input.forEach((text) => {
      count += countOf(text);
    });
    if (count > 0) hits.push({ source: one.source, target: one.target, count });
  });

  hits.sort((a, b) => b.count - a.count || b.source.length - a.source.length);
  return hits.slice(0, Math.max(0, max)).map((one) => ({ source: one.source, target: one.target }));
}

// 提示词片段：没有命中就返回空串，调用方直接拼在后面
export function glossaryPrompt(hits) {
  const rows = Array.isArray(hits) ? hits : [];
  if (!rows.length) return '';
  const lines = rows.map((one) => '- ' + one.source + ' → ' + one.target);
  return (
    '术语对照（必须使用下面给定的译法；标题、按钮、导航等短文本同样适用，不要意译或改写）：\n' +
    lines.join('\n')
  );
}

// 缓存键用的指纹：只算这段原文命中的术语，没命中任何术语的段落是 'none'。
// 以前用整张术语表的指纹，加一条术语全站缓存失效（一键收录以后术语表会经常变）；
// 现在只有含这个词的段落要重翻。返回 (text) => 指纹，同一请求里对多段原文复用一套匹配器
export function createHitFingerprint(list) {
  const rows = normalizeGlossary(list);
  const matchers = rows.map((one) => ({ one, count: matcherFor(one.source) }));
  return (text) => {
    if (!matchers.length) return 'none';
    const s = String(text == null ? '' : text);
    return glossaryFingerprint(matchers.filter((m) => m.count(s) > 0).map((m) => m.one));
  };
}

// 术语表的指纹（整张，或 createHitFingerprint 挑出来的命中部分）：增删改都会变，空表为 'none'。
// 分类只是设置页的元数据，不参与匹配 / 提示词 / 指纹。
export function glossaryFingerprint(list) {
  const rows = normalizeGlossary(list);
  if (!rows.length) return 'none';
  let hash = 0x811c9dc5;
  const text = rows.map((one) => one.source + '\u0000' + one.target).join('\u0001');
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}
