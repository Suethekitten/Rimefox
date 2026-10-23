// 医学术语匹配（纯函数 / 零运行时依赖）
// 数据只包含经过审核的方向；只把本批真正命中的术语交给提示词。
// 用户术语由调用方先匹配，再通过 excludeSources 排除，保证用户译法优先。
import { MEDICAL_TERMS, MEDICAL_LEXICON_VERSION } from './data/en-zh-CN.js';
import { MEDICAL_PROFILE_VERSION } from './profile.js';
import { matcherFor, glossaryFingerprint } from '../glossary.js';

const EN = 'en';
const ZH = 'zh-CN';
const IRREGULAR = {
  diagnosis: 'diagnoses',
  prognosis: 'prognoses',
  analysis: 'analyses',
  metastasis: 'metastases',
  thrombosis: 'thromboses'
};

function isEnglish(value) {
  return /^[\x00-\x7F]+$/.test(String(value || '')) && /[A-Za-z]/.test(String(value || ''));
}

function variantsFor(source) {
  const base = String(source || '');
  const out = [base];
  if (!isEnglish(base) || /[^A-Za-z0-9 /-]/.test(base)) return out;
  const words = base.split(/\s+/);
  const last = words[words.length - 1];
  if (!last || /[0-9]$/.test(last)) return out;
  if (/[^aeiou]y$/i.test(last)) {
    out.push(words.slice(0, -1).concat(last.slice(0, -1) + 'ies').join(' '));
  } else if (IRREGULAR[last.toLowerCase()]) {
    out.push(words.slice(0, -1).concat(IRREGULAR[last.toLowerCase()]).join(' '));
  } else if (!/(s|x|z|ch|sh)$/i.test(last) && !/f$/i.test(last)) {
    out.push(words.slice(0, -1).concat(last + 's').join(' '));
  }
  return out;
}

function directionFor(target) {
  const code = String(target || '').trim().toLowerCase();
  if (code === EN) return 'zh>en';
  if (code === 'zh' || code === 'zh-cn' || code === 'zh-hans') return 'en>zh';
  return '';
}

function accepted(term) {
  return term && term.matchEnabled !== false && (term.status === 'reviewed' || term.status === 'reviewed-upstream');
}

function sourceVariants(term) {
  // 别名必须与主词同义并经过同一审校；abbreviation 不自动进入匹配器。
  const aliases = Array.isArray(term.aliases) ? term.aliases.filter((x) => typeof x === 'string' && x.trim()) : [];
  return Array.from(new Set([term.source].concat(aliases).flatMap((x) => variantsFor(x))));
}

function compile() {
  const result = { 'en>zh': [], 'zh>en': [] };
  MEDICAL_TERMS.forEach((term) => {
    if (!accepted(term) || !term.source || !term.target) return;
    if (isEnglish(term.source) && term.targetLang === ZH) {
      result['en>zh'].push({
        source: term.source,
        target: term.target,
        variants: sourceVariants(term),
        matchers: sourceVariants(term).map((v) => matcherFor(v)),
        term
      });
    }
    // 只有来源词表声明双向（MIT 词表）的条目才反向；不把英汉表整体反转。
    if (term.reverse === true && isEnglish(term.source) && /[^\x00-\x7F]/.test(term.target)) {
      result['zh>en'].push({
        source: term.target,
        target: term.source,
        variants: [term.target],
        matchers: [matcherFor(term.target)],
        term
      });
    }
  });
  return result;
}

const COMPILED = compile();

function normalizeExclude(list) {
  if (!list) return new Set();
  if (list instanceof Set) return new Set(Array.from(list, (x) => String(x).toLowerCase()));
  return new Set(Array.from(list, (x) => String(x).toLowerCase()));
}

function longestOnly(hits) {
  return hits.filter((one, i) => {
    const s = one.source.toLowerCase();
    return !hits.some((other, j) => {
      if (i === j) return false;
      const o = other.source.toLowerCase();
      return o.length > s.length && o.indexOf(s) >= 0;
    });
  });
}

function rowsForText(text, dir, exclude) {
  const s = String(text == null ? '' : text);
  const rows = [];
  (COMPILED[dir] || []).forEach((entry) => {
    if (exclude.has(entry.source.toLowerCase()) || entry.variants.some((v) => exclude.has(v.toLowerCase()))) return;
    let count = 0;
    entry.matchers.forEach((countOf) => {
      count += countOf(s);
    });
    if (!count) return;
    rows.push({ entry, count });
  });
  const filtered = longestOnly(rows.map((one) => ({
    source: one.entry.source,
    target: one.entry.target,
    count: one.count,
    term: one.entry.term
  })));
  return filtered;
}

// 返回最多 limit 条命中，按长术语优先、出现次数其次；调用方再按用户术语排除。
export function matchMedicalTerms(texts, target, limit, excludeSources) {
  const dir = directionFor(target);
  const max = Math.max(0, Number(limit) || 0);
  if (!dir || !max) return [];
  const exclude = normalizeExclude(excludeSources);
  const input = (Array.isArray(texts) ? texts : []).map((x) => String(x == null ? '' : x));
  const counts = new Map();
  input.forEach((text) => {
    rowsForText(text, dir, exclude).forEach((hit) => {
      const key = hit.source.toLowerCase();
      const old = counts.get(key);
      if (old) old.count += hit.count;
      else counts.set(key, { source: hit.source, target: hit.target, count: hit.count, term: hit.term });
    });
  });
  const hits = Array.from(counts.values());
  const filtered = longestOnly(hits);
  filtered.sort((a, b) => b.source.length - a.source.length || b.count - a.count);
  return filtered.slice(0, max).map((hit) => ({
    source: hit.source,
    target: hit.target,
    domain: hit.term.domain || '',
    subdomain: hit.term.subdomain || '',
    id: hit.term.id || '',
    version: hit.term.version || '',
    sourceId: hit.term.sourceId || '',
    status: hit.term.status || '',
    abbreviation: hit.term.abbreviation || '',
    contextHint: hit.term.contextHint || ''
  }));
}

// 医学模式的缓存身份：规则版本 + 词库版本 + 本段有效命中的医学术语。
// 无命中也是 'none'，但医学模式本身仍与普通模式分开（因为提示词不同）。
export function medicalFingerprintFor(text, target, excludeSources) {
  const dir = directionFor(target);
  const base = 'm' + MEDICAL_PROFILE_VERSION + ':' + MEDICAL_LEXICON_VERSION + ':';
  if (!dir) return base + 'rules';
  const exclude = normalizeExclude(excludeSources);
  const rows = rowsForText(text, dir, exclude).map((one) => ({
    source: one.source + '#' + (one.term.id || '') + ':' + (one.term.version || ''),
    target: one.target
  }));
  return base + glossaryFingerprint(rows);
}

export function medicalDirectionFor(target) {
  return directionFor(target);
}

export function medicalStats() {
  return {
    version: MEDICAL_LEXICON_VERSION,
    profileVersion: MEDICAL_PROFILE_VERSION,
    total: MEDICAL_TERMS.length,
    disabled: MEDICAL_TERMS.filter((t) => t.matchEnabled === false).length,
    reviewed: MEDICAL_TERMS.filter((t) => t.status === 'reviewed').length,
    reviewedUpstream: MEDICAL_TERMS.filter((t) => t.status === 'reviewed-upstream').length,
    enToZh: COMPILED['en>zh'].length,
    zhToEn: COMPILED['zh>en'].length
  };
}
