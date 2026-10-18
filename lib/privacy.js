// 本地敏感信息脱敏 / 恢复：纯 JS、零依赖、零构建。
//
// 设计来源：OneAIFW (https://github.com/funstory-ai/aifw)
//   MIT License, Copyright (c) 2025 Funstory.ai Limited
// 复用了上游的占位符契约（__PII_<TYPE>_<n>__）、span 打分/去重思路与
// 「先脱敏再发给模型、回包后本地恢复」的流程；识别与恢复为独立 JS 重写，
// 不包含上游 Zig/WASM/模型代码。修改内容与许可证见 THIRD-PARTY-NOTICES.md。
//
// 安全边界：
//   - 映射只在本次调用的返回值里，调用方用完即丢，不落盘、不进日志；
//   - 恢复失败一律判失败（fail-closed），不返回半截译文；
//   - 关闭时所有函数原样返回，零行为变化。

export const PLACEHOLDER_PREFIX = '__PII_';

// 支持的实体类型（与上游 EntityType 命名对齐，方便日后对接）
export const TYPES = {
  EMAIL: 'EMAIL_ADDRESS',
  PHONE: 'PHONE_NUMBER',
  ID_CARD: 'ID_CARD',
  BANK_CARD: 'BANK_NUMBER',
  BANK_ACCOUNT: 'BANK_ACCOUNT',
  USER_NAME: 'USER_NAME'
};

const TYPE_LIST = [
  TYPES.EMAIL,
  TYPES.PHONE,
  TYPES.ID_CARD,
  TYPES.BANK_CARD,
  TYPES.USER_NAME
];

// 常见姓氏（简体）。用于「标签 + 姓氏」的保守姓名识别，避免把普通词当人名。
const SURNAMES =
  '王李张刘陈杨赵黄周吴徐孙胡朱高林何郭马罗梁宋郑谢韩唐冯于董萧程曹袁邓许傅沈曾彭吕苏卢蒋蔡贾丁魏薛叶阎余潘杜戴夏钟汪田任姜范方石姚谭廖邹熊金陆郝孔白崔康毛邱秦江史顾侯邵孟龙万段雷钱汤尹黎易常武乔贺赖龚文庞樊兰殷施陶洪翟安颜倪严牛温芦季俞章鲁葛伍韦申尤毕聂丛焦向柳邢路岳齐沿梅莫庄辛管祝左涂谷祁时舒耿牟卜路詹关苗凌费纪靳盛童欧甄项曲成游阳裴席卫查屈鲍位覃霍翁隋植甘景薄单包司柏宁柯阮桂闵解强柴华车冉房边辛';

const SURNAME_SET = new Set(SURNAMES);

// ---------------- 基础校验 ----------------

function luhn(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
const ID_CHECK = '10X98765432';

function validIdCard(raw) {
  const id = raw.toUpperCase();
  if (!/^\d{17}[\dX]$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 17; i += 1) sum += (id.charCodeAt(i) - 48) * ID_WEIGHTS[i];
  return ID_CHECK[sum % 11] === id[17];
}

function digitsOf(raw) {
  return raw.replace(/[^0-9]/g, '');
}

// ---------------- 识别器 ----------------
// 每个识别器返回 { start, end, type, value, score }，分数越高越优先。

function findEmails(text) {
  const out = [];
  const re = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
  let m;
  while ((m = re.exec(text))) {
    const value = m[0];
    // 去掉结尾的句点/逗号（正则不吃标点，这里兜底 TLD 必须是字母）
    if (!/\.[A-Za-z]{2,}$/.test(value)) continue;
    out.push({ start: m.index, end: m.index + value.length, type: TYPES.EMAIL, value, score: 0.95 });
  }
  return out;
}

function findIdCards(text) {
  const out = [];
  const re = /(?<![0-9A-Za-z])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![0-9A-Za-z])/g;
  let m;
  while ((m = re.exec(text))) {
    if (!validIdCard(m[0])) continue;
    out.push({ start: m.index, end: m.index + m[0].length, type: TYPES.ID_CARD, value: m[0], score: 0.98 });
  }
  return out;
}

function findBankCards(text) {
  const out = [];
  // 13–19 位数字，允许中间有空格 / 连字符；交给 Luhn 判断，避免把日期、订单号算进来
  const re = /(?<![0-9])\d(?:[ -]?\d){12,18}(?![0-9])/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const digits = digitsOf(raw);
    if (digits.length < 13 || digits.length > 19) continue;
    if (!luhn(digits)) continue;
    out.push({ start: m.index, end: m.index + raw.length, type: TYPES.BANK_CARD, value: raw, score: 0.92 });
  }
  return out;
}

