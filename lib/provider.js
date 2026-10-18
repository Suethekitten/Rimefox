// 翻译接口门面：按 engine 分发到具体协议实现（OpenAI 兼容 / Anthropic / Gemini）。
// 对调用方保持旧签名：chat({ baseUrl, apiKey, model, messages, ... })，
// 不传 engine 时等价于以前的行为（OpenAI 兼容）。
import { ApiError } from './engines/errors.js';
import * as openai from './engines/openai.js';
import * as anthropic from './engines/anthropic.js';
import * as gemini from './engines/gemini.js';
import { findProviderByBaseUrl } from './providers.js';

export { ApiError };

const ENGINES = { openai, anthropic, gemini };

export const ENGINE_IDS = Object.keys(ENGINES);

export function engineOf(engineId) {
  return ENGINES[engineId] || ENGINES.openai;
}

// 设置页用：列出所有引擎及其默认值
export function engineList() {
  return ENGINE_IDS.map((key) => ({
    id: ENGINES[key].id,
    label: ENGINES[key].label,
    defaults: ENGINES[key].defaults
  }));
}

// 单个请求的总上限（保活不断但一直不出结果时兜底）
const TOTAL_CAP_MS = 180000;

// custom 模式下用户填的 JSON；写错了就当没填，不要让整页翻译挂掉
function parseThinkingExtra(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (err) {
    return {};
  }
}

// 服务不认思考参数时会回 400：识别这些关键词后去掉参数重试一次
function looksLikeParamError(raw) {
  return /reasoning_effort|unknown (field|parameter|name)|unrecognized|unsupported|not supported|invalid.{0,20}(parameter|argument|field)|extra fields/i.test(
    String(raw || '')
  );
}

export async function chat(opts) {
  const {
    engine = 'openai',
    baseUrl,
    apiKey,
    model,
    messages,
    temperature = 0.2,
    maxTokens = 2048,
    timeoutMs = 60000,
    thinkingMode = 'auto',
    thinkingExtra = ''
  } = opts || {};

  if (!apiKey) throw new ApiError('还没有配置 API Key', 0, '');
  if (!model) throw new ApiError('还没有配置模型名', 0, '');

  const impl = engineOf(engine);

  // 关闭思考的参数各家不同：能根据地址认出服务商时用它的专属参数
  const known = findProviderByBaseUrl(baseUrl);
  const offExtra = known && known.thinkingOff ? known.thinkingOff : null;

  let extra = {};
  if (thinkingMode === 'custom') extra = parseThinkingExtra(thinkingExtra);
  else if (thinkingMode === 'off' && offExtra) extra = offExtra;

  const cfg = { baseUrl, apiKey, model };

  for (let pass = 0; pass < 2; pass += 1) {
    const thinking = pass === 0 ? { mode: thinkingMode, extra } : { mode: 'auto' };
    const request = impl.buildRequest(cfg, {
      messages,
      temperature,
      maxTokens,
      extraHeaders: opts.extraHeaders,
      thinking
    });

    const { res, raw } = await sendOnce(request, timeoutMs);

    if (!res.ok) {
      // 服务不认思考参数：去掉后重试一次。一个可选开关不应该让整页翻译挂掉
      if (pass === 0 && thinkingMode !== 'auto' && res.status === 400 && looksLikeParamError(raw)) {
        continue;
      }
      throw impl.parseError(res.status, raw);
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new ApiError('接口返回的不是合法 JSON', res.status, raw.slice(0, 300));
    }

    const parsed = impl.parseResponse(data) || { text: '', reasoning: false };
    if (parsed.error) throw new ApiError(parsed.error, res.status, raw.slice(0, 300));
    if (!parsed.text) {
      throw new ApiError('返回结构里没有可用的译文内容', res.status, raw.slice(0, 300));
    }

    // 带"思考"过程的模型（推理模型）每批都要先想一阵再输出，整页翻译会慢很多倍
    if (opts.meta) opts.meta.reasoning = !!parsed.reasoning;

    return parsed.text;
  }

  throw new ApiError('翻译失败', 0, '');
}

// 一次 HTTP 往返：空闲计时 + 总上限。
// 超时按"多久没收到任何数据"计，不按总时长：
// DeepSeek 等接口的非流式请求会立刻回响应头，生成期间持续发空行保活，
// 正文要等整批生成完才来。0.4.2 曾把总超时套在整个响应体上，生成超过 60 秒的批次
// 全被中止、重试 3 次也不会成功。现在每收到一块数据就重新计时；
// 另设一个总上限，防止保活不断但永远不出结果的连接一直占着并发名额。
async function sendOnce(request, timeoutMs) {
  const controller = new AbortController();
  const idleMs = Math.max(5000, timeoutMs);
  let why = '';
  let idleTimer = 0;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      why = '超过 ' + Math.round(idleMs / 1000) + 's 没有收到数据';
      controller.abort();
    }, idleMs);
  };
  const totalTimer = setTimeout(() => {
    why = '超过 ' + Math.round(TOTAL_CAP_MS / 1000) + 's 仍未完成';
    controller.abort();
  }, TOTAL_CAP_MS);
  touch();

  let res;
  let raw;
  try {
    res = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: controller.signal
    });
    raw = await readBody(res, touch);
  } catch (err) {
    if (why || (err && err.name === 'AbortError')) {
      throw new ApiError('请求超时（' + (why || Math.round(idleMs / 1000) + 's') + '）', 0, '');
    }
    throw new ApiError('网络请求失败：' + (err && err.message ? err.message : String(err)), 0, '');
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
  }

  return { res, raw };
}

// 模型列表：按引擎走各自的接口；设置页直接用表单里的地址和 Key 调（还没保存也能查）
export async function listModels(opts) {
  const { engine = 'openai', baseUrl, apiKey, timeoutMs = 15000 } = opts || {};
  if (!apiKey) throw new ApiError('还没有填写 API Key', 0, '');
  return engineOf(engine).listModels({ baseUrl, apiKey, timeoutMs });
}

// 边读边重置空闲计时；不支持流式读取的环境退回 res.text()
async function readBody(res, onData) {
  if (!res.body || !res.body.getReader) return res.text();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onData();
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}
