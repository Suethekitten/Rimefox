// Service worker：翻译中枢。所有请求只发生在后台，content script 不直接碰 API Key。
import { getConfig, saveConfig, activeConfig, styleById, providerChoices, resolveInputTarget, languageInfoFor, languageOptions, customLanguageFingerprint, normalizeTargetLang, styleFingerprint, normalizeIntensity } from './lib/config.js';
import { systemPrompt, temperatureFor, promptFingerprint, hasKeepMarks } from './lib/prompt.js';
import { looksUntranslatedForTarget } from './lib/lang-guard.js';
import { chat, ApiError } from './lib/provider.js';
import { parseArray, parseAlignedArray, parseArrayFromReasoning, isRunaway, normalizeTranslationBreaks, leaksWrapper } from './lib/parse.js';
import {
  matchGlossary,
  normalizeGlossary,
  createHitFingerprint,
  upsertGlossaryEntry,
  GLOSSARY_MAX
} from './lib/glossary.js';
import { createProfessionalEngine } from './lib/professional/engine.js';
import { reviewHighRisk } from './lib/professional/review.js';
import { aiContextPrompt, aiContextForTexts, aiContextFingerprintData, aiContextStats } from './lib/ai-context.js';
import * as cache from './lib/cache.js';
import { accentHex, isDefaultAccent, sanitizeTranslationCss, typographyVars } from './lib/appearance.js';
import { resolveSiteRule, hostListed } from './lib/site-rules.js';
import { providerById } from './lib/providers.js';
import { maskTexts, restoreText, optionsFromConfig } from './lib/privacy.js';
import { openWelcomePage, shouldOpenWelcome } from './lib/welcome.js';
import { createUsageStats } from './lib/usage.js';
import { INLINE_VERSION, inspectInline } from './lib/inline.js';

// 仅开发调试用的用量统计：只记数字，不记正文 / Key / Prompt / 原始响应
const usageStats = createUsageStats();

// 在途的翻译：缓存键 → Promise<{ value: 译文 | ''（无需翻译）| null（失败）, error }>，见 handleTranslate
const inflight = new Map();
// 句子对齐的旁路缓存（0.9.1）：键与翻译缓存相同，值 = 模型返回的 parts [{n,t}]。
// 不写进三层缓存、不改 makeKey / SCHEMA：旧缓存命中没有对齐就降级为行 / 段落级；
// service worker 重启后旁路表丢失，也只是悬停降级，不会让页面重翻。
const alignCache = new Map();
const ALIGN_CACHE_MAX = 4000;
function rememberAlign(key, parts) {
  if (!parts || !parts.length) return;
  if (alignCache.has(key)) alignCache.delete(key);
  alignCache.set(key, parts);
  while (alignCache.size > ALIGN_CACHE_MAX) alignCache.delete(alignCache.keys().next().value);
}

// ---------------- 并发闸门 ----------------
let running = 0;
let maxParallel = 3;
const pending = [];

function acquire() {
  return new Promise((resolve) => {
    if (running < maxParallel) {
      running += 1;
      resolve();
    } else {
      pending.push(resolve);
    }
  });
}

