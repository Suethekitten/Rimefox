// 站点规则：按网址指定只翻哪些区域、跳过哪些区域、固定显示方式（纯函数，test/site-rules.test.mjs）
//
// 一条规则：
//   { matches: ['github.com', '*.wikipedia.org', 'example.com/docs/*'],
//     textSelectors: [...],    // 只翻这些区域（留空 = 整页）
//     excludeSelectors: [...], // 这些区域不翻
//     mode: 'dual' | 'translation' | '',   // 固定显示方式（留空 = 跟随设置）
//     theme: 'underline' | … | '',          // 固定译文样式
//     note: '说明' }
//
// matches 的写法：域名可用 *. 通配子域名（*.wikipedia.org 也匹配 wikipedia.org 本身），
// 可以带路径，路径里的 * 匹配任意字符。不写协议。
// 内置规则随扩展更新；用户规则写在设置页，排在内置规则前面、优先生效。

export const MAX_RULES = 50;
const MAX_SELECTORS = 20;
const MAX_SELECTOR_LEN = 200;
const MODES = ['', 'dual', 'translation'];
const THEMES = ['', 'none', 'underline', 'dashed', 'highlight', 'mask'];

// 只收能在真实页面上核实过的规则（选择器来自页面实际的 class）
export const BUILTIN_SITE_RULES = [
  {
    matches: ['github.com'],
    excludeSelectors: ['.react-directory-filename-cell', '.react-directory-filename-column'],
    note: 'GitHub：文件列表里的文件名不翻译'
  },
  {
    matches: ['*.wikipedia.org'],
    excludeSelectors: ['.interlanguage-link'],
    note: 'Wikipedia：语言切换列表（上百个语言名）不翻译'
  }
];

function strList(value, max, maxLen, field, errors, index) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    errors.push('第 ' + (index + 1) + ' 条规则的 ' + field + ' 必须是数组');
    return [];
  }
  const out = [];
  value.forEach((item) => {
    const s = typeof item === 'string' ? item.trim() : '';
    if (!s) return;
    if (s.length > maxLen || /[{}]/.test(s)) {
      errors.push('第 ' + (index + 1) + ' 条规则的 ' + field + ' 里有不合法的项：' + s.slice(0, 40));
      return;
    }
    if (out.length < max && out.indexOf(s) < 0) out.push(s);
  });
  return out;
}

// 清洗用户规则：返回 { rules, errors }。有错误时 rules 只含合法的那些
export function normalizeSiteRules(raw) {
  const errors = [];
  if (raw === undefined || raw === null || raw === '') return { rules: [], errors };
  if (!Array.isArray(raw)) return { rules: [], errors: ['站点规则必须是一个 JSON 数组'] };
  const rules = [];
  raw.slice(0, MAX_RULES).forEach((one, i) => {
    if (!one || typeof one !== 'object' || Array.isArray(one)) {
      errors.push('第 ' + (i + 1) + ' 条规则不是对象');
      return;
    }
    const matches = strList(one.matches, MAX_SELECTORS, MAX_SELECTOR_LEN, 'matches', errors, i).filter((m) => {
      const ok = /^(\*\.)?[a-z0-9.-]+(:\d+)?(\/\S*)?$/i.test(m);
      if (!ok) errors.push('第 ' + (i + 1) + ' 条规则的网址写法不对：' + m);
      return ok;
    });
    if (!matches.length) {
      errors.push('第 ' + (i + 1) + ' 条规则没有可用的 matches');
      return;
    }
    const rule = {
      matches,
      textSelectors: strList(one.textSelectors, MAX_SELECTORS, MAX_SELECTOR_LEN, 'textSelectors', errors, i),
      excludeSelectors: strList(one.excludeSelectors, MAX_SELECTORS, MAX_SELECTOR_LEN, 'excludeSelectors', errors, i),
      mode: MODES.indexOf(one.mode || '') >= 0 ? one.mode || '' : '',
      theme: THEMES.indexOf(one.theme || '') >= 0 ? one.theme || '' : ''
    };
    if (one.mode && MODES.indexOf(one.mode) < 0) errors.push('第 ' + (i + 1) + ' 条规则的 mode 只能是 dual / translation');
    if (one.theme && THEMES.indexOf(one.theme) < 0) errors.push('第 ' + (i + 1) + ' 条规则的 theme 取值不认识');
    if (typeof one.note === 'string' && one.note.trim()) rule.note = one.note.trim().slice(0, 100);
    rules.push(rule);
  });
  if (raw.length > MAX_RULES) errors.push('最多 ' + MAX_RULES + ' 条规则，多出的已忽略');
  return { rules, errors };
}

function globToRegExp(glob) {
  return new RegExp('^' + glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i');
}

// 一条 matches 是否匹配这个网址
export function matchesUrl(pattern, url) {
  let u;
  try {
    u = new URL(url);
  } catch (err) {
    return false;
  }
  const slash = pattern.indexOf('/');
  const hostPart = (slash >= 0 ? pattern.slice(0, slash) : pattern).toLowerCase();
  const pathPart = slash >= 0 ? pattern.slice(slash) : '';
  const host = u.hostname.toLowerCase() + (hostPart.indexOf(':') >= 0 && u.port ? ':' + u.port : '');
  let hostOk;
  if (hostPart.indexOf('*.') === 0) {
    const base = hostPart.slice(2);
    hostOk = host === base || host.endsWith('.' + base);
  } else {
    hostOk = host === hostPart;
  }
  if (!hostOk) return false;
  return !pathPart || globToRegExp(pathPart).test(u.pathname + u.search);
}

// 这个网址生效的规则合并结果：用户规则在前（mode / theme 取第一个写了的），选择器取并集
export function resolveSiteRule(url, userRules, builtinRules) {
  const all = (userRules || []).concat(builtinRules || BUILTIN_SITE_RULES);
  const hit = all.filter((r) => (r.matches || []).some((m) => matchesUrl(m, url)));
  if (!hit.length) return null;
  const merged = { textSelectors: [], excludeSelectors: [], mode: '', theme: '', notes: [] };
  hit.forEach((r) => {
    (r.textSelectors || []).forEach((s) => merged.textSelectors.indexOf(s) < 0 && merged.textSelectors.push(s));
    (r.excludeSelectors || []).forEach((s) => merged.excludeSelectors.indexOf(s) < 0 && merged.excludeSelectors.push(s));
    if (!merged.mode && r.mode) merged.mode = r.mode;
    if (!merged.theme && r.theme) merged.theme = r.theme;
    if (r.note) merged.notes.push(r.note);
  });
  return merged;
}

// ---------------- 网页夜间模式的站点名单 ----------------
// 一行一个域名，包含子域名；返回去重后的小写域名列表
export function normalizeHosts(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
  const out = [];
  list.forEach((item) => {
    let h = String(item || '').trim().toLowerCase();
    h = h.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/^\*\./, '');
    // 至少有一个点（example.com），或者是 localhost；单个词不是域名
    if (!h || !/^(([a-z0-9-]+\.)+[a-z0-9-]+|localhost)(:\d+)?$/.test(h)) return;
    if (out.indexOf(h) < 0 && out.length < 200) out.push(h);
  });
  return out;
}

export function hostListed(hostname, hosts) {
  const h = String(hostname || '').toLowerCase();
  return (hosts || []).some((one) => h === one || h.endsWith('.' + one));
}
