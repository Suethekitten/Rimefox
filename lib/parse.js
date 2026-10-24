// 模型返回值的解析（纯函数，可脱离浏览器用 node 直接测试）
// 期望输入：翻译接口要求模型只吐一个 JSON 字符串数组。
// 现实里模型会：包 markdown 代码块、前后加解释、单条时不包数组、把一条拆成几句……

// 模型偶尔在 JSON 字符串里直接写换行 / 制表符（应写成 \n），整个数组因此解析失败，
// 多条批量会被当成失败、对半拆开重发。这里只转义字符串字面量里面的控制字符，字符串外的排版换行不动
export function escapeRawControls(json) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const c of String(json)) {
    if (!inString) {
      if (c === '"') inString = true;
      out += c;
    } else if (escaped) {
      escaped = false;
      out += c;
    } else if (c === '\\') {
      escaped = true;
      out += c;
    } else if (c === '"') {
      inString = false;
      out += c;
    } else if (c === '\n') {
      out += '\\n';
    } else if (c === '\r') {
      out += '\\r';
    } else if (c === '\t') {
      out += '\\t';
    } else {
      out += c;
    }
  }
  return out;
}

// 字符串字面量外面、紧挨着 ] 或 } 的多余逗号（["a","b",]）：删掉这个分隔符即可解析，不改任何内容
export function stripTrailingCommas(json) {
  const src = String(json);
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      out += c;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ',') {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j += 1;
      if (src[j] === ']' || src[j] === '}') continue;
    }
    out += c;
  }
  return out;
}

