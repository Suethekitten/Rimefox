// 译文目标语言的保守校验（纯函数，可脱离浏览器测试：test/lang-guard.test.mjs）
// 只抓一种高置信度错误：目标语言是拉丁字母语系（English / Français / Deutsch / Español / Português），
// 整段译文却几乎全是中日韩文字、还带着句末句读。
//
// 为什么只做这一种：
// - 日文和中文共用大量汉字，单看“有没有汉字”必然误判，必须结合拉丁字母比例与长度；
// - 短文本（按钮、标题、人名）、术语 / 人名清单、代码、URL 不适合做语言判定；
// - 英文译文里合理保留中文人名、日文专名、引用是允许的，所以要求中日韩文字占比很高；
// - 判断依据不足时一律放行，宁可漏过一条，也不拦正常译文。
// 目前只用于「目标语言是英文却整段回中文」这类已确认的缓存污染 / 回包异常；
// 其它方向（中文目标却回英文等）没有证据，不做自动失效。
const LETTER = /\p{L}/gu;
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u1100-\u11ff]/gu;
const LATIN = /[A-Za-z]/g;
// 句末句读：中文 / 日文标点，或模型偶尔混用的 ASCII 句号（韩文、带中文正文的英文标点）
const SENTENCE_END = /[。！？.!?]/;
const LATIN_TARGET = /^(en|fr|de|es|pt)(-|_|$)/i;

export function looksForeignForTarget(text, target) {
  const code = String(target == null ? '' : target);
  if (!LATIN_TARGET.test(code)) return false;
  const value = String(text == null ? '' : text);
  const letters = (value.match(LETTER) || []).length;
  // 太短：按钮、标题、人名，信息不足，不判
  if (letters < 40) return false;
  const latin = (value.match(LATIN) || []).length;
  const cjk = (value.match(CJK) || []).length;
  // 混了足够的拉丁字母：正常的英文译文（可能带中文专名、引用）
  if (latin / letters > 0.1) return false;
  // 不到六成是中日韩文字：不是“整段中文 / 日文 / 韩文”
  if (cjk / letters < 0.6) return false;
  // 没有句末句读：更可能只是术语 / 人名清单，不判
  if (!SENTENCE_END.test(value)) return false;
  return true;
}
