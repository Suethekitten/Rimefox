// OpenAI 兼容协议：DeepSeek / 智谱 / 通义 / 硅基流动 / Kimi / Ollama / 自建网关 都用这套
import { ApiError, httpMessage, extractMessage } from './errors.js';

export const id = 'openai';
export const label = 'OpenAI 兼容';
export const defaults = { baseUrl: 'https://api.deepseek.com/v1', model: '' };

// 允许直接粘贴完整的 /chat/completions 地址
export function endpointOf(baseUrl) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!base) throw new ApiError('未填写 API 地址', 0, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return base + '/chat/completions';
}

export function buildRequest(cfg, req) {
  const { baseUrl, apiKey, model } = cfg || {};
  const { messages, temperature, maxTokens, extraHeaders, thinking } = req || {};
  const mode = (thinking && thinking.mode) || 'auto';

  const body = {
    model,
    messages: messages || [],
    temperature,
    max_tokens: maxTokens,
    stream: false
  };

  const extra = thinking && thinking.extra && typeof thinking.extra === 'object' ? thinking.extra : {};
  const hasExtra = Object.keys(extra).length > 0;

  // 服务商有专属关闭参数时（如 DeepSeek 的 thinking.type、千问的 enable_thinking）优先用它；
  // 没有才退回 OpenAI 标准的 reasoning_effort
  if (mode === 'off' && !hasExtra) body.reasoning_effort = 'none';
  if ((mode === 'off' || mode === 'custom') && hasExtra) Object.assign(body, extra);

  return {
    url: endpointOf(baseUrl),
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + String(apiKey || ''),
      ...(extraHeaders || {})
    },
    body: JSON.stringify(body)
  };
}

// 返回 { text, reasoning, reasoningText, finishReason }：
// reasoningText 是思考过程（DeepSeek 的 reasoning_content）—— content 为空时上层从里面找答案兜底；
// finishReason=length 说明 token 预算被思考用完了，上层会关掉思考重试
export function parseResponse(json) {
  const choice = json && json.choices && json.choices[0];
  const message = choice && choice.message;
  const finishReason = (choice && choice.finish_reason) || '';
  if (!message) return { text: '', reasoning: false, reasoningText: '', finishReason };

  let content = message.content;
  // 个别网关在多模态时会把 content 给成数组：拼出其中的文本片段
  if (Array.isArray(content)) {
    content = content
      .map((part) => (part && (typeof part.text === 'string' ? part.text : part.content)) || '')
      .join('');
  }

  const details = json.usage && json.usage.completion_tokens_details;
  const reasoning =
    !!(message.reasoning_content || message.reasoning) ||
    !!(details && details.reasoning_tokens > 0);

  let reasoningText = '';
  if (typeof message.reasoning_content === 'string') reasoningText = message.reasoning_content;
  else if (typeof message.reasoning === 'string') reasoningText = message.reasoning;

  return { text: typeof content === 'string' ? content : '', reasoning, reasoningText, finishReason };
}

export function parseError(status, bodyText) {
  const detail = String(bodyText || '').slice(0, 400);
  const extra = extractMessage(bodyText).slice(0, 160);
  const base = httpMessage(status);
  return new ApiError(extra ? base + '：' + extra : base, status, detail);
}

// 模型列表的三种常见形态：{data:[{id}]} / {models:[...]} / 裸数组
export function parseModels(json) {
  const list = Array.isArray(json) ? json : (json && (json.data || json.models)) || [];
  const ids = list
    .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name)))
    .filter((x) => typeof x === 'string' && x);
  return Array.from(new Set(ids));
}

export async function listModels({ baseUrl, apiKey, timeoutMs = 15000 } = {}) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/, '');
  if (!base) throw new ApiError('未填写 API 地址', 0, '');
  if (!apiKey) throw new ApiError('还没有填写 API Key', 0, '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let raw;
  try {
    res = await fetch(base + '/models', {
      headers: { Authorization: 'Bearer ' + apiKey },
      signal: controller.signal
    });
    raw = await res.text();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new ApiError('获取模型列表超时（' + Math.round(timeoutMs / 1000) + 's）', 0, '');
    }
    throw new ApiError('网络请求失败：' + (err && err.message ? err.message : String(err)), 0, '');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    // 有的服务商（或自建网关）没有这个接口：不算错，让用户手填
    const message =
      res.status === 404 || res.status === 405
        ? '这个接口不提供模型列表，请直接手填模型名'
        : httpMessage(res.status);
    throw new ApiError(message, res.status, raw.slice(0, 300));
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ApiError('模型列表不是合法 JSON', res.status, raw.slice(0, 300));
  }
  return parseModels(data);
}