// 从 start 处的 [ 往后找与它配对的 ]（跳过字符串字面量里的括号）；配不上返回 -1
function matchBracket(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === '[') {
      depth += 1;
    } else if (c === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// 只做确定性的修补（参考 Wenyi「修复只能去掉围栏或增删边界分隔符，不能补造内容」）：
// 原样 → 转义字符串里的裸控制字符 → 再去掉多余的结尾逗号。截断、结构有歧义的照样失败
function parseArraySlice(slice) {
  const candidates = [slice, escapeRawControls(slice)];
  candidates.push(stripTrailingCommas(candidates[1]));
  for (const candidate of candidates) {
    try {
      const value = JSON.parse(candidate);
      if (Array.isArray(value)) return value;
    } catch (err) {
      /* 换下一种修补 */
    }
  }
  return null;
}

// 文本里所有能解析的最外层 JSON 数组，按出现顺序：[{ value, embedded }]。
// 每个 [ 按括号配对找自己的 ]：以前终点固定在全文最后一个 ]，数组后面的说明里只要有 [1] / [sic]，
// 真正的数组就解析不出来，反而把说明里的 [1] 当成了答案。
// embedded = 数组前后还有别的文字（说明、围栏、正文）
function findJsonArrays(text) {
  const out = [];
  let start = text.indexOf('[');
  for (let tries = 0; start >= 0 && tries < 16; tries += 1) {
    const end = matchBracket(text, start);
    const value = end > start ? parseArraySlice(text.slice(start, end + 1)) : null;
    if (value) {
      out.push({ value, embedded: !!text.slice(0, start).trim() || !!text.slice(end + 1).trim() });
      start = text.indexOf('[', end + 1); // 数组里面的 [ 不再单独当起点
    } else {
      start = text.indexOf('[', start + 1);
    }
  }
  return out;
}

// 夹在文字中间的数组只有元素全是字符串 / 对象时才可能是答案：
// 纯文本回复里的引注 [1]、说明里的 "[2] results" 不能拿来顶替整段译文
function answerLike(found) {
  if (!found.embedded) return true;
  return (
    found.value.length > 0 &&
    found.value.every((x) => typeof x === 'string' || (x && typeof x === 'object' && !Array.isArray(x)))
  );
}

// 数组元素 → 译文。模型偶尔把每条包成对象（[{"translation": "…"}]）：只认这几个明确的译文字段，
// 而且只能有一个；别的结构认不出来就返回 undefined（整批按失败处理），
// 以前直接 String(x)，网页上会出现 "[object Object]"
const ITEM_KEYS = ['translation', 'translated_text', 'translatedText', 'text'];
function itemText(x) {
  if (x == null) return '';
  if (typeof x === 'string') return x;
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  if (typeof x === 'object' && !Array.isArray(x)) {
    const keys = ITEM_KEYS.filter((k) => typeof x[k] === 'string');
    if (keys.length === 1) return x[keys[0]];
  }
  return undefined;
}

function itemsOf(arr) {
  const out = arr.map(itemText);
  return out.some((x) => x === undefined) ? null : out;
}

// 只请求一条、模型直接回了纯文本：只有整段被一对引号 / 方括号包着、里面又没有同样的符号时才剥掉。
// 以前不分青红皂白剥首尾的 " ' [ ]，英文对白 "What are you doing?" she asked. 会丢掉引号
function unwrapPlain(text) {
  let s = text.trim();
  for (const [open, close] of [['[', ']'], ['"', '"'], ["'", "'"]]) {
    if (s.length >= 2 && s[0] === open && s[s.length - 1] === close && s.slice(1, -1).indexOf(close) < 0 && s.slice(1, -1).indexOf(open) < 0) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

// 拼回被拆开的几句：中文 / 日文句子之间不加字，其它（英文、韩文……）用一个空格隔开。
// 以前一律直接拼接，["Hello.", "How are you?"] 拼成了 "Hello.How are you?"
const NO_SPACE = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
function joinPieces(pieces) {
  return pieces.reduce((out, piece) => {
    if (!out) return piece;
    const glue = NO_SPACE.test(out.slice(-1)) || NO_SPACE.test(piece.charAt(0)) ? '' : ' ';
    return out + glue + piece;
  }, '');
}

export function parseArray(raw, expected) {
  let text = String(raw || '').trim();
  if (!text) return null;

  // 去掉 markdown 代码块围栏
  text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();

  // 1) 先从文本里抠出 JSON 数组（前后可能带解释文字）。
  // 有几个时取最后一个条数对得上的（前言里偶尔会先引用一遍原文）；都对不上就按最后一个处理
  const arrays = findJsonArrays(text).filter(answerLike);
  if (arrays.length) {
    for (let i = arrays.length - 1; i >= 0; i -= 1) {
      const hit = itemsOf(arrays[i].value);
      if (hit && hit.length === expected) return hit;
    }
    const items = itemsOf(arrays[arrays.length - 1].value);
    if (!items) return null; // 元素认不出来：不能把对象 / 嵌套结构当译文插进页面

    // 只请求一条时，模型常把一段拆成好几句放进数组。
    // 拼回一段即可 —— 划词翻译永远只有一条，这里失败等于功能不可用。
    if (expected === 1) {
      const joined = joinPieces(items.map((x) => x.trim()).filter(Boolean));
      if (joined) return [joined];
    }

    // 合法数组但条数不对（多条批量）：不能按行拆，多行 JSON 拆出来是
    // `[`、`"xx",` 这种碎片，会被当成译文插进页面。交给调用方重试 / 对半拆。
    return null;
  }

  // 2) 只请求一条：模型常常直接回译文本身，不包数组。
  // 但如果明显是没闭合 / 截断的 JSON 数组或对象，不能把半截协议当正文。
  if (expected === 1) {
    if (text[0] === '[' || text[0] === '{') return null;
    try {
      const s = JSON.parse(text);
      if (typeof s === 'string') return [s];
    } catch (err) {
      /* 不是合法 JSON，按纯文本处理 */
    }
    const cleaned = unwrapPlain(text);
    return [cleaned || text];
  }

  // 3) 兜底：按行拆（有些模型会输出 "1. xxx" 形式）。
  // 看起来是一个没解析成功的 JSON 数组（以 [ 开头、或某行是 "…", 这种 JSON 字符串）就不拆：
  // 拆出来的是带引号逗号的碎片，条数碰巧对上时会被当成译文
  if (text[0] === '[') return null;
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*\d]+[.、)]\s*/, '').trim())
    .filter((line) => line.length > 0);
  if (lines.some((line) => /^"[\s\S]*"\s*,?$/.test(line))) return null;

  if (lines.length === expected) return lines;
  return null;
}