// 银行账号没有统一校验位：只在「账号 / 账户 / 卡号」等明确标签后识别，
// 避免把普通的 16 位订单号一起脱敏。
function findBankAccounts(text) {
  const out = [];
  const re = /(?:银行账号|银行账户|账户号|银行账户号|账号|卡号|银行账户号码|Account\s*(?:Number|No\.?)|Bank\s*Account)\s*[:：]?\s*(\d[\d -]{7,23}\d)/gi;
  let m;
  while ((m = re.exec(text))) {
    const value = m[1];
    const offset = m[0].indexOf(value);
    const digits = digitsOf(value);
    if (digits.length < 8 || digits.length > 24) continue;
    out.push({ start: m.index + offset, end: m.index + offset + value.length, type: TYPES.BANK_ACCOUNT, value, score: 0.90 });
  }
  return out;
}

function findPhones(text) {
  const out = [];
  // 先抓候选，再用结构规则筛掉日期、版本号、订单号
  const re = /(?<![0-9+])(?:\+|00)?\d[\d\s().-]{5,20}\d(?![0-9])/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0];
    if (/^\d{4}[-.]\d{1,2}[-.]\d{1,2}$/.test(raw)) continue; // 2024-01-15
    if (/^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$/.test(raw)) continue; // 01/15/2024
    const digits = digitsOf(raw);
    if (digits.length < 7 || digits.length > 15) continue;
    const hasPlus = raw.trim().startsWith('+') || raw.trim().startsWith('00');
    const hasSep = /[\s().-]/.test(raw.trim());
    const cnMobile = /^1[3-9]\d{9}$/.test(digits);
    const cnLandline = /^0\d{9,11}$/.test(digits);
    const us = /^[2-9]\d{9}$/.test(digits) && hasSep;
    const plausible = hasPlus || cnMobile || cnLandline || us || (hasSep && digits.length >= 9);
    if (!plausible) continue;
    // 纯数字且不以 0/1 开头的长串更像账号/订单号，不按电话处理
    if (!hasPlus && !hasSep && !cnMobile && !cnLandline) continue;
    // "(415) 555-2671" 的候选从数字开始：把左括号一起纳入，避免脱敏后留下半个括号
    let start = m.index;
    if (text[start - 1] === '(') start -= 1;
    const end = m.index + raw.length;
    out.push({ start, end, type: TYPES.PHONE, value: text.slice(start, end), score: 0.80 });
  }
  return out;
}

function findUserNames(text) {
  const out = [];
  const push = (m, group, score) => {
    const value = m[group];
    const offset = m[0].indexOf(value);
    out.push({ start: m.index + offset, end: m.index + offset + value.length, type: TYPES.USER_NAME, value, score });
  };

  // 中英文标签后的中文姓名
  const labeled = /(?:姓\s*名|名\s*字|联系人|收件人|开户名|真实姓名|用户名称|用户名|Name)\s*[:：]\s*([\u4e00-\u9fa5·]{2,6})/g;
  let m;
  while ((m = labeled.exec(text))) {
    if (!SURNAME_SET.has(m[1][0])) continue;
    push(m, 1, 0.75);
  }

  // 自我介绍：我叫 / 我是 / 本人
  const selfIntro = /(?:我叫|我是|本人)\s*([\u4e00-\u9fa5·]{2,4})/g;
  while ((m = selfIntro.exec(text))) {
    if (!SURNAME_SET.has(m[1][0])) continue;
    push(m, 1, 0.70);
  }

  // 英文标签后的英文姓名（FirstName LastName）
  const enName = /(?:^|[\n。；;,])\s*Name\s*:\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})/g;
  while ((m = enName.exec(text))) {
    push(m, 1, 0.70);
  }

  return out;
}

const RECOGNIZERS = [
  ['email', findEmails],
  ['idCard', findIdCards],
  ['bankCard', findBankCards],
  ['bankCard', findBankAccounts],
  ['phone', findPhones],
  ['userName', findUserNames]
];

// 姓名识别更激进（标签 + 姓氏），默认不开启；其余强格式识别默认开启。
const ON_BY_DEFAULT = { email: true, phone: true, idCard: true, bankCard: true, userName: false };

function isOn(key, options) {
  const value = options[key];
  if (value === undefined) return ON_BY_DEFAULT[key] !== false;
  return value === true;
}

export function detect(text, options = {}) {
  if (!text) return [];
  let spans = [];
  RECOGNIZERS.forEach(([key, fn]) => {
    if (!isOn(key, options)) return;
    spans = spans.concat(fn(text));
  });
  return pickSpans(spans);
}

