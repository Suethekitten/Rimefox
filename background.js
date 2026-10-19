// Service worker：翻译中枢。所有请求只发生在后台，content script 不直接碰 API Key。
import { getConfig, saveConfig, activeConfig, styleById, providerChoices } from './lib/config.js';
import { systemPrompt, temperatureFor, promptFingerprint } from './lib/prompt.js';
import { chat, ApiError } from './lib/provider.js';
import { parseArray, parseArrayFromReasoning, isRunaway, normalizeTranslationBreaks, leaksWrapper } from './lib/parse.js';
import { matchGlossary, normalizeGlossary, glossaryFingerprint } from './lib/glossary.js';
import * as cache from './lib/cache.js';
import { accentHex, isDefaultAccent, sanitizeTranslationCss, typographyVars } from './lib/appearance.js';
import { resolveSiteRule, hostListed } from './lib/site-rules.js';
import { providerById } from './lib/providers.js';
import { maskTexts, restoreText, optionsFromConfig } from './lib/privacy.js';
import { openWelcomePage, shouldOpenWelcome } from './lib/welcome.js';
import { createUsageStats } from './lib/usage.js';

// 仅开发调试用的用量统计：只记数字，不记正文 / Key / Prompt / 原始响应
const usageStats = createUsageStats();

// 在途的翻译：缓存键 → Promise<{ value: 译文 | ''（无需翻译）| null（失败）, error }>，见 handleTranslate
const inflight = new Map();

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