function release() {
  const next = pending.shift();
  if (next) next(); // 名额直接转交
  else running = Math.max(0, running - 1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Match terms and professional context against the actual translatable wording,
// not marker bytes. Opaque k atoms stay empty: no local protected value is read.
function inlineVisible(text) {
  const checked = inspectInline(text, text);
  return checked.ok ? checked.text : '';
}

// 语言判断只看可翻译正文，不把 <kN> 里的链接标签 / 引用 / notranslate 当成译文。
function inlineStripped(text) {
  const checked = inspectInline(text, text);
  return checked.ok ? checked.stripped : '';
}

// 明显是一段正文（而不是按钮 / 标签 / 缩写）才把空回包、超长回包算模型失败。
// 长度和句末标点都要有：短文本可能本来就不需要翻译，不能因此报错。
function isSubstantialSource(text) {
  const value = String(text == null ? '' : text);
  const letters = (value.match(/\p{L}/gu) || []).length;
  if (letters < 40) return false;
  if (/[。！？.!?؟]/.test(value)) return true;
  return value.trim().split(/\s+/).length >= 8;
}

// style：趣味翻译风格（lib/config.js 的 STYLES），普通翻译为 'plain'
// policy：{ languageInfo, intensity, aiContext }，只影响提示词与缓存身份，不额外发起请求。
// inlineProtocol：A 的 <fN> 行内语义协议；与 B 的 languageInfo / intensity / aiContext 同时生效。
async function translateBatchWithRetry(texts, target, cfg, style, glossary, privacyMasked, align, professional, inlineProtocol, policy) {
  let attempt = 0;
  let lastErr = null;
  const temperature = temperatureFor(cfg, style);
  let mismatch = false;
  // 本批命中的用户术语（没命中就是空数组，提示词里不会多出术语段）
  const hits = matchGlossary(glossary, inlineProtocol ? texts.map(inlineVisible) : texts);
  const professionalPrompt = professional.prompt(texts, hits);
  const promptOptions = {
    languageInfo: policy && policy.languageInfo,
    intensity: policy && policy.intensity,
    inlineMarked: !!inlineProtocol,
    // 医学 / 专业 profile 自己会带上下文（含相邻段落）；不要让同一次请求出现两份上下文块。
    contextInstructions: policy && policy.aiContext && !professional.enabled
      ? aiContextPrompt(policy.aiContext, texts, { prepared: true })
      : ''
  };
  // 段落里有网页标明不翻译的内容（<kN> 保留标记）：提示词加一段「原样照抄」
  const keepMarked = hasKeepMarks(texts);
  while (attempt < 3 && !mismatch) {
    attempt += 1;
    if (attempt > 1) usageStats.retry();
    const meta = {};
    try {
      const active = activeConfig(cfg);
      const raw = await chat({
        meta,
        engine: active.engine,
        baseUrl: active.baseUrl,
        apiKey: active.apiKey,
        model: active.model,
        temperature,
        thinkingMode: cfg.thinkingMode,
        thinkingExtra: cfg.thinkingExtra,
        maxTokens: Math.min(8000, 512 + texts.join('').length * 2),
        timeoutMs: Number(cfg.timeoutMs) || 60000,
        messages: [
          { role: 'system', content: systemPrompt(target, style, hits, cfg.customPrompt, privacyMasked, align, keepMarked, professionalPrompt, promptOptions) },
          { role: 'user', content: JSON.stringify(texts) }
        ]
      });
      // align：模型被要求返回 {parts:[{n,t}]}；解析失败一律退回普通字符串数组（页面照常显示）
      const parsed = align ? parseAlignedArray(raw, texts.length) : parseArray(raw, texts.length);
      if (parsed) return align ? parsed : { texts: parsed, aligns: parsed.map(() => null) };
      usageStats.discard();
      // 错误信息带上 finish_reason 和长度：一眼看出是被截断（length）还是格式不对，不只截一段原始返回
      lastErr = new ApiError(
        '模型没有按 JSON 数组返回（finish_reason=' + (meta.finishReason || '未知') + '，content ' + String(raw).length + ' 字）',
        0,
        String(raw).slice(0, 120)
      );
      // 多条时条数对不上（模型合并/拆分了段落）：整批原样重试多半还是对不上，
      // 每次又要等完整生成。跳出重试，下面对半拆开
      mismatch = texts.length > 1;
    } catch (err) {
      // content 为空、但思考过程里有答案（推理模型偶尔把最终数组写进 reasoning_content）：从里面捞
      if (err && err.code === 'empty_content') {
        const salvaged = parseArrayFromReasoning(err.reasoningText, texts);
        if (salvaged) return { texts: salvaged, aligns: salvaged.map(() => null) };
      }
      lastErr = err;
      const status = err && err.status ? err.status : 0;
      const retriable = status === 0 || status === 429 || status >= 500;
      if (!retriable) {
        usageStats.failure();
        throw err;
      }
    } finally {
      // HTTP 次数包含 thinking 二次请求；usage 包含“成功但内容为空 / 解析失败”的响应
      if (meta.http) usageStats.request(meta.http);
      (meta.usages || []).forEach(function (usage) {
        usageStats.response(usage);
      });
      (meta.finishReasons || []).forEach(function (reason) {
        usageStats.finish(reason);
      });
    }
    if (attempt < 3 && !mismatch) await sleep(700 * attempt);
  }
  if (mismatch) {
    usageStats.split();
    // 两半依次翻（各自带重试），拆到单条为止。放在重试循环外面：
    // 一半失败时保留另一半已经拿到的结果，不能把整批全丢掉重来；
    // 也避免一次拆批瞬间绕过并发闸门。
    const mid = Math.ceil(texts.length / 2);
    let left = null;
    let right = null;
    let leftErr = null;
    let rightErr = null;
    try {
      left = await translateBatchWithRetry(texts.slice(0, mid), target, cfg, style, glossary, privacyMasked, align, professional, inlineProtocol, policy);
    } catch (err) {
      leftErr = err;
    }
    try {
      right = await translateBatchWithRetry(texts.slice(mid), target, cfg, style, glossary, privacyMasked, align, professional, inlineProtocol, policy);
    } catch (err) {
      rightErr = err;
    }
    if (left && right) return { texts: left.texts.concat(right.texts), aligns: left.aligns.concat(right.aligns) };
    if (!left && !right) throw leftErr || rightErr || new ApiError('翻译失败', 0, '');
    const out = new Array(texts.length).fill(null);
    const outAligns = new Array(texts.length).fill(null);
    if (left) left.texts.forEach((value, i) => { out[i] = value; outAligns[i] = left.aligns[i] || null; });
    if (right) right.texts.forEach((value, i) => { out[mid + i] = value; outAligns[mid + i] = right.aligns[i] || null; });
    return { texts: out, aligns: outAligns };
  }
  usageStats.failure();
  throw lastErr || new ApiError('翻译失败', 0, '');
}

function describeError(err) {
  if (!err) return '未知错误';
  if (err instanceof ApiError) {
    return err.detail ? err.message + '（' + err.detail.replace(/\s+/g, ' ').slice(0, 120) + '）' : err.message;
  }
  return err.message || String(err);
}

// ---------------- 主流程 ----------------
// 缓存键里的域名：取发消息的那个框架（iframe 里的内容按 iframe 自己的站点算）。
// 扩展自己的页面（弹窗随手翻译）得到的是扩展 ID，同样单独一格
function hostOf(sender) {
  const url = (sender && (sender.url || (sender.tab && sender.tab.url))) || '';
  try {
    return new URL(url).hostname;
  } catch (err) {
    return '';
  }
}

async function handleTranslate(msg, sender) {
  await cache.ready;
  const cacheEpoch = cache.epoch ? cache.epoch() : 0;
  const cfg = await getConfig();
  maxParallel = Math.max(1, Math.min(16, Number(cfg.concurrency) || 6));

  // 输入框翻译（0.9.0）：target 传 'auto' = 跟随页面语言（页面把 <html lang> 一起发来，语言表只有这里一份）。
  // noCache：输入框里多半是草稿或私信，翻完不写三层缓存，也不读（免得把别人/上次的草稿带回来）
  const noCache = msg.noCache === true;
  let target = msg.target === 'auto'
    ? resolveInputTarget(msg.target, msg.pageLang, cfg.customLanguages)
    : msg.target || cfg.targetLang;
  // 过期 / 被删除的自定义语言不能把空值或无效代码送进提示词 / 缓存；回退到配置里的有效目标。
  let languageInfo = languageInfoFor(target, cfg.customLanguages);
  if (!languageInfo) {
    target = normalizeTargetLang(cfg.targetLang, cfg.customLanguages);
    languageInfo = languageInfoFor(target, cfg.customLanguages);
  }
  const style = styleById(msg.style).value; // 不认识的风格按普通翻译
  const intensity = style === 'plain'
    ? 'standard'
    : normalizeIntensity(msg.intensity !== undefined ? msg.intensity : cfg.funIntensity);
  // AI 精翻：默认关闭；开启时只把有限上下文并进正常翻译请求，不额外发起复核。
  // 隐私脱敏开启时整段上下文都不发送（标题 / 章节也可能绕过脱敏），并记录降级。
  const aiContextEnabled = cfg.aiContextEnabled === true;
  const aiContextInput = aiContextEnabled && cfg.privacyEnabled !== true ? msg.documentContext : null;
  const contextOmitted = aiContextEnabled && cfg.privacyEnabled === true ? 'privacy' : '';
  const glossary = normalizeGlossary(cfg.glossary);
  const inlineProtocol = msg.inlineProtocol === INLINE_VERSION;
  const professionalBase = createProfessionalEngine(cfg, {
    target, style, documentContext: msg.documentContext,
    excludeSources: new Set(glossary.map(one => one.source))
  });
  // Protocol integrity owns marker/atom checks. Medical number and terminology
  // checks must see visible text, otherwise f IDs look like numbers and translated
  // link labels look like illegally modified protected atoms.
  const professional = inlineProtocol ? {
    ...professionalBase,
    prompt(texts, userHits) {
      return professionalBase.prompt(texts.map(inlineVisible), userHits);
    },
    fingerprint(text) {
      return professionalBase.fingerprint(inlineVisible(text));
    },
    validate(source, translation) {
      const src = inspectInline(source, source);
      const dst = inspectInline(source, translation);
      return professionalBase.validate(src.ok ? src.text : source, dst.ok ? dst.text : translation);
    }
  } : professionalBase;
  const reviewBudget = { remaining: Math.max(0, Math.min(3, Number(professional.options.maxReviewRequests) || 0)) };
  const rawTexts = Array.isArray(msg.texts) ? msg.texts : [];
  const texts = rawTexts.map((t) => (t == null ? '' : String(t)));
  // 先按整批裁好一份上下文：提示词与缓存身份用同一个对象，
  // 避免同一段落在不同批次里出现“同一个键、不同提示词”。
  const aiContextData = aiContextEnabled && aiContextInput ? aiContextForTexts(aiContextInput, texts) : null;
  const policy = { languageInfo, intensity, aiContext: aiContextData };
  const results = new Array(texts.length).fill(null);
  // 结构化句子对齐（可选）：整页翻译才请求；划词 / 输入框 / 字幕不传，行为与 0.9.0 一致
  const wantAlign = msg.align === true && !noCache && !inlineProtocol;
  const alignments = new Array(texts.length).fill(null);
  const validations = new Array(texts.length).fill(null);
  const inlineErrors = new Array(texts.length).fill(null);
  // 模型回包本身不可用（语言错误 / 空正文 / 失控长文），不是 DOM 注入失败。
  // 这些结果不写缓存，不计 skipped，也不自动重试；用户明确重译时才重新请求。
  const outputErrors = new Array(texts.length).fill(null);

  const active = activeConfig(cfg);
  if (!active.apiKey) {
    return { ok: false, error: '还没有配置 API Key，请先打开「设置」填写。', results };
  }

  // 缓存键带上术语 / 自定义提示词指纹：改了之后旧译文不能再命中。
  // 术语只算这段原文命中的那些（没命中是 'none'）：加一条术语只让含这个词的段落重翻，不是全站缓存失效
  const scope = {
    target,
    style,
    model: active.provider + ':' + active.model,
    // 旧条目没有接口身份，不能推断它来自哪个地址；不复用，也不清空其他缓存。
    endpoint: JSON.stringify([active.engine, active.baseUrl.trim().replace(/\/+$/, '')]),
    host: hostOf(sender),
    // 行内协议是独立的 opt-in 身份；普通请求不追加，旧缓存键逐字不变。
    prompt: promptFingerprint(cfg.customPrompt) + (inlineProtocol ? ':inline-' + INLINE_VERSION : ''),
    // 内置语言 / 普通风格不追加这两段：旧普通缓存键逐字不变。
    lang: customLanguageFingerprint(languageInfo),
    styleVersion: styleFingerprint(style, intensity)
  };
  const hitPrint = createHitFingerprint(glossary);
  const keys = new Map();
  const keyOf = (text) => {
    if (!keys.has(text)) {
      // AI 精翻按本批实际发送的上下文算身份：上下文变化会换键；同一段落在不同批次里
      // 可能因为上下文不同而得到不同键，这是为了避免「同一个键、不同提示词」。
      const ai = aiContextEnabled
        ? 'ai-v1:on:' + (aiContextData ? aiContextFingerprintData(aiContextData) : 'none')
        : '';
      // Profile hooks own terminology, context and quality identity. General preserves old keys.
      keys.set(text, cache.makeKey({ ...scope, ai, glossary: hitPrint(inlineProtocol ? inlineVisible(text) : text), professional: professional.fingerprint(text) }, text));
    }
    return keys.get(text);
  };

  // 同一批里重复的文本（页面上一排相同的按钮、"Reply"、"Share"）只翻一次、只付一次钱：
  // groups 记 原文 → 它出现的所有位置，只把 groups 的键送去翻，回来按位置回填
  const groups = new Map();
  let cached = 0;
  let firstError = null;
  texts.forEach((text, index) => {
    if (!text.trim()) {
      results[index] = '';
      return;
    }
    if (inlineProtocol) {
      const source = inspectInline(text, text);
      if (!source.ok) {
        inlineErrors[index] = source.reason;
        if (!firstError) firstError = new ApiError('行内格式输入不完整，已保留原文', 0, source.reason);
        return;
      }
    }
    if (groups.has(text)) {
      groups.get(text).push(index);
      return;
    }
    let hit = noCache ? undefined : cache.get(keyOf(text));
    let hitAlign = alignCache.get(keyOf(text)) || null;
    if (inlineProtocol && typeof hit === 'string') {
      const checked = inspectInline(text, hit);
      if (!checked.ok || checked.formatMissing) {
        cache.remove(keyOf(text));
        alignCache.delete(keyOf(text));
        hit = undefined;
        hitAlign = null;
      }
    }
    // 旧版本存进去的译文可能带着多转义的字面 \n（Pixiv 中译英）：读出来同样规范化，改了就顺手写回；
    // 残留 JSON 包装的旧译文当作没命中，重新翻（不整体清缓存）
    if (typeof hit === 'string') {
      const fixed = normalizeTranslationBreaks(text, hit);
      const cacheSource = inlineProtocol ? inlineStripped(text) : text;
      const cacheOutput = inlineProtocol
        ? (() => { const checked = inspectInline(text, fixed); return checked.ok ? checked.stripped : fixed; })()
        : fixed;
      if (leaksWrapper(text, fixed)) {
        cache.remove(keyOf(text));
        alignCache.delete(keyOf(text));
        hit = undefined;
        hitAlign = null;
      } else if ((!fixed.trim() && isSubstantialSource(cacheSource)) || (isSubstantialSource(cacheSource) && isRunaway(cacheSource, fixed))) {
        // 旧版本 / 旧在途请求可能把空回包或失控长文写进缓存；读取时同样失效，
        // 否则用户点「重新翻译」仍会拿到同一条坏译文。
        cache.remove(keyOf(text));
        alignCache.delete(keyOf(text));
        hit = undefined;
        hitAlign = null;
      } else if (looksUntranslatedForTarget(cacheSource, cacheOutput, languageInfo.code || target)) {
        // 目标语言是英文（或其它拉丁字母语系），缓存里却是整段中文：0.9.5 之前 align 提示词
        // 的中文示例把模型带偏后留下的坏结果。只失效这一条，不清整层、不动其它正常缓存，
        // 下次照常请求；对齐旁路一起丢掉，避免继续拿错译文做句级对应。
        cache.remove(keyOf(text));
        alignCache.delete(keyOf(text));
        hit = undefined;
        hitAlign = null;
        usageStats.languageMismatch();
      } else if (fixed !== hit) {
        // 换行被改写后译文偏移变了，旧对齐不能再用（下次悬停降级）
        if (cache.epoch() === cacheEpoch) cache.set(keyOf(text), fixed);
        alignCache.delete(keyOf(text));
        hit = fixed;
        hitAlign = null;
      }
    }
    if (hit !== undefined) {
      results[index] = hit;
      alignments[index] = inlineProtocol ? null : hitAlign;
      // String cache compatibility: deterministic reports can always be recomputed locally.
      validations[index] = professional.validate(text, hit);
      cached += 1;
      usageStats.cacheHit();
    } else {
      groups.set(text, [index]);
    }
  });
  usageStats.cacheMiss(groups.size);
  let todo = Array.from(groups.keys());

  // 这一条的结果定下来了：回填到它出现的所有位置；失败（null）时记下第一个原因
  function fill(text, value, err, parts, validation, inlineError, outputError) {
    groups.get(text).forEach((index) => {
      results[index] = value;
      alignments[index] = parts || null;
      validations[index] = validation || (typeof value === 'string' && value ? professional.validate(text, value) : null);
      inlineErrors[index] = inlineError || null;
      outputErrors[index] = outputError || null;
    });
    if (value === null && !firstError) firstError = err || new ApiError('翻译失败', 0, '');
  }

  // 同一原文已经有请求在翻（内容脚本等了 190s 超时后重发、几个框架同时翻同一段）：
  // 不再发一次请求，等那边的结果。单条消息在后台没有总时限（排队 + 最多 3 次重试 + 拆批），
  // 以前重发的那次缓存没命中，同一段文字要付两次钱
  const waits = [];
  todo = todo.filter((text) => {
    const running = inflight.get(keyOf(text));
    if (!running) return true;
    waits.push(
      running.then((done) => {
        fill(text, done.value, done.error, done.parts, done.validation, done.inlineError, done.outputError);
      })
    );
    return false;
  });

  // 可选：本地脱敏。映射只活在这个请求里，不落盘、不进缓存、不写日志。
  // 关闭时下面的分支整段跳过，行为与改动前完全一致。
  let privacyRows = null;
  let privacyValues = null;
  if (cfg.privacyEnabled === true && todo.length) {
    const masked = maskTexts(todo, optionsFromConfig(cfg));
    privacyRows = new Map();
    privacyValues = masked.values;
    const usable = [];
    masked.rows.forEach((row, i) => {
      const original = todo[i];
      if (!row.ok) {
        // 脱敏失败（例如原文本身就带占位符）：这一段判失败，绝不把原文发出去
        fill(original, null, new ApiError('本地隐私保护无法为这段文字生成占位符，已跳过', 0, row.reason || ''));
        return;
      }
      privacyRows.set(original, { masked: row.masked, tokens: row.tokens });
      usable.push(original);
    });
    todo = usable;
  }

  // 要真正发出去的这些登记成「在途」，结果定下来（成功、空、失败）就交给等着它的请求
  const settles = new Map();
  todo.forEach((text) => {
    const key = keyOf(text);
    let resolve;
    const running = new Promise((r) => {
      resolve = r;
    });
    inflight.set(key, running);
    settles.set(text, (value, error, parts, validation, inlineError, outputError) => {
      if (inflight.get(key) === running) inflight.delete(key);
      resolve({ value, error, parts, validation, inlineError, outputError });
    });
  });
  function settle(text, value, err, parts, validation, inlineError, outputError) {
    fill(text, value, err, parts, validation, inlineError, outputError);
    const done = settles.get(text);
    if (done) {
      settles.delete(text);
      done(value, value === null ? err || firstError : null, parts || null, validation, inlineError, outputError);
    }
  }

  // 按条数 + 字符数切批，避免单次请求过大
  const maxItems = Math.max(1, Number(cfg.batchSize) || 12);
  const maxChars = Math.max(200, Number(cfg.maxCharsPerBatch) || 3000);
  const batches = [];
  let current = [];
  let chars = 0;
  todo.forEach((text) => {
    const len = privacyRows ? privacyRows.get(text).masked.length : text.length;
    if (current.length > 0 && (current.length >= maxItems || chars + len > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += len;
  });
  if (current.length > 0) batches.push(current);

  async function requestReview(source, translation, report) {
    let reviewSource = source;
    let reviewCandidate = translation;
    let masked = null;
    if (cfg.privacyEnabled === true) {
      masked = maskTexts([source, translation], optionsFromConfig(cfg));
      if (masked.rows.some(row => !row.ok)) throw new Error('review-privacy-mask-failed');
      reviewSource = masked.rows[0].masked;
      reviewCandidate = masked.rows[1].masked;
    }
    const hits = matchGlossary(glossary, [inlineProtocol ? inlineVisible(reviewSource) : reviewSource]);
    // 复核只带语言 / 风格身份，不重复注入 AI 精翻上下文：保持原有复核预算与输入范围。
    // 行内协议仍要保留，否则复核提示词缺少 <fN> 规则，结构化译文会被判损坏。
    const reviewOptions = { languageInfo, intensity, contextInstructions: '', inlineMarked: !!inlineProtocol };
    const meta = {};
    try {
      const raw = await chat({
        ...active, temperature: 0, timeoutMs: Number(cfg.timeoutMs) || 60000,
        thinkingMode: cfg.thinkingMode, thinkingExtra: cfg.thinkingExtra, maxHttpAttempts: 1,
        maxTokens: Math.min(8000, 512 + reviewSource.length * 2), meta,
        messages: [
          { role: 'system', content: systemPrompt(target, style, hits, cfg.customPrompt, !!masked, false, hasKeepMarks([reviewSource]), professional.prompt([reviewSource], hits), reviewOptions) +
            '\n【定向质量复核】本轮输入是对象数组，每项含 source（原文）、translation（待复核译文）、risks（本地可疑项代码）。只返回与输入同序的 JSON 字符串数组。逐项对照原文核查数字、单位、引用标记、否定、条件、因果与结论强弱，仅在原文支持时纠正译文；疑点不等于事实，不得添加医学建议。保留所有隐私占位符和引用标记。本次模型复核不是专家审核。' },
          { role: 'user', content: JSON.stringify([{ source: reviewSource, translation: reviewCandidate, risks: report.issues.map(issue => issue.code) }]) }
        ]
      });
      const parsed = parseArray(raw, 1);
      if (!parsed || typeof parsed[0] !== 'string') throw new Error('invalid-review-array');
      let value = parsed[0];
      if (masked) {
        const tokens = [...new Set(masked.rows.flatMap(row => row.tokens))];
        const restored = restoreText(value, tokens, masked.values);
        if (!restored.ok) throw new Error('review-privacy-restore-failed');
        value = restored.text;
      }
      return normalizeTranslationBreaks(source, value);
    } finally {
      if (meta.http) usageStats.request(meta.http);
      (meta.usages || []).forEach(usage => usageStats.response(usage));
      (meta.finishReasons || []).forEach(reason => usageStats.finish(reason));
    }
  }

  const runs = batches.map((payload) =>
    (async () => {
      await acquire();
      try {
        // 发出去的是脱敏后的文本；映射只在本地
        const wire = privacyRows ? payload.map((text) => privacyRows.get(text).masked) : payload;
        const out = await translateBatchWithRetry(wire, target, cfg, style, glossary, !!privacyRows, wantAlign, professional, inlineProtocol, policy);
        if (!out || !out.texts) throw new ApiError('模型返回无法解析', 0, '');
        for (let k = 0; k < payload.length; k += 1) {
          const text = payload[k];
          let value = out.texts[k];
          let parts = (out.aligns && out.aligns[k]) || null;
          if (value === null) {
            // 拆批时一半失败：这一条按失败处理，另一半已经成功的照常写缓存
            settle(text, null, new ApiError('其中一部分译文失败，稍后重试', 0, ''));
            continue;
          }
          if (privacyRows) {
            const back = restoreText(String(value == null ? '' : value), privacyRows.get(text).tokens, privacyValues);
            if (!back.ok) {
              // 占位符丢失 / 被改写 / 对不上：这一段判失败，不输出半截译文，也不缓存
              settle(text, null, new ApiError('本地隐私保护无法还原这段译文，已跳过', 0, back.reason || ''));
              continue;
            }
            value = back.text;
            parts = null; // 脱敏还原会改变字符偏移，旧对齐不再可靠
          }
          // 多转义的字面 \n 在写缓存之前就规范化（对照原文的分行，代码 / 路径原样保留）
          const beforeBreaks = value;
          value = normalizeTranslationBreaks(text, value);
          if (value !== beforeBreaks) parts = null;
          const targetCode = languageInfo.code || target;
          const sourceVisible = inlineProtocol ? inlineStripped(text) : text;
          const sourceSubstantial = isSubstantialSource(sourceVisible);
          // 空正文 / 失控长文先于行内解析：空回包没有 <fN>，如果先跑 inspectInline
          // 会被误判成 invalid-inline，用户看到的是结构错误而不是模型空回包。
          if (typeof value === 'string' && !value.trim() && sourceSubstantial) {
            settle(text, null, new ApiError('模型返回空译文，已保留原文', 0, 'empty-output'), null, null, null, 'empty-output');
            continue;
          }
          if (typeof value === 'string' && sourceSubstantial && isRunaway(sourceVisible, value)) {
            settle(text, null, new ApiError('模型返回内容异常偏长，已保留原文', 0, 'runaway-output'), null, null, null, 'runaway-output');
            continue;
          }
          let inlineState = inlineProtocol ? inspectInline(text, value) : null;
          if (inlineState && !inlineState.ok) {
            settle(text, null, new ApiError('模型返回的行内格式不完整，已保留原文', 0, inlineState.reason), null, null, inlineState.reason);
            continue;
          }
          // 写入前兜底：残留 JSON 包装 / 字段名 / 提示词原句 → 这一条按失败处理，不插进网页、不进缓存
          if (typeof value === 'string' && leaksWrapper(text, value)) {
            settle(text, null, new ApiError('模型返回的译文里混进了 JSON 格式，已丢弃', 0, ''));
            continue;
          }
          const outputVisible = inlineProtocol && inlineState ? inlineState.stripped : String(value == null ? '' : value);
          // 语言守卫必须在写缓存和交给页面之前执行。旧实现只阻止坏结果进缓存，
          // 仍会把整段英文 / 阿拉伯语当作译文注入，页面看起来就是“漏翻但成功”。
          if (typeof value === 'string' && looksUntranslatedForTarget(sourceVisible, outputVisible, targetCode)) {
            usageStats.languageMismatch();
            settle(text, null, new ApiError('模型返回的目标语言不符，已保留原文', 0, 'wrong-language'), null, null, null, 'wrong-language');
            continue;
          }
          let result = '';
          let validation = null;
          if (typeof value === 'string' && value.trim() && !isRunaway(sourceVisible, value)) {
            validation = professional.validate(text, value);
            const reviewed = await reviewHighRisk({
              engine: professional, source: text, translation: value, report: validation, budget: reviewBudget,
              review: requestReview,
              accept: candidate => {
                if (inlineProtocol) {
                  const checked = inspectInline(text, candidate);
                  if (!checked.ok || checked.formatMissing) return false;
                }
                const candidateVisible = inlineProtocol ? (inspectInline(text, candidate).stripped || candidate) : candidate;
                return !leaksWrapper(text, candidate) && !isRunaway(text, candidate) && !looksUntranslatedForTarget(sourceVisible, candidateVisible, targetCode);
              }
            });
            value = reviewed.translation;
            validation = reviewed.report;
            if (reviewed.changed) parts = null; // A new translation invalidates the old model offsets.
            if (inlineProtocol) inlineState = inspectInline(text, value);
            const finalVisible = inlineProtocol && inlineState ? inlineState.stripped : value;
            // 复核模型也可能把语言改回原文；同样在写页面 / 缓存前拒绝。
            if (looksUntranslatedForTarget(sourceVisible, finalVisible, targetCode)) {
              usageStats.languageMismatch();
              settle(text, null, new ApiError('模型返回的目标语言不符，已保留原文', 0, 'wrong-language'), null, null, null, 'wrong-language');
              continue;
            }
            result = value;
            // inline 格式缺失（全部 <fN> 被安全省略）时显示译文但不写缓存；
            // 部分格式缺失会更早按 invalid-inline 失败，绝不会到这里。
            if (!noCache && cache.epoch() === cacheEpoch && !(inlineState && inlineState.formatMissing)) {
              cache.set(keyOf(text), value);
              if (wantAlign) rememberAlign(keyOf(text), parts);
            }
          } else {
            parts = null;
          }
          // 否则：模型返回空（"EN"/"×" 这类不需要翻的），或译文长得离谱（见 isRunaway）：给 ''，
          // 和失败的 null 区分开，内容脚本据此记为"与原文相同"而不是失败。不进缓存，免得一次抽风永久生效。
          settle(text, result, null, parts, validation);
        }
      } catch (err) {
        if (!firstError) firstError = err;
      } finally {
        release();
        // 这一批没定下来的（整批失败）也要通知等着的请求，不能让它们一直挂着
        payload.forEach((text) => {
          if (settles.has(text)) settle(text, null);
        });
      }
    })()
  );

  await Promise.all(runs.concat(waits));

  const failed = results.filter((r) => r === null).length;
  // 只报告上下文模式 / 字符数 / 条数，绝不回传上下文正文、页面标题或正文。
  const contextReport = contextOmitted
    ? { mode: 'ai', omitted: contextOmitted, chars: 0, items: { title: 0, headings: 0, abbreviations: 0, adjacent: 0 } }
    : aiContextEnabled
      ? (aiContextData && Object.keys(aiContextData).length
        ? aiContextStats(aiContextData, texts, { prepared: true })
        : { mode: 'ai', omitted: 'no-context', chars: 0, items: { title: 0, headings: 0, abbreviations: 0, adjacent: 0 } })
      : { mode: 'off', omitted: '', chars: 0, items: { title: 0, headings: 0, abbreviations: 0, adjacent: 0 } };
  if (results.length && failed === results.length) {
    return { ok: false, error: describeError(firstError), results, alignments, validations, inlineErrors, outputErrors, context: contextReport };
  }

  return {
    ok: true,
    results,
    alignments,
    validations,
    inlineErrors,
    outputErrors,
    failed,
    cached,
    context: contextReport,
    error: firstError ? describeError(firstError) : ''
  };
}

async function handleTest() {
  const cfg = await getConfig();
  const active = activeConfig(cfg);
  if (!active.apiKey) return { ok: false, error: '还没有填写 API Key' };
  const started = Date.now();
  const meta = {};
  try {
    const raw = await chat({
      engine: active.engine,
      baseUrl: active.baseUrl,
      apiKey: active.apiKey,
      model: active.model,
      temperature: 0,
      maxTokens: 256,
      timeoutMs: Math.min(30000, Number(cfg.timeoutMs) || 30000),
      thinkingMode: cfg.thinkingMode,
      thinkingExtra: cfg.thinkingExtra,
      meta,
      messages: [
        { role: 'system', content: '你是一个翻译引擎。只输出 JSON 字符串数组，不要任何解释。' },
        { role: 'user', content: JSON.stringify(['Hello, world.', 'This is a connection test.']) }
      ]
    });
    const parsed = parseArray(raw, 2);
    return {
      ok: true,
      ms: Date.now() - started,
      engine: active.engine,
      model: active.model,
      reasoning: !!meta.reasoning,
      sample: parsed ? parsed.join(' / ') : String(raw).slice(0, 120)
    };
  } catch (err) {
    return { ok: false, error: describeError(err), ms: Date.now() - started };
  }
}

// ---------------- 保命注入 ----------------
// 页面在安装扩展之前就打开、或注入失败时，主动补注入一次再重试
async function ensureInjected(tabId, frameId = 0) {
  if (!tabId) return false;
  // Declarative exclusions do not cover scripting. Pin the checked document
  // so navigation cannot change the destination between checking and injection.
  let target;
  try {
    const [frame] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => {
        const u = new URL(location.href);
        return /^(https?:|file:)$/.test(u.protocol) &&
          u.hostname !== 'accounts.google.com' &&
          u.hostname !== 'chromewebstore.google.com' &&
          !(u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore/'));
      }
    });
    if (!frame?.result || !frame.documentId) return false;
    target = { tabId, documentIds: [frame.documentId] };
  } catch { return false; }
  try {
    await chrome.scripting.insertCSS({
      target,
      files: ['content/styles/inject.css']
    });
  } catch (err) {
    /* 样式重复插入会报错，忽略 */
  }
  try {
    await chrome.scripting.executeScript({
      target,
      // 顺序必须和 manifest.json 的 content_scripts 一致：units.js 是 dom.js 的依赖，
      // input.js 提供输入框翻译。漏掉它们时内容脚本仍能跑，但 hover / 输入框会报 undefined。
      files: [
        'content/core.js',
        'lib/inline-protocol.js',
        'content/units.js',
        'content/direction.js',
        'content/dom.js',
        'content/shadow.js',
        'content/adapters/bilibili-comments.js',
        'content/appearance.js',
        'content/main.js',
        'content/selection.js',
        'content/input.js',
        'content/hover.js',
        'content/pip.js',
        'content/dock.js'
      ]
    });
    return true;
  } catch (err) {
    return false;
  }
}

// frameId 默认 0（主框架）：iframe 里也有内容脚本，广播式发消息会被 iframe 抢先应答
async function sendOrInject(tabId, msg, frameId) {
  const options = { frameId: frameId == null ? 0 : frameId };
  try {
    return await chrome.tabs.sendMessage(tabId, msg, options);
  } catch (err) {
    const ok = await ensureInjected(tabId, options.frameId);
    if (!ok) throw err;
    return chrome.tabs.sendMessage(tabId, msg, options);
  }
}

// 这个页面要用的外观：按发消息的页面网址算好再给内容脚本（站点规则、夜间名单、强调色、清洗过的自定义 CSS），
// 逻辑都在可测的 lib/ 里，内容脚本只管照着写到 <html> 上
function pageAppearance(cfg, sender) {
  const url = (sender && (sender.url || (sender.tab && sender.tab.url))) || '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch (err) {
    host = '';
  }
  return {
    accent: isDefaultAccent(cfg.accentColor) ? '' : accentHex(cfg.accentColor),
    customCss: sanitizeTranslationCss(cfg.customCss).css,
    typo: typographyVars(cfg),
    site: url ? resolveSiteRule(url, cfg.siteRules) : null,
    night: !!cfg.nightMode && hostListed(host, cfg.nightSites),
    provider: providerLabel(cfg)
  };
}

// 悬浮入口上显示「在用谁」：服务商名 + 模型（和弹窗状态卡底部一致）
function providerLabel(cfg) {
  const id = cfg.currentProvider || 'deepseek';
  const custom = (cfg.customProviders || []).find((one) => one.id === id);
  const tpl = providerById(id);
  const name = (custom && custom.name) || (tpl && tpl.name) || id;
  const model = ((cfg.providerConfig || {})[id] || {}).model || '';
  return model ? name + ' · ' + model : name;
}

// ---------------- 消息路由 ----------------
const ROUTES = {
  translate: handleTranslate,
  test: handleTest,
  ensure: async (msg) => {
    const ok = await ensureInjected(msg.tabId);
    return { ok: ok };
  },
  // 只给内容脚本用：去掉 API Key，换成 hasKey。
  // 内容脚本跑在网页的渲染进程里，渲染进程一旦被攻破，它手里的东西都可能被读走。
  'config:get': async (msg, sender) => {
    const cfg = await getConfig();
    // 嵌套的 providerConfig 里也有 Key：逐个剥掉，只留协议、地址和模型
    const providerConfig = {};
    Object.keys(cfg.providerConfig || {}).forEach((id) => {
      const one = cfg.providerConfig[id] || {};
      providerConfig[id] = { engine: one.engine, baseUrl: one.baseUrl, model: one.model, hasKey: !!one.apiKey };
    });
    const { providerConfig: _omit, ...rest } = cfg;
    return {
      ok: true,
      config: {
        ...rest,
        providerConfig,
        hasKey: !!activeConfig(cfg).apiKey,
        // 内容脚本不能 import：目标语言的安全展示 / 检测元数据随配置下发；
        // 内部 id 与 BCP 47 code 分开，方向 / 字体只拿 code。
        activeLanguage: languageInfoFor(cfg.targetLang, cfg.customLanguages),
        languages: languageOptions(cfg.customLanguages),
        page: pageAppearance(cfg, sender),
        providers: providerChoices(cfg)
      }
    };
  },
  // 内容脚本里的悬浮入口切服务商：只允许切到「已配置 Key」的槽位
  'provider:set': async (msg) => {
    const id = String((msg && msg.provider) || '');
    if (!id) return { ok: false, error: 'bad_provider' };
    const cfg = await getConfig();
    const hit = providerChoices(cfg).filter((p) => p.id === id)[0];
    if (!hit) return { ok: false, error: 'bad_provider' };
    if (!hit.hasKey) return { ok: false, error: 'no_key', name: hit.name };
    if (hit.current) return { ok: true, provider: id, name: hit.name };
    await saveConfig({ currentProvider: id });
    return { ok: true, provider: id, name: hit.name };
  },
  // 网页里的悬浮入口切显示方式：和弹窗一样记进配置（只接受两个取值，其它配置项内容脚本改不了）
  'mode:set': async (msg) => {
    if (msg.mode !== 'dual' && msg.mode !== 'translation') return { ok: false };
    await saveConfig({ mode: msg.mode });
    return { ok: true };
  },
  // 网页里的悬浮入口拖拽后上报位置：只接受 {x,y} 或 null（恢复默认），内容脚本改不了其它配置项
  'dock:pos': async (msg) => {
    const pos = msg.pos === undefined ? null : msg.pos;
    if (pos !== null && (typeof pos !== 'object' || typeof pos.x !== 'number' || typeof pos.y !== 'number' || !Number.isFinite(pos.x) || !Number.isFinite(pos.y))) {
      return { ok: false, error: 'bad_value' };
    }
    await saveConfig({ dockPos: pos === null ? null : { x: Math.round(pos.x), y: Math.round(pos.y) } });
    return { ok: true };
  },  // 内容脚本不能直接写配置（完整配置含 Key）：只允许改这一个布尔开关
  'hover:set': async (msg) => {
    if (typeof msg.value !== 'boolean') return { ok: false, error: 'bad_value' };
    const cfg = await getConfig();
    if ((cfg.hoverCompare !== false) === msg.value) return { ok: true, value: msg.value };
    await saveConfig({ hoverCompare: msg.value });
    return { ok: true, value: msg.value };
  },
  // 划词气泡「加入术语表」：内容脚本不能写配置，只能经这里加一条。
  // 只接受两个不超过 200 字的字符串；同名原文已有不同译法时先回 conflict，用户确认后带 overwrite 再来一次。
  // 清洗 / 去重 / 限条数都在 upsertGlossaryEntry 里做（和设置页导入、mergeConfig 同一套）。
  'glossary:add': async (msg) => {
    const one = msg || {};
    if (typeof one.source !== 'string' || typeof one.target !== 'string') return { ok: false, error: 'bad_value' };
    if (one.source.length > 200 || one.target.length > 200) return { ok: false, error: 'too_long' };
    let res;
    await saveConfig((cfg) => {
      res = upsertGlossaryEntry(
        cfg.glossary,
        { source: one.source, target: one.target },
        { overwrite: one.overwrite === true }
      );
      return res.action === 'added' || res.action === 'updated' ? { glossary: res.list } : null;
    });
    if (res.action === 'invalid') return { ok: false, error: 'bad_value' };
    if (res.action === 'full') return { ok: false, error: 'full', max: GLOSSARY_MAX };
    if (res.action === 'conflict') return { ok: true, action: 'conflict', current: res.current };
    if (res.action === 'same') return { ok: true, action: 'same' };
    return { ok: true, action: res.action };
  },
  // 开发调试用的用量统计（设置页打开「输出调试日志」后才返回）
  'usage:stats': async () => {
    const cfg = await getConfig();
    if (!cfg.debug) return { ok: false, error: '需要先在设置页打开「输出调试日志」' };
    return { ok: true, stats: usageStats.snapshot() };
  },
  'usage:reset': async () => {
    const cfg = await getConfig();
    if (!cfg.debug) return { ok: false, error: '需要先在设置页打开「输出调试日志」' };
    usageStats.reset();
    return { ok: true };
  },
  // 设置页的缓存统计：估算值（LRU 预算用）+ 浏览器实际记的占用
  'cache:stats': async () => {
    await cache.ready;
    return { ok: true, stats: cache.stats(), bytesInUse: await cache.bytesInUse() };
  },
  // 标签页级"翻译中"记忆：返回/刷新后自动恢复翻译（同一站点才恢复）
  'resume:set': async (msg, sender) => {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId == null) return { ok: false };
    let host = '';
    try {
      host = new URL(sender.tab.url).host;
    } catch (err) {
      host = '';
    }
    try {
      await chrome.storage.session.set({ ['resume:' + tabId]: { value: !!msg.value, host: host } });
    } catch (err) {
      /* 会话存储不可用就算了 */
    }
    return { ok: true };
  },
  'resume:get': async (msg, sender) => {
    const tabId = sender && sender.tab ? sender.tab.id : null;
    if (tabId == null) return { ok: true, value: false };
    let host = '';
    try {
      host = new URL(sender.tab.url).host;
    } catch (err) {
      host = '';
    }
    try {
      const got = await chrome.storage.session.get('resume:' + tabId);
      const hit = got['resume:' + tabId];
      if (!hit || !hit.value) return { ok: true, value: false };
      // 只在本标签页还是同一个站点时才自动恢复，避免跳到别的网站也自动翻
      return { ok: true, value: !hit.host || hit.host === host };
    } catch (err) {
      return { ok: true, value: false };
    }
  },
  'cache:clear': async () => {
    await cache.clear();
    alignCache.clear();
    return { ok: true };
  }
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const route = msg && msg.type ? ROUTES[msg.type] : null;
  if (!route) {
    sendResponse({ ok: false, error: '未知指令：' + (msg && msg.type) });
    return false;
  }
  Promise.resolve()
    .then(() => route(msg, sender))
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: describeError(err) }));
  return true; // 异步应答
});

