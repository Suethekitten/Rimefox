// Service worker：翻译中枢。所有请求只发生在后台，content script 不直接碰 API Key。
import { getConfig, langLabel } from './lib/config.js';
import { chat, ApiError } from './lib/provider.js';
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

// ---------------- 提示词 ----------------
function systemPrompt(target) {
  const name = langLabel(target);
  return [
    '你是一个网页翻译引擎，只做翻译，不解释、不回答。',
    '输入：一个 JSON 字符串数组，每个元素是一段网页正文。',
    '输出：一个 JSON 字符串数组，元素数量与输入完全一致，第 i 个元素是第 i 段的目标语言（' + name + '）译文。',
    '规则：',
    '1) 只输出 JSON 数组本身，不要 Markdown 代码块，不要任何前后缀说明。',
    '2) 保持原文语气与信息量，不要合并、拆分或省略段落。',
    '3) 数字、单位、代码、URL、邮箱、人名、账号名保留原样。',
    '4) 已经是' + name + '的段落原样返回，不要改写。',
    '5) 按钮、菜单、导航等短文本的译文同样保持简短。',
    '6) 一段里中英混排时，把其中的英文句子也翻译成' + name + '，不要整段保留英文。',
    '7) 只有代码、URL、型号编号这类确实不该翻的内容才保留原文；标题、正文、说明文字一律要翻。',
    '8) 标题、活动名、品牌名、产品名也要翻成' + name + '；没有通用译名时可用「原名（译名）」或音译，不要因为“是专有名词”就整句原样返回英文。'
  ].join('\n');
}

function parseArray(raw, expected) {
  let text = String(raw || '').trim();
  if (!text) return null;

  text = text.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const arr = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(arr) && arr.length === expected) {
        return arr.map((x) => (x == null ? '' : String(x)));
      }
    } catch (err) {
      /* 落到下面的兜底 */
    }
  }

  // 兜底：按行拆（有些模型会输出 "1. xxx" 形式）
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*\d]+[.、)]\s*/, '').trim())
    .filter((line) => line.length > 0);

  if (lines.length === expected) return lines;
  return null;
}

async function translateBatchWithRetry(texts, target, cfg) {
  let attempt = 0;
  let lastErr = null;
  while (attempt < 3) {
    attempt += 1;
    try {
      const raw = await chat({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        temperature: Number(cfg.temperature) || 0.2,
        maxTokens: Math.min(8000, 512 + texts.join('').length * 2),
        timeoutMs: Number(cfg.timeoutMs) || 60000,
        messages: [
          { role: 'system', content: systemPrompt(target) },
          { role: 'user', content: JSON.stringify(texts) }
        ]
      });
      const parsed = parseArray(raw, texts.length);
      if (parsed) return parsed;
      lastErr = new ApiError('模型没有按 JSON 数组返回', 0, String(raw).slice(0, 300));
    } catch (err) {
      lastErr = err;
      const status = err && err.status ? err.status : 0;
      const retriable = status === 0 || status === 429 || status >= 500;
      if (!retriable) throw err;
    }
    if (attempt < 3) await sleep(700 * attempt);
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
async function handleTranslate(msg) {
  const cfg = await getConfig();
  maxParallel = Math.max(1, Math.min(8, Number(cfg.concurrency) || 3));

  const target = msg.target || cfg.targetLang;
  const rawTexts = Array.isArray(msg.texts) ? msg.texts : [];
  const texts = rawTexts.map((t) => (t == null ? '' : String(t)));
  const results = new Array(texts.length).fill(null);

  if (!cfg.apiKey) {
    return { ok: false, error: '还没有配置 API Key，请先打开「设置」填写。', results };
  }

  const todo = [];
  texts.forEach((text, index) => {
    if (!text.trim()) {
      results[index] = '';
      return;
    }
    const hit = cache.get(cache.makeKey(target, text));
    if (hit !== undefined) results[index] = hit;
    else todo.push(index);
  });

  if (todo.length === 0) {
    return { ok: true, results, failed: 0, cached: texts.length };
  }

  // 按条数 + 字符数切批，避免单次请求过大
  const maxItems = Math.max(1, Number(cfg.batchSize) || 12);
  const maxChars = Math.max(200, Number(cfg.maxCharsPerBatch) || 3000);
  const batches = [];
  let current = [];
  let chars = 0;
  todo.forEach((index) => {
    const len = texts[index].length;
    if (current.length > 0 && (current.length >= maxItems || chars + len > maxChars)) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(index);
    chars += len;
  });
  if (current.length > 0) batches.push(current);

  let firstError = null;

  await Promise.all(
    batches.map((indexes) =>
      (async () => {
        await acquire();
        try {
          const payload = indexes.map((i) => texts[i]);
          const out = await translateBatchWithRetry(payload, target, cfg);
          if (!out) throw new ApiError('模型返回无法解析', 0, '');
          indexes.forEach((index, k) => {
            const value = out[k];
            if (typeof value === 'string' && value.trim()) {
              results[index] = value;
              cache.set(cache.makeKey(target, texts[index]), value);
            }
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
    cached: texts.length - todo.length,
    error: firstError ? describeError(firstError) : ''
  };
}

async function handleTest() {
  const cfg = await getConfig();
  if (!cfg.apiKey) return { ok: false, error: '还没有填写 API Key' };
  const started = Date.now();
  try {
    const raw = await chat({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      temperature: 0,
      maxTokens: 256,
      timeoutMs: Math.min(30000, Number(cfg.timeoutMs) || 30000),
      messages: [
        { role: 'system', content: '你是一个翻译引擎。只输出 JSON 字符串数组，不要任何解释。' },
        { role: 'user', content: JSON.stringify(['Hello, world.', 'This is a connection test.']) }
      ]
    });
    const parsed = parseArray(raw, 2);
    return {
      ok: true,
      ms: Date.now() - started,
      model: cfg.model,
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
      files: ['content/core.js', 'content/dom.js', 'content/main.js']
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
  'config:get': async () => {
    const cfg = await getConfig();
    return { ok: true, config: cfg };
  },
  'stats': async () => ({ ok: true, cacheSize: cache.size() }),
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
    cache.clear();
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
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-translate') return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      await sendOrInject(tab.id, { type: 'dt:toggle' });
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

// 首次安装且没有 key 时，直接拉开设置页
chrome.runtime.onInstalled.addListener(async () => {
  const cfg = await getConfig();
  if (!cfg.apiKey) {
    chrome.runtime.openOptionsPage();
  }
});