// style：趣味翻译风格（lib/config.js 的 STYLES），普通翻译为 'plain'
async function translateBatchWithRetry(texts, target, cfg, style, glossary, privacyMasked) {
  let attempt = 0;
  let lastErr = null;
  const temperature = temperatureFor(cfg, style);
  let mismatch = false;
  // 本批命中的术语（没命中就是空数组，提示词里不会多出术语段）
  const hits = matchGlossary(glossary, texts);
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
          { role: 'system', content: systemPrompt(target, style, hits, cfg.customPrompt, privacyMasked) },
          { role: 'user', content: JSON.stringify(texts) }
        ]
      });
      const parsed = parseArray(raw, texts.length);
      if (parsed) return parsed;
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
        if (salvaged) return salvaged;
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
      left = await translateBatchWithRetry(texts.slice(0, mid), target, cfg, style, glossary, privacyMasked);
    } catch (err) {
      leftErr = err;
    }
    try {
      right = await translateBatchWithRetry(texts.slice(mid), target, cfg, style, glossary, privacyMasked);
    } catch (err) {
      rightErr = err;
    }
    if (left && right) return left.concat(right);
    if (!left && !right) throw leftErr || rightErr || new ApiError('翻译失败', 0, '');
    const out = new Array(texts.length).fill(null);
    if (left) left.forEach((value, i) => { out[i] = value; });
    if (right) right.forEach((value, i) => { out[mid + i] = value; });
    return out;
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
  const cfg = await getConfig();
  maxParallel = Math.max(1, Math.min(16, Number(cfg.concurrency) || 6));

  const target = msg.target || cfg.targetLang;
  const style = styleById(msg.style).value; // 不认识的风格按普通翻译
  const glossary = normalizeGlossary(cfg.glossary);
  const rawTexts = Array.isArray(msg.texts) ? msg.texts : [];
  const texts = rawTexts.map((t) => (t == null ? '' : String(t)));
  const results = new Array(texts.length).fill(null);

  const active = activeConfig(cfg);
  if (!active.apiKey) {
    return { ok: false, error: '还没有配置 API Key，请先打开「设置」填写。', results };
  }

  // 缓存键带上术语表 / 自定义提示词指纹：改了之后旧译文不能再命中
  const scope = {
    target,
    style,
    model: active.provider + ':' + active.model,
    host: hostOf(sender),
    glossary: glossaryFingerprint(glossary),
    prompt: promptFingerprint(cfg.customPrompt)
  };
  const keyOf = (text) => cache.makeKey(scope, text);

  // 同一批里重复的文本（页面上一排相同的按钮、"Reply"、"Share"）只翻一次、只付一次钱：
  // groups 记 原文 → 它出现的所有位置，只把 groups 的键送去翻，回来按位置回填
  const groups = new Map();
  let cached = 0;
  texts.forEach((text, index) => {
    if (!text.trim()) {
      results[index] = '';
      return;
    }
    if (groups.has(text)) {
      groups.get(text).push(index);
      return;
    }
    let hit = cache.get(keyOf(text));
    // 旧版本存进去的译文可能带着多转义的字面 \n（Pixiv 中译英）：读出来同样规范化，改了就顺手写回；
    // 残留 JSON 包装的旧译文当作没命中，重新翻（不整体清缓存）
    if (typeof hit === 'string') {
      const fixed = normalizeTranslationBreaks(text, hit);
      if (leaksWrapper(text, fixed)) {
        cache.remove(keyOf(text));
        hit = undefined;
      } else if (fixed !== hit) {
        cache.set(keyOf(text), fixed);
        hit = fixed;
      }
    }
    if (hit !== undefined) {
      results[index] = hit;
      cached += 1;
      usageStats.cacheHit();
    } else {
      groups.set(text, [index]);
    }
  });
  usageStats.cacheMiss(groups.size);
  let todo = Array.from(groups.keys());
  let firstError = null;

  // 这一条的结果定下来了：回填到它出现的所有位置；失败（null）时记下第一个原因
  function fill(text, value, err) {
    groups.get(text).forEach((index) => {
      results[index] = value;
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
        fill(text, done.value, done.error);
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
    settles.set(text, (value, error) => {
      if (inflight.get(key) === running) inflight.delete(key);
      resolve({ value, error });
    });
  });
  function settle(text, value, err) {
    fill(text, value, err);
    const done = settles.get(text);
    if (done) {
      settles.delete(text);
      done(value, value === null ? err || firstError : null);
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

  const runs = batches.map((payload) =>
    (async () => {
      await acquire();
      try {
        // 发出去的是脱敏后的文本；映射只在本地
        const wire = privacyRows ? payload.map((text) => privacyRows.get(text).masked) : payload;
        const out = await translateBatchWithRetry(wire, target, cfg, style, glossary, !!privacyRows);
        if (!out) throw new ApiError('模型返回无法解析', 0, '');
        payload.forEach((text, k) => {
          let value = out[k];
          if (value === null) {
            // 拆批时一半失败：这一条按失败处理，另一半已经成功的照常写缓存
            settle(text, null, new ApiError('其中一部分译文失败，稍后重试', 0, ''));
            return;
          }
          if (privacyRows) {
            const back = restoreText(String(value == null ? '' : value), privacyRows.get(text).tokens, privacyValues);
            if (!back.ok) {
              // 占位符丢失 / 被改写 / 对不上：这一段判失败，不输出半截译文，也不缓存
              settle(text, null, new ApiError('本地隐私保护无法还原这段译文，已跳过', 0, back.reason || ''));
              return;
            }
            value = back.text;
          }
          // 多转义的字面 \n 在写缓存之前就规范化（对照原文的分行，代码 / 路径原样保留）
          value = normalizeTranslationBreaks(text, value);
          // 写入前兜底：残留 JSON 包装 / 字段名 / 提示词原句 → 这一条按失败处理，不插进网页、不进缓存
          if (typeof value === 'string' && leaksWrapper(text, value)) {
            settle(text, null, new ApiError('模型返回的译文里混进了 JSON 格式，已丢弃', 0, ''));
            return;
          }
          let result = '';
          if (typeof value === 'string' && value.trim() && !isRunaway(text, value)) {
            result = value;
            cache.set(keyOf(text), value);
          }
          // 否则：模型返回空（"EN"/"×" 这类不需要翻的），或译文长得离谱（见 isRunaway）：给 ''，
          // 和失败的 null 区分开，内容脚本据此记为"与原文相同"而不是失败。不进缓存，免得一次抽风永久生效。
          settle(text, result);
        });
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
  if (results.length && failed === results.length) {
    return { ok: false, error: describeError(firstError), results };
  }

  return {
    ok: true,
    results,
    failed,
    cached,
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
      files: [
        'content/core.js',
        'content/dom.js',
        'content/appearance.js',
        'content/main.js',
        'content/selection.js',
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
  // 内容脚本不能直接写配置（完整配置含 Key）：只允许改这一个布尔开关
  'hover:set': async (msg) => {
    if (typeof msg.value !== 'boolean') return { ok: false, error: 'bad_value' };
    const cfg = await getConfig();
    if ((cfg.hoverCompare !== false) === msg.value) return { ok: true, value: msg.value };
    await saveConfig({ hoverCompare: msg.value });
    return { ok: true, value: msg.value };
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

// 菜单是否显示跟随设置：总开关或「右键菜单」关掉时移除
function syncSelectionMenu() {
  getConfig()
    .then((cfg) => {
      const want = cfg.selectionTranslate !== false && cfg.selectionMenu !== false;
      chrome.contextMenus.removeAll(() => {
        void chrome.runtime.lastError;
        if (!want) return;
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
  if (info.menuItemId !== SELECTION_MENU_ID) return;
  if (!tab || tab.id == null) return;

  const payload = { type: 'dt:translateSelection', text: info.selectionText || '' };
  // info.frameId 让请求只发给选中的那个 iframe
  const options = info.frameId != null ? { frameId: info.frameId } : {};

  chrome.tabs.sendMessage(tab.id, payload, options).catch(() => {
    // 页面在安装扩展之前就打开了：补注入后再试一次
    ensureInjected(tab.id, info.frameId ?? 0)
      .then((ok) => ok && chrome.tabs.sendMessage(tab.id, payload, options))
      .catch(() => {});
  });
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