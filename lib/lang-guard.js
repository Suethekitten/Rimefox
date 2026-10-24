// 译文目标语言的保守校验（纯函数，可脱离浏览器测试：test/lang-guard.test.mjs）
// 只抓一种高置信度错误：目标语言是拉丁字母语系（English / Français / Deutsch / Español / Português），
// 整段译文却几乎全是中日韩文字、还带着句末句读。
//
// 为什么只做这一种：
// - 日文和中文共用大量汉字，单看“有没有汉字”必然误判，必须结合拉丁字母比例与长度；
// - 短文本（按钮、标题、人名）、术语 / 人名清单、代码、URL 不适合做语言判定；
// - 英文译文里合理保留中文人名、日文专名、引用是允许的，所以要求中日韩文字占比很高；
// - 判断依据不足时一律放行，宁可漏过一条，也不拦正常译文。
// 两个方向共用同一套保守阈值：
// - 拉丁目标却整段中日韩：中日韩占比 >= 0.6、拉丁占比 <= 0.1；
// - 中日韩目标却整段拉丁：拉丁占比 >= 0.8、长度 >= 40、有句末标点。
// 短按钮 / 标题 / 人名、品牌 / 缩写 / 代码 / 合法中英混排都不判；宁可漏过，不误杀。
const LETTER = /\p{L}/gu;
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u1100-\u11ff]/gu;
const LATIN = /[A-Za-z]/g;
const ARABIC = /\p{Script=Arabic}/gu;
// 句末句读：中文 / 日文标点，或模型偶尔混用的 ASCII 句号 / 阿拉伯问号
const SENTENCE_END = /[。！？.!?؟]/;
const LATIN_TARGET = /^(en|fr|de|es|pt)(-|_|$)/i;
const CJK_TARGET = /^(zh|ja|ko)(-|_|$)/i;
const ARABIC_TARGET = /^ar(-|_|$)/i;

// source-aware guard for short source echoes / refusals. looksForeignForTarget
// needs >=40 letters, which misses a short "Sorry, I can't help with that." or
// a one-sentence source echo. If the source is substantial and the output
// contains no target-script letters at all, it is not a usable translation.
// This intentionally does not judge mixed-language proper names: output with
// some target-script text is left to the calibrated script-ratio guard.
export function looksUntranslatedForTarget(source, translation, target) {
  if (looksForeignForTarget(translation, target)) return true;
  const code = String(target == null ? '' : target);
  const src = String(source == null ? '' : source);
  const out = String(translation == null ? '' : translation);
  if ((src.match(LETTER) || []).length < 40 || (out.match(LETTER) || []).length < 8) return false;
  const cjk = (out.match(CJK) || []).length;
  const latin = (out.match(LATIN) || []).length;
  const arabic = (out.match(ARABIC) || []).length;
  if (CJK_TARGET.test(code)) return cjk === 0;
  if (LATIN_TARGET.test(code)) return latin === 0;
  if (ARABIC_TARGET.test(code)) return arabic === 0;
  return false;
}

export function looksForeignForTarget(text, target) {
  const code = String(target == null ? '' : target);
  if (!LATIN_TARGET.test(code) && !CJK_TARGET.test(code) && !ARABIC_TARGET.test(code)) return false;
  const value = String(text == null ? '' : text);
  const letters = (value.match(LETTER) || []).length;
  // 太短：按钮、标题、人名，信息不足，不判
  if (letters < 40) return false;
  const latin = (value.match(LATIN) || []).length;
  const cjk = (value.match(CJK) || []).length;
  const arabic = (value.match(ARABIC) || []).length;
  // 没有句末句读：更可能只是术语 / 人名清单，不判
  if (!SENTENCE_END.test(value)) return false;
  if (LATIN_TARGET.test(code)) {
    // 混了足够的拉丁字母：正常的英文译文（可能带中文专名、引用）
    if (latin / letters > 0.1) return false;
    // 不到六成是中日韩文字：不是“整段中文 / 日文 / 韩文”
    if (cjk / letters >= 0.6) return true;
    // 阿拉伯语目标源文回显 / 其他非拉丁文字：拉丁占比低且整段非目标文字
    return arabic / letters >= 0.8;
  }
  if (ARABIC_TARGET.test(code)) {
    if (cjk / letters >= 0.6) return true;
    return latin / letters >= 0.8 && arabic / letters < 0.1;
  }
  // 中日韩目标却整段拉丁 / 阿拉伯文：只抓几乎全非中日韩文字、
  // 足够长且有句末标点的回包。中文正文里保留 API / GitHub / 品牌名时，
  // 非中日韩文字占比远低于 0.8。
  return (latin + arabic) / letters >= 0.8;
}