// 快捷键：Alt+A
// 注意：Chrome 只在没有别的扩展占用时才把 manifest 里的 Alt+A 分配给我们
// （沉浸式翻译等默认也是 Alt+A），没分配到时这里永远不会触发。
// 实际绑定结果用 chrome.commands.getAll() 查，弹窗和设置页会显示。
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-translate') return;
  try {
    // Chrome 会把当前标签页传进来；service worker 没有"当前窗口"，查 currentWindow 不可靠
    let target = tab;
    if (!target || target.id == null) {
      [target] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    }
    if (target && target.id != null) {
      // source 让内容脚本和页面内快捷键去重（两边都触发时会"开了又关"）
      await sendOrInject(target.id, { type: 'dt:toggle', source: 'command' });
    }
  } catch (err) {
    /* 页面不支持时静默 */
  }
});

// 标签页关闭后清掉记忆
chrome.tabs.onRemoved.addListener((tabId) => {
  try {
    chrome.storage.session.remove('resume:' + tabId).catch(() => {});
  } catch (err) {
    /* 忽略 */
  }
});

// API Key 存在 storage.local，而 local 默认对内容脚本开放（内容脚本能直接 get 到整份配置）。
// 收紧成只有扩展自己的页面 / service worker 可读。浏览器不支持对 local 设置时静默跳过：
// 我们自己的代码本来也不再把 Key 发给内容脚本（见 config:get）。
function restrictStorage() {
  try {
    const p = chrome.storage.local.setAccessLevel
      ? chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
      : null;
    if (p && p.catch) p.catch(() => {});
  } catch (err) {
    /* 不支持 */
  }
}
restrictStorage();
chrome.runtime.onStartup.addListener(restrictStorage);

