// Anthropic Claude 原生协议
// 差异点：x-api-key 鉴权、system 提到顶层、temperature 上限 1、max_tokens 必填、
// 浏览器直连必须带 anthropic-dangerous-direct-browser-access
import { ApiError, httpMessage, extractMessage } from './errors.js';

export const id = 'anthropic';
export const label = 'Anthropic Claude';
export const defaults = { baseUrl: 'https://api.anthropic.com/v1', model: '' };

const ANTHROPIC_VERSION = '2023-06-01';

export function endpointOf(baseUrl) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!base) throw new ApiError('未填写 API 地址', 0, '');
  if (/\/messages$/.test(base)) return base;
  return base + '/messages';
}

function clampTemperature(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.2;
  return Math.max(0, Math.min(1, n));
}

export function buildRequest(cfg, req) {
  const { baseUrl, apiKey, model } = cfg || {};
  const { messages, temperature, maxTokens, extraHeaders, thinking } = req || {};
  const mode = (thinking && thinking.mode) || 'auto';

  const systems = [];
  const conversation = [];
  (messages || []).forEach((m) => {
    if (!m) return;
    if (m.role === 'system') {
      systems.push(String(m.content || ''));
      return;
    }
    conversation.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '')
    });
  });
  if (!conversation.length) conversation.push({ role: 'user', content: '' });

  const body = {
    model,
    max_tokens: Number(maxTokens) > 0 ? Number(maxTokens) : 2048,
    ...(systems.length ? { system: systems.join('\n\n') } : {}),
    messages: conversation,
    temperature: clampTemperature(temperature)
  };

  // Anthropic 默认不开扩展思考："off" 就是什么都不发。
  // "custom" 允许用户自己写 {"thinking":{"type":"enabled","budget_tokens":1024}}
  if (mode === 'custom' && thinking.extra && typeof thinking.extra === 'object') {
    Object.assign(body, thinking.extra);
  }

  return {
    url: endpointOf(baseUrl),
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': String(apiKey || ''),
      'anthropic-version': ANTHROPIC_VERSION,
      // 浏览器 / 扩展里直连必需，否则被 CORS 挡掉
      'anthropic-dangerous-direct-browser-access': 'true',
      ...(extraHeaders || {})
    },
    body: JSON.stringify(body)
  };
}

export function parseResponse(json) {
  const blocks = (json && json.content) || [];
  if (!Array.isArray(blocks)) return { text: '', reasoning: false };

  const text = blocks
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('');
  const reasoning = blocks.some((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking'));

  return { text, reasoning };
}

export function parseError(status, bodyText) {
  const detail = String(bodyText || '').slice(0, 400);
  const extra = extractMessage(bodyText).slice(0, 160);

  if (status === 529) {
    return new ApiError('Anthropic 服务过载，请稍后重试', status, detail);
  }
  if (/credit|billing|quota/i.test(extra)) {
    return new ApiError('账户余额不足：' + extra, status, detail);
  }
  return new ApiError(extra ? httpMessage(status) + '：' + extra : httpMessage(status), status, detail);
}

export function parseModels(json) {
  const list = (json && (json.data || json.models)) || [];
  const ids = list
    .map((m) => (typeof m === 'string' ? m : m && (m.id || m.name)))
    .filter((x) => typeof x === 'string' && x);
  return Array.from(new Set(ids));
}

export async function listModels({ baseUrl, apiKey, timeoutMs = 15000 } = {}) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/messages$/, '');
  if (!base) throw new ApiError('未填写 API 地址', 0, '');
  if (!apiKey) throw new ApiError('还没有填写 API Key', 0, '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let raw;
  try {
    res = await fetch(base + '/models', {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true'
      },
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
    throw new ApiError(
      res.status === 404 ? '这个接口不提供模型列表，请直接手填模型名' : httpMessage(res.status),
      res.status,
      raw.slice(0, 300)
    );
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ApiError('模型列表不是合法 JSON', res.status, raw.slice(0, 300));
  }
  return parseModels(data);
}
