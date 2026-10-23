// 医学译文检查：数值/保留标记做确定性比对；语义线索只产生 review，绝不改写正文。
// pass 仅表示没有命中这些有限规则，不是医学正确性或组别对应关系的证明。
const NUMBER = '(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?(?:e[+-]?\\d+)?|\\.\\d+(?:e[+-]?\\d+)?';
const VALUE = '(?:[+-]?(?:' + NUMBER + '))';

function normalized(text) {
  return String(text == null ? '' : text).normalize('NFKC')
    .replace(/[−﹣]/g, '-').replace(/[–—〜～~]/g, '–')
    .replace(/[\u00a0\u202f\u2009]/g, ' ')
    .replace(/(\d) (?=\d{3}(?:\D|$))/g, '$1')
    .replace(/([0-9.]+)\s*[×x]\s*10\s*\^\s*([+-]?\d+)/gi, '$1e$2');
}

// 字符串十进制规范化，不经浮点舍入；只有表示方式变化才合并。
function decimal(value) {
  let text = String(value).replace(/,/g, '').toLowerCase();
  let sign = '';
  if (/^[+-]/.test(text)) { sign = text[0] === '-' ? '-' : ''; text = text.slice(1); }
  const parts = text.split('e');
  const exponent = parts.length > 1 ? Number(parts[1]) : 0;
  if (!Number.isInteger(exponent) || Math.abs(exponent) > 100) return sign + text;
  const pair = parts[0].split('.');
  const digits = pair.join('');
  const point = pair[0].length + exponent;
  let whole = point <= 0 ? '0' : digits.slice(0, point) + '0'.repeat(Math.max(0, point - digits.length));
  let fraction = point <= 0 ? '0'.repeat(-point) + digits : digits.slice(point);
  whole = whole.replace(/^0+(?=\d)/, '') || '0';
  fraction = fraction.replace(/0+$/, '');
  if (whole === '0' && !fraction) sign = '';
  return sign + whole + (fraction ? '.' + fraction : '');
}

function collect(text, regex, map) {
  return Array.from(text.matchAll(regex), (match) => map ? map(match) : match[0]);
}

function sameBag(a, b) {
  if (a.length !== b.length) return false;
  const counts = new Map();
  a.forEach((x) => counts.set(x, (counts.get(x) || 0) + 1));
  for (const value of b) {
    if (!counts.get(value)) return false;
    counts.set(value, counts.get(value) - 1);
  }
  return true;
}

function numbers(text) {
  text = text.replace(/(\d)(?=(?:mg|[μµu]g|kg|g|mL|ml|L|mmol|[μµu]mol|IU)(?![A-Za-z]))/g, '$1 ');
  const pattern = new RegExp('(?<![A-Za-z0-9_])(' + VALUE + ')(?![A-Za-z0-9_])', 'gi');
  return collect(text, pattern, (m) => {
    // 1-2 是范围，第二个端点不是负数；负号只在数值语境中保留。
    const value = m[1][0] === '-' && /[\d.]$/.test(text.slice(0, m.index)) ? m[1].slice(1) : m[1];
    return decimal(value);
  });
}

function quantitative(text) {
  const percent = collect(text, new RegExp('(' + VALUE + ')\\s*(?:%|percent\\b|per cent\\b)', 'gi'), (m) => decimal(m[1]));
  const pvalues = collect(text, new RegExp('(?:\\bp|p值)\\s*(?:值)?\\s*([<>=≤≥])\\s*(' + VALUE + ')', 'gi'), (m) => m[1] + decimal(m[2]));
  const units = { '毫克': 'mg', '微克': 'ug', 'μg': 'ug', 'µg': 'ug', '克': 'g', '千克': 'kg', '公斤': 'kg', '毫升': 'ml', '升': 'l', '毫摩尔': 'mmol', '微摩尔': 'umol', 'μmol': 'umol', 'µmol': 'umol', '国际单位': 'iu' };
  const dose = collect(text, new RegExp('(' + VALUE + ')\\s*(mg|[μµu]g|kg|g|m[lL]|[lL]|mmol|[μµu]mol|IU|毫克|微克|千克|公斤|克|毫升|升|毫摩尔|微摩尔|国际单位)(?![A-Za-z])(?:\\s*[/／]\\s*(kg|m[lL]|[lL]|day|d|h|天|日|小时|千克|公斤))?', 'g'), (m) => decimal(m[1]) + ':' + (units[m[2]] || m[2].toLowerCase()) + (m[3] ? '/' + ({ 天: 'd', 日: 'd', 小时: 'h', day: 'd', 千克: 'kg', 公斤: 'kg' }[m[3]] || m[3].toLowerCase()) : ''));
  const ci = collect(text, new RegExp('(?:\\bCI\\b|confidence interval|置信区间)\\s*[,，:：为是]?\\s*[\\[(]?\\s*(' + VALUE + ')\\s*(?:[–-]|至|to)\\s*(' + VALUE + ')', 'gi'), (m) => decimal(m[1]) + ':' + decimal(m[2]));
  const pairs = collect(text, new RegExp('(' + VALUE + ')\\s*(?:patients?|participants?|subjects?|例(?:患者)?|名(?:患者|受试者)?|位患者)\\s*[\\[(]\\s*(' + VALUE + ')\\s*%\\s*[\\])]', 'gi'), (m) => decimal(m[1]) + ':' + decimal(m[2]));
  return { percent, pvalues, dose, ci, pairs };
}