// ---------------- 划词：右键菜单（A 方案） ----------------
const SELECTION_MENU_ID = 'rimefox-translate-selection';

const INPUT_MENU_ID = 'rimefox-translate-input';

function sendToFrame(tab, frameId, payload) {
  // info.frameId 让请求只发给点中的那个 iframe
  const options = frameId != null ? { frameId } : {};
  chrome.tabs.sendMessage(tab.id, payload, options).catch(() => {
    // 页面在安装扩展之前就打开了：补注入后再试一次
    ensureInjected(tab.id, frameId ?? 0)
      .then((ok) => ok && chrome.tabs.sendMessage(tab.id, payload, options))
      .catch(() => {});
  });
}

// 菜单是否显示跟随设置：划词总开关或「右键菜单」关掉时连输入框那条一起重建
function syncSelectionMenu() {
  getConfig()
    .then((cfg) => {
      chrome.contextMenus.removeAll(() => {
        void chrome.runtime.lastError;
        // 输入框翻译不单独设开关：只有用户点了菜单才触发，留着不碍事
        chrome.contextMenus.create(
          {
            id: INPUT_MENU_ID,
            title: '凛狐：翻译输入框内容',
            contexts: ['editable']
          },
          () => void chrome.runtime.lastError
        );
        if (cfg.selectionTranslate === false || cfg.selectionMenu === false) return;
        chrome.contextMenus.create(
          {
            id: SELECTION_MENU_ID,
            title: '凛狐：翻译所选文字',
            contexts: ['selection']
          },
          () => void chrome.runtime.lastError
        );
      });
    })
    .catch(() => {});
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === SELECTION_MENU_ID) {
    sendToFrame(tab, info.frameId, { type: 'dt:translateSelection', text: info.selectionText || '' });
    return;
  }
  if (info.menuItemId === INPUT_MENU_ID) {
    sendToFrame(tab, info.frameId, { type: 'dt:translateInput' });
  }
});

chrome.runtime.onStartup.addListener(syncSelectionMenu);

// 配置变了（设置页保存、弹窗切模式）就通知所有标签页重新拉一次（去掉 Key 的）配置。
// 以前内容脚本自己监听 storage.onChanged，但那样事件里带着完整配置（含 Key），
// 而且 local 收紧访问后内容脚本也收不到了。
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.config) return;
  syncSelectionMenu();
  chrome.tabs.query({}).then(
    (tabs) => {
      tabs.forEach((tab) => {
        if (tab.id == null) return;
        chrome.tabs.sendMessage(tab.id, { type: 'dt:configChanged' }).catch(() => {});
      });
    },
    () => {}
  );
});

// 首次安装：打开欢迎页 / 新手引导。更新扩展、浏览器重启都不打开。
// welcomeOpened 防止同一次 worker 生命周期里重复打开（onInstalled 本身只触发一次）。
let welcomeOpened = false;
chrome.runtime.onInstalled.addListener((details) => {
  syncSelectionMenu();
  if (!shouldOpenWelcome(details) || welcomeOpened) return;
  welcomeOpened = true;
  openWelcomePage().catch(() => {
    // 打开失败时不影响安装完成；用户仍可从设置页 / 弹窗手动打开使用指南
  });
});