// 重叠时：分数高 → 更长 → 更靠前；与上游 dedupOverlappingSpans 一致
function pickSpans(spans) {
  if (!spans.length) return [];
  const sorted = spans.slice().sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    const la = a.end - a.start;
    const lb = b.end - b.start;
    if (la !== lb) return lb - la;
    return a.start - b.start;
  });
  const chosen = [];
  sorted.forEach((s) => {
    const clash = chosen.some((c) => !(s.end <= c.start || c.end <= s.start));
    if (!clash) chosen.push(s);
  });
  chosen.sort((a, b) => a.start - b.start);
  return chosen;
}

// ---------------- 脱敏 ----------------

export function maskText(text, options, session) {
  const source = String(text == null ? '' : text);
  if (source.indexOf(PLACEHOLDER_PREFIX) >= 0) {
    return { ok: false, reason: 'placeholder_collision' };
  }
  const spans = detect(source, options);
  if (!spans.length) {
    return { ok: true, masked: source, tokens: [] };
  }
  const ctx = session || createSession();
  let out = '';
  let pos = 0;
  const tokens = [];
  spans.forEach((span) => {
    if (span.start < pos) return;
    out += source.slice(pos, span.start);
    const key = span.type + '\u0000' + span.value;
    let token = ctx.byValue.get(key);
    if (!token) {
      token = PLACEHOLDER_PREFIX + span.type + '_' + (++ctx.serial) + '__';
      ctx.byValue.set(key, token);
      ctx.values.set(token, span.value);
    }
    out += token;
    if (tokens.indexOf(token) < 0) tokens.push(token);
    pos = span.end;
  });
  out += source.slice(pos);
  return { ok: true, masked: out, tokens };
}

export function createSession() {
  return { serial: 0, byValue: new Map(), values: new Map() };
}

// 批量：返回与入参同序的 [{ ok, masked, tokens } | { ok:false, reason }] 与映射表。
// 映射表只应存在于本次请求的作用域里。
export function maskTexts(texts, options, session) {
  const ctx = session || createSession();
  const rows = (Array.isArray(texts) ? texts : []).map((text) => maskText(text, options, ctx));
  return { rows, values: ctx.values };
}

// ---------------- 恢复 ----------------

// 占位符被模型改写时尽量还原：大小写、内部空格、全角下划线、下划线数量
// 都在 probe（把全角下划线换成半角、长度不变）上匹配，替换时按原偏移切片，
// 因此 token 之外的字符一个都不会被改动。
const TOKEN_RE = /_{1,4}\s*PII\s*_{1,4}\s*([A-Za-z][A-Za-z_]*?)\s*_{1,4}\s*(\d{1,9})\s*_{1,4}/gi;

function probeOf(text) {
  return text.replace(/\uFF3F/g, '_');
}

export function restoreText(maskedText, tokens, values) {
  const text = String(maskedText == null ? '' : maskedText);
  const required = Array.isArray(tokens) ? tokens : [];
  const map = values instanceof Map ? values : new Map();
  if (!text) return { ok: true, text: '' };
  const probe = probeOf(text);
  if (probe.toUpperCase().indexOf('PII') < 0) {
    // 没有 token，也没有占位符痕迹：只有在本来就不需要恢复时才算成功
    return required.length ? { ok: false, reason: 'missing_placeholder' } : { ok: true, text };
  }

  const used = new Set();
  let out = '';
  let last = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(probe))) {
    const start = m.index;
    const end = start + m[0].length;
    const kind = m[1].toUpperCase();
    const serial = Number(m[2]);
    const token = PLACEHOLDER_PREFIX + kind + '_' + serial + '__';
    if (!map.has(token)) {
      return { ok: false, reason: 'unknown_placeholder' };
    }
    out += text.slice(last, start) + map.get(token);
    last = end;
    used.add(token);
  }
  out += text.slice(last);

  const missing = required.filter((token) => !used.has(token));
  if (missing.length) return { ok: false, reason: 'missing_placeholder', missing };
  return { ok: true, text: out };
}

export function restoreTexts(rows, outputs, values) {
  return rows.map((row, index) => {
    if (!row.ok) return { ok: false, reason: row.reason };
    const value = outputs[index];
    if (typeof value !== 'string') return { ok: false, reason: 'no_output' };
    return restoreText(value, row.tokens, values);
  });
}

// 给 background.js 用：把配置里的开关翻译成识别器选项
export function optionsFromConfig(cfg) {
  const c = cfg || {};
  return {
    email: c.privacyMaskEmail !== false,
    phone: c.privacyMaskPhone !== false,
    idCard: c.privacyMaskIdCard !== false,
    bankCard: c.privacyMaskBankCard !== false,
    userName: c.privacyMaskUserName === true
  };
}