// ---------------- 换行规范化（Pixiv 中译英偶发字面 \n） ----------------
// 模型偶尔把换行多转义一层：JSON 里写成 \\n，解析后译文里是「反斜杠 + n」两个字符，网页上直接显示 \n，
// 还会进缓存。也见于单条请求直接回纯文本、或回了一个多转义的 JSON 字符串。
// 只在能确定是格式污染时才改，不做全局 replace（代码、正则、Windows 路径、转义说明里的 \n 是正文）：
//   1) 原文里有任何反斜杠 → 含义不明，原样返回
//   2) 原文有分行：把字面 \n 换成真换行后，非空行数与原文一致 → 采用（恢复分行）
//   3) 其余情况：译文里每一处字面 \n 都紧贴在句末标点 / 引号 / 中日韩字符后面、后面是新一句的开头，
//      或在开头结尾（正文的格式残留）→ 全部清掉（中日文之间不加字，其它换成一个空格）；
//      只要有一处看着像说明文字或路径（"\n"、`\n`、夹在字母之间、后面是小写字母 / 数字、C:\new）就整段原样保留
// 幂等：要么全部换掉、要么一个不动，再跑一次结果不变
const BREAK_TOKEN = /\\+(?:r\\+n|n|r)/g;
// 连在一起的若干个字面换行（含两边的空格）算一处：asked.\n\n"I'm
const BREAK_RUN = /[ \t]*(?:\\+(?:r\\+n|n|r)[ \t]*)+/g;
const BREAK_LEFT = /[.!?…。！？；;:：,，、"'”’」』）)\]぀-ヿ㐀-鿿가-힯]/;
const CJK_CHAR = /[　-〿぀-ヿ㐀-鿿＀-￯]/;

function nonBlankLines(text) {
  return String(text)
    .split(/\r\n?|\n/)
    .filter((line) => line.trim()).length;
}

export function normalizeTranslationBreaks(source, translated) {
  if (typeof translated !== 'string' || translated.indexOf('\\') < 0) return translated;
  const src = String(source == null ? '' : source);
  if (src.indexOf('\\') >= 0) return translated;
  const runs = [];
  translated.replace(BREAK_RUN, (m, at) => {
    runs.push({ at, len: m.length });
    return m;
  });
  if (!runs.length) return translated;

  const srcLines = nonBlankLines(src);
  if (srcLines >= 2) {
    const candidate = translated.replace(BREAK_TOKEN, '\n');
    if (nonBlankLines(candidate) === srcLines) return candidate;
  }

  // 每一处字面换行都得是「正文格式残留」，否则整段不动
  const repls = [];
  for (const run of runs) {
    const prev = translated.slice(0, run.at).slice(-1);
    const next = translated.charAt(run.at + run.len);
    if (!prev || !next) {
      repls.push(''); // 开头 / 结尾多出来的
      continue;
    }
    if (!BREAK_LEFT.test(prev)) return translated; // 夹在字母、数字之间：可能是说明文字
    // 换行之后该是新的一句（大写字母、引号、括号、中日韩字）；后面紧跟小写字母 / 数字（C:\new、\n2）就不是
    if (/[a-z0-9]/.test(next)) return translated;
    if (/(^|[^A-Za-z])[A-Za-z]:$/.test(translated.slice(0, run.at))) return translated; // 盘符 C:
    if ((prev === '"' || prev === "'") && next === prev) return translated; // "\n" 这种写法
    if (prev === '`' || next === '`') return translated;
    repls.push(CJK_CHAR.test(prev) && CJK_CHAR.test(next) ? '' : ' ');
  }
  let k = 0;
  return translated.replace(BREAK_RUN, () => repls[k++]).trim();
}

// ---------------- 写入前的兜底校验 ----------------
// 参考 Agent Book Translate 的 write-time validation（src/core/engine.rs、src/core/qa.rs）：
// 一条译文里残留 JSON 包装 / 字段名 / 本扩展提示词的原句，而原文里没有 → 不能插进网页、不能进缓存，按失败处理
const LEAK_PATTERNS = [
  /\{\s*"(?:translation|translated_text|translatedText|translations|text|role|content)"\s*:/,
  /"translations"\s*:\s*\[/,
  /\[object Object\]/,
  /你是一个网页翻译引擎/,
  // 0.9.6 起提示词开头换成「你是专业的网页文本翻译引擎」，旧写法继续拦（旧缓存 / 旧模型回包）
  /你是专业的网页文本翻译引擎/,
  /唯一目标语言/,
  /只输出 JSON 数组本身/,
  /输出：一个 JSON 字符串数组/,
  /结构化对象只有 parts 字段/
];

export function leaksWrapper(source, output) {
  const out = String(output == null ? '' : output);
  const src = String(source == null ? '' : source);
  return LEAK_PATTERNS.some((re) => re.test(out) && !re.test(src));
}

// 输出长度护栏：原文不太短、译文却长出 4 倍以上，多半是模型在回应原文里的"指令"、
// 复述提示词或自行续写 —— 插进页面会伪造内容、撑爆版面，按"无需翻译"处理。
// 中日韩字符按 2 计：中文翻成英文本来就会变长 2~3 倍，不能误杀。
const WIDE = /[぀-ヿ㐀-鿿가-힯]/g;

function weight(text) {
  const s = String(text || '');
  return s.length + (s.match(WIDE) || []).length;
}

export function isRunaway(source, output) {
  const src = weight(source);
  if (src < 20) return false;
  return String(output || '').length > src * 4;
}

// content 为空时从思考过程里找答案：推理模型（DeepSeek 等）偶尔把最终的 JSON 数组写进 reasoning_content。
// 思考过程里常常先引用一遍原文数组，所以从后往前找：最后一个能被 parseArray 解析成
// 「条数对得上的字符串数组」的片段；和输入一模一样的不要（那只是在复述原文）。
// inputs：本批送翻的原文数组；找不到返回 null
export function parseArrayFromReasoning(text, inputs) {
  const s = String(text || '');
  const expected = (inputs || []).length;
  if (!s || !expected) return null;
  const same = (arr) => arr.every((x, i) => String(x).trim() === String(inputs[i]).trim());
  let tries = 0;
  for (let end = s.lastIndexOf(']'); end > 0 && tries < 400; end = s.lastIndexOf(']', end - 1)) {
    for (let start = s.lastIndexOf('[', end); start >= 0 && tries < 400; start = s.lastIndexOf('[', start - 1)) {
      tries += 1;
      const piece = s.slice(start, end + 1);
      let arr = null;
      try {
        arr = JSON.parse(piece);
      } catch (err) {
        continue; // 不是完整的 JSON 数组（比如套在更大的数组里的一截），往前扩
      }
      if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'string')) break;
      const parsed = parseArray(piece, expected);
      if (parsed && !same(parsed)) return parsed;
      break; // 这个 ']' 配出的数组不合用，换前一个 ']'
    }
  }
  return null;
}

// ---------------- 结构化对齐（0.9.1） ----------------
// align 模式下模型对每条返回：
//   {"parts":[{"n":1,"t":"第一句译文"},{"n":2,"t":"后两句合起来的译文"}]}
// n = 该片段覆盖的原文句数（内容脚本按自己的切句规则校验总和）。
// 这里只做确定性校验：n 是 1..99 的整数、t 是非空字符串；不符合就整条退回普通字符串数组，
// 页面照常显示，只是没有句级对应（悬停自动降级为行 / 段落级）。
function alignedPartsOf(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const raw = item.parts;
  if (!Array.isArray(raw) || !raw.length) return null;
  const out = [];
  for (const part of raw) {
    if (!part || typeof part !== 'object' || Array.isArray(part)) return null;
    const n = Number(part.n);
    if (!Number.isInteger(n) || n < 1 || n > 99) return null;
    if (typeof part.t !== 'string' || !part.t.trim()) return null;
    out.push({ n, t: part.t.trim() });
  }
  return out;
}

function alignedRow(item) {
  if (typeof item === 'string') return { text: item, align: null };
  const parts = alignedPartsOf(item);
  if (parts) {
    return { text: joinPieces(parts.map((p) => p.t)), align: parts };
  }
  const text = itemText(item);
  return typeof text === 'string' ? { text, align: null } : null;
}

export function parseAlignedArray(raw, expected) {
  let text = String(raw || '').trim();
  if (!text) return null;
  text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();

  const arrays = findJsonArrays(text).filter(answerLike);
  for (let i = arrays.length - 1; i >= 0; i -= 1) {
    const arr = arrays[i].value;
    if (!Array.isArray(arr) || arr.length !== expected) continue;
    const rows = arr.map(alignedRow);
    if (rows.every((row) => row && typeof row.text === 'string')) {
      return { texts: rows.map((row) => row.text), aligns: rows.map((row) => row.align) };
    }
  }
  // 模型没遵守结构化格式：退回普通数组解析（不因为对齐失败而丢掉整批译文）
  const plain = parseArray(raw, expected);
  return plain ? { texts: plain, aligns: plain.map(() => null) } : null;
}