const SEMANTIC_RISKS = [
  { code: 'NEGATION_RISK', en: /\b(?:no|not|never|without|neither|failed to)\b/i, zh: /(?:不|未|无|没有|并非|否认|缺乏)/, message: '原文的否定线索可能未保留。', severity: 'high' },
  { code: 'CONDITION_RISK', en: /\b(?:if|unless|provided that|only when)\b/i, zh: /(?:如果|若|除非|仅当|只在|条件|情况下|才|如)/, message: '原文条件线索可能未保留。', severity: 'medium' },
  { code: 'UNCERTAINTY_RISK', en: /\b(?:may|might|could|possible|possibly|probable|probably|suspected|suggest(?:s|ed)?)\b/i, zh: /(?:可能|或许|也许|疑似|怀疑|提示|推测|大概|有望|可|认为)/, message: '原文的不确定性可能被强化。', severity: 'high' }
];

function semanticIssues(source, target, context) {
  const issues = [];
  const add = (code, message, severity = 'high') => issues.push({ code, message, severity, kind: 'semantic' });
  // 语义启发式仅用于明确的英中/中英正文；其他语言不套用中文关键字规则。
  const language = String(context && context.target || '').trim().toLowerCase();
  const chineseTarget = /^zh(?:-(?:cn|tw|hk|hans|hant)(?:-[a-z]+)?)?$/.test(language);
  const englishTarget = /^en(?:-[a-z]+)?$/.test(language);
  if (language && !chineseTarget && !englishTarget) return issues;
  // 汉字不等于中文：日文/韩文包含的汉字不能作为中英规则的语言证据。
  if (/[\u3040-\u30ff\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(source + target)) return issues;
  const enZh = /[A-Za-z]{3}/.test(source) && !/[\u3400-\u9fff]/.test(source) && /[\u3400-\u9fff]/.test(target);
  const zhEn = /[\u3400-\u9fff]/.test(source) && /[A-Za-z]{3}/.test(target) && !/[\u3400-\u9fff]/.test(target);
  if (language && ((enZh && !chineseTarget) || (zhEn && !englishTarget))) return issues;
  if (!enZh && !zhEn) return issues;
  SEMANTIC_RISKS.forEach((rule) => {
    if ((enZh ? rule.en.test(source) && !rule.zh.test(target) : rule.zh.test(source) && !rule.en.test(target))) add(rule.code, rule.message, rule.severity);
  });
  if (enZh && /\b(?:associat\w*|correlat\w*)\b/i.test(source) && !/\b(?:caus(?:e|es|ed|ing)|lead\w* to|result\w* in)\b/i.test(source) && /(?:导致|造成|引起|致使)/.test(target)) add('CAUSAL_STRENGTHENING_RISK', '相关性表述可能被强化为因果。');
  if (zhEn && /(?:相关|关联)/.test(source) && !/(?:导致|造成|引起)/.test(source) && /\b(?:caus\w*|lead\w* to|result\w* in)\b/i.test(target)) add('CAUSAL_STRENGTHENING_RISK', '相关性表述可能被强化为因果。');
  if (enZh && /\bno (?:statistically )?significant difference\b/i.test(source) && /(?:无差异|没有差异|不存在差异)/.test(target) && !/(?:统计|显著|明显)/.test(target)) add('STATISTICAL_STRENGTHENING_RISK', '无统计学显著差异可能被写成不存在差异。');
  if (enZh && /\b(?:decreas\w*|reduc\w*|lower\w*)\b/i.test(source) && !/\b(?:increas\w*|higher\w*|rais\w*)\b/i.test(source) && /(?:增加|升高|提高|上升)/.test(target) && !/(?:下降|降低|减少)/.test(target)) add('DIRECTION_RISK', '效应或风险方向可能颠倒。');
  if (enZh && /\b(?:increas\w*|higher\w*|rais\w*)\b/i.test(source) && !/\b(?:decreas\w*|reduc\w*|lower\w*)\b/i.test(source) && /(?:下降|降低|减少)/.test(target) && !/(?:增加|升高|提高|上升)/.test(target)) add('DIRECTION_RISK', '效应或风险方向可能颠倒。');
  return issues;
}

export function validateMedical(source, translation, context) {
  const issues = [];
  const add = (code, message, severity = 'high', kind = 'deterministic') => issues.push({ code, message, severity, kind });
  if (typeof translation !== 'string' || !translation.trim()) {
    add('EMPTY_TRANSLATION', '译文为空。');
    return { status: 'error', issues, checked: true };
  }
  const rawSource = String(source == null ? '' : source);
  const rawTarget = translation;
  const markers = /<k\d+>[\s\S]*?<\/k\d+>|__PII_[A-Z_]+_\d+__/g;
  const protectedSource = collect(rawSource, markers);
  const protectedTarget = collect(rawTarget, markers);
  if (!sameBag(protectedSource, protectedTarget)) add('PROTECTED_MARKER_MISMATCH', '引用、保留内容或隐私占位标记发生变化。');
  // 被保护内容里的数字不重复参与正文统计；标记本身已经精确比较。
  let a = normalized(rawSource.replace(markers, ' '));
  let b = normalized(rawTarget.replace(markers, ' '));
  const identifiers = /\b(?:NCT\d{8}|ISRCTN\d{8}|ChiCTR[-A-Za-z]*\d{6,}|PMID\s*:?\s*\d+|10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+)\b/g;
  const idsA = collect(a, identifiers, (m) => m[0].replace(/\s/g, ''));
  const idsB = collect(b, identifiers, (m) => m[0].replace(/\s/g, ''));
  if (!sameBag(idsA, idsB)) add('RESEARCH_IDENTIFIER_MISMATCH', '研究标识符或文献标识符发生变化。');
  a = a.replace(identifiers, ' ');
  b = b.replace(identifiers, ' ');
  const qa = quantitative(a);
  const qb = quantitative(b);
  [
    ['percent', 'PERCENT_MISMATCH', '百分比发生变化。'],
    ['pvalues', 'P_VALUE_MISMATCH', 'p 值或比较运算符发生变化。'],
    ['dose', 'DOSE_UNIT_MISMATCH', '数值与剂量/单位的对应发生变化。'],
    ['ci', 'CONFIDENCE_INTERVAL_MISMATCH', '置信区间端点或方向发生变化。'],
    ['pairs', 'COUNT_PERCENT_PAIR_MISMATCH', '人数与百分比的局部对应发生变化。']
  ].forEach(([key, code, message]) => {
    // CI/人数配对可能采用未覆盖的合法表达；只有双方均可解析才断言对应不一致。
    if ((key === 'ci' || key === 'pairs') && (!qa[key].length || !qb[key].length)) {
      if (qa[key].length || qb[key].length) add(key === 'ci' ? 'CONFIDENCE_INTERVAL_UNVERIFIED' : 'COUNT_PERCENT_PAIR_UNVERIFIED', '数值采用未覆盖的表达，局部对应需要审查。', 'medium', 'semantic');
      return;
    }
    if (!sameBag(qa[key], qb[key])) add(code, message);
  });
  if (/\bCI\b|confidence interval|置信区间/i.test(a + ' ' + b) && (!qa.ci.length || !qb.ci.length) && !issues.some((x) => x.code === 'CONFIDENCE_INTERVAL_UNVERIFIED')) add('CONFIDENCE_INTERVAL_UNVERIFIED', '置信区间采用未覆盖的表达，端点对应需要审查。', 'medium', 'semantic');
  const numsA = numbers(a);
  const numsB = numbers(b);
  const bagEqual = sameBag(numsA, numsB);
  if (!bagEqual) {
    const writtenNumber = /[零〇一二三四五六七八九十百千万亿两]+(?:例|名|位|个|天|年|月|次|毫克|微克|克|百分之)/.test(a + b) || /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)\b/i.test(a + b);
    add('NUMBER_MISMATCH', writtenNumber ? '数字表达不同，可能采用了文字数词，需要核对。' : '正文数值的多重集合不同，需要核对数值。', writtenNumber ? 'medium' : 'high');
  }
  const comparison = /\b(?:versus|vs\.?|respectively|compared|control group|treatment group)\b|分别|相比|对照组|试验组/i.test(a + ' ' + b);
  // 人数/百分比配对只能证明局部数值一致，不能证明 treatment/control 等组别归属。
  if (bagEqual && numsA.length > 1 && comparison) add('NUMBER_ASSOCIATION_UNVERIFIED', '数值相同但组别/终点对应无法仅凭本地规则确认。', 'medium', 'semantic');
  const knownSymbols = /\b(?:BRCA[12]|TP53|EGFR|APOE|BRAF|KRAS|HER2|IL-\d+)\b/g;
  if (!sameBag(collect(a, knownSymbols), collect(b, knownSymbols))) add('MEDICAL_SYMBOL_MISMATCH', '需保留的基因/蛋白符号发生变化。');
  const symbols = context && Array.isArray(context.protectedSymbols) ? context.protectedSymbols : [];
  symbols.filter((x) => typeof x === 'string' && x.length > 1 && x.length <= 40).slice(0, 30).forEach((symbol) => {
    if (a.includes(symbol) && !b.includes(symbol)) add('MEDICAL_SYMBOL_MISMATCH', '当前文档声明的医学符号可能丢失。');
  });
  issues.push(...semanticIssues(a, b, context));
  // 语义线索与文字数词只要求审查，不能被字符串启发式升级成确定性医学错误。
  const definite = issues.some((x) => x.kind === 'deterministic' && x.severity === 'high');
  return { status: definite ? 'error' : issues.length ? 'review' : 'pass', issues, checked: true };
}
