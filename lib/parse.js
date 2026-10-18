// 模型返回值的解析（纯函数，可脱离浏览器用 node 直接测试）
// 期望输入：翻译接口要求模型只吐一个 JSON 字符串数组。
// 现实里模型会：包 markdown 代码块、前后加解释、单条时不包数组、把一条拆成几句……

export function parseArray(raw, expected) {
  let text = String(raw || '').trim();
  if (!text) return null;

  // 去掉 markdown 代码块围栏
  text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();

  // 1) 先从文本里抠出 JSON 数组（前后可能带解释文字）
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    let arr = null;
    try {
      arr = JSON.parse(text.slice(start, end + 1));
    } catch (err) {
      /* 落到下面的兜底 */
    }
    if (Array.isArray(arr)) {
      if (arr.length === expected) return arr.map((x) => (x == null ? '' : String(x)));

      // 只请求一条时，模型常把一段拆成好几句放进数组。
      // 拼回一段即可 —— 划词翻译永远只有一条，这里失败等于功能不可用。
      if (expected === 1) {
        const joined = arr
          .map((x) => (x == null ? '' : String(x)).trim())
          .filter(Boolean)
          .join('');
        if (joined) return [joined];
      }

      // 合法数组但条数不对（多条批量）：不能按行拆，多行 JSON 拆出来是
      // `[`、`"xx",` 这种碎片，会被当成译文插进页面。交给调用方重试 / 对半拆。
      return null;
    }
  }

  // 2) 只请求一条：模型常常直接回译文本身，不包数组
  if (expected === 1) {
    try {
      const s = JSON.parse(text);
      if (typeof s === 'string') return [s];
      if (Array.isArray(s) && s.length) {
        const joined = s
          .map((x) => (x == null ? '' : String(x)).trim())
          .filter(Boolean)
          .join('');
        if (joined) return [joined];
      }
    } catch (err) {
      /* 不是合法 JSON，按纯文本处理 */
    }
    // 去掉可能残留的引号 / 方括号
    const cleaned = text.replace(/^[\s"'[\]]+/, '').replace(/[\s"'[\]]+$/, '').trim();
    return [cleaned || text];
  }

  // 3) 兜底：按行拆（有些模型会输出 "1. xxx" 形式）
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*\d]+[.、)]\s*/, '').trim())
    .filter((line) => line.length > 0);

  if (lines.length === expected) return lines;
  return null;
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
