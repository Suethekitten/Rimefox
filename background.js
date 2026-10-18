// Service worker：翻译中枢。所有请求只发生在后台，content script 不直接碰 API Key。
import { getConfig, activeConfig, styleById } from './lib/config.js';
import { systemPrompt, temperatureFor } from './lib/prompt.js';
import { chat, ApiError } from './lib/provider.js';
import { parseArray, parseArrayFromReasoning, isRunaway } from './lib/parse.js';
import * as cache from './lib/cache.js';

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
async function translateBatchWithRetry(texts, target, cfg, style) {
  let attempt = 0;
  let lastErr = null;
  const temperature = temperatureFor(cfg, style);
  let mismatch = false;
  while (attempt < 3 && !mismatch) {
    attempt += 1;
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
          { role: 'system', content: systemPrompt(target, style) },
          { role: 'user', content: JSON.stringify(texts) }
        ]
      });
      const parsed = parseArray(raw, texts.length);
      if (parsed) return parsed;
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
      if (!retriable) throw err;
    }
    if (attempt < 3 && !mismatch) await sleep(700 * attempt);
  }
  if (mismatch) {
    // 两半并行各自翻（各自带重试），拆到单条为止。放在重试循环外面：
    // 某一半失败时直接失败，不能再把整批重来一遍
    const mid = Math.ceil(texts.length / 2);
    const halves = await Promise.all([
      translateBatchWithRetry(texts.slice(0, mid), target, cfg, style),
      translateBatchWithRetry(texts.slice(mid), target, cfg, style)
    ]);
    return halves[0].concat(halves[1]);
  }
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
  const rawTexts = Array.isArray(msg.texts) ? msg.texts : [];
  const texts = rawTexts.map((t) => (t == null ? '' : String(t)));
  const results = new Array(texts.length).fill(null);

  const active = activeConfig(cfg);
  if (!active.apiKey) {
    return { ok: false, error: '还没有配置 API Key，请先打开「设置」填写。', results };
  }

  const scope = { target, style, model: active.provider + ':' + active.model, host: hostOf(sender) };
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
    const hit = cache.get(keyOf(text));
    if (hit !== undefined) {
      results[index] = hit;
      cached += 1;
    } else {
      groups.set(text, [index]);
    }
  });
  const todo = Array.from(groups.keys());

  if (todo.length === 0) {
    return { ok: true, results, failed: 0, cached };
  }

  // 按条数 + 字符数切批，避免单次请求过大
  const maxItems = Math.max(1, Number(cfg.batchSize) || 12);
  const maxChars = Math.max(200, Number(cfg.maxCharsPerBatch) || 3000);
  const batches = [];
  let current = [];
  let chars = 0;
  todo.forEach((text) => {
    const len = text.length;
    if (current.length > 0 && (current.length >= maxItems || chars + len > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(text);
    chars += len;
  });
  if (current.length > 0) batches.push(current);

  let firstError = null;

  await Promise.all(
    batches.map((payload) =>
      (async () => {
        await acquire();
        try {
          const out = await translateBatchWithRetry(payload, target, cfg, style);
          if (!out) throw new ApiError('模型返回无法解析', 0, '');
          payload.forEach((text, k) => {
            const value = out[k];
            let result = '';
            if (typeof value === 'string' && value.trim() && !isRunaway(text, value)) {
              result = value;
              cache.set(keyOf(text), value);
            }
            // 否则：模型返回空（"EN"/"×" 这类不需要翻的），或译文长得离谱（见 isRunaway）：给 ''，
            // 和失败的 null 区分开，内容脚本据此记为"与原文相同"而不是失败。不进缓存，免得一次抽风永久生效。
            groups.get(text).forEach((index) => {
              results[index] = result;
            });
          });
        } catch (err) {
          if (!firstError) firstError = err;
        } finally {
          release();
        }
      })()
    )
  );

  const failed = results.filter((r) => r === null).length;
  if (failed === results.length) {
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
async function ensureInjected(tabId) {
  if (!tabId) return false;
  try {
    await chrome.scripting.insertCSS({
      target: { tabId: tabId },
      files: ['content/styles/inject.css']
    });
  } catch (err) {
    /* 样式重复插入会报错，忽略 */
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content/core.js', 'content/dom.js', 'content/main.js', 'content/hover.js']
    });
    return true;
  } catch (err) {
    return false;
  }
}

async function sendOrInject(tabId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg);
  } catch (err) {
    const ok = await ensureInjected(tabId);
    if (!ok) throw err;
    return chrome.tabs.sendMessage(tabId, msg);
  }
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
  'config:get': async () => {
    const cfg = await getConfig();
    // 嵌套的 providerConfig 里也有 Key：逐个剥掉，只留协议、地址和模型
    const providerConfig = {};
    Object.keys(cfg.providerConfig || {}).forEach((id) => {
      const one = cfg.providerConfig[id] || {};
      providerConfig[id] = { engine: one.engine, baseUrl: one.baseUrl, model: one.model };
    });
    const { providerConfig: _omit, ...rest } = cfg;
    return { ok: true, config: { ...rest, providerConfig, hasKey: !!activeConfig(cfg).apiKey } };
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
    ensureInjected(tab.id)
      .then(() => chrome.tabs.sendMessage(tab.id, payload, options))
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

// 首次安装且没有 key 时，直接拉开设置页
chrome.runtime.onInstalled.addListener(async () => {
  syncSelectionMenu();
  const cfg = await getConfig();
  if (!activeConfig(cfg).apiKey) {
    chrome.runtime.openOptionsPage();
  }
});
