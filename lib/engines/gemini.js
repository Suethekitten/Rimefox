// Google Gemini 原生协议（generateContent）
// 差异点：URL 里带模型名、x-goog-api-key 鉴权、contents + systemInstruction、
// 模型名会随版本上下线（所以不内置模型列表，一律从 /models 拉）
import { ApiError, httpMessage, extractMessage } from './errors.js';

export const id = 'gemini';
export const label = 'Google Gemini';
export const defaults = { baseUrl: 'https://generativelanguage.googleapis.com/v1beta', model: '' };

// 地区限制：Google 按出口 IP 判定，换 key 没用，只能换代理或换引擎
export const LOCATION_MESSAGE = '当前网络所在地区不被 Gemini 支持 —— 请使用代理或换用其它引擎';

export function endpointOf(cfg) {
  const base = String((cfg && cfg.baseUrl) || '')
    .trim()
    .replace(/\/+$/, '');
  if (!base) throw new ApiError('未填写 API 地址', 0, '');

  const name = String((cfg && cfg.model) || '')
    .trim()
    .replace(/^models\//, '');
  if (!name) throw new ApiError('还没有配置模型名', 0, '');

  // 保留 tunedModels/xxx 这类斜杠路径，其余照常编码
  const safe = encodeURIComponent(name).replace(/%2F/g, '/');
  return base + '/models/' + safe + ':generateContent';
}

export function buildRequest(cfg, req) {
  const { apiKey } = cfg || {};
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
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content || '') }]
    });
  });
  if (!conversation.length) conversation.push({ role: 'user', parts: [{ text: '' }] });

  const generationConfig = {
    temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.2,
    maxOutputTokens: Number(maxTokens) > 0 ? Number(maxTokens) : 2048
  };

  // 思考模式：Gemini 3 用 thinkingLevel，2.5 及更早用 thinkingBudget
  const extra = thinking && thinking.extra && typeof thinking.extra === 'object' ? thinking.extra : {};
  const hasExtra = Object.keys(extra).length > 0;
  const modelName = String((cfg && cfg.model) || '');

  if (mode === 'off' && !hasExtra) {
    generationConfig.thinkingConfig = /^gemini-3/i.test(modelName)
      ? { thinkingLevel: 'minimal' } // Gemini 3 Pro 无法完全关闭，只能降到最低档
      : { thinkingBudget: 0 };
  }

  const body = { contents: conversation, generationConfig };
  if (systems.length) body.systemInstruction = { parts: [{ text: systems.join('\n\n') }] };

  // custom / off 的服务商参数：允许写 {"thinkingConfig": {...}} 或 {"generationConfig": {...}}
  if ((mode === 'off' || mode === 'custom') && hasExtra) {
    const merged = { ...extra };
    if (merged.generationConfig && typeof merged.generationConfig === 'object') {
      Object.assign(generationConfig, merged.generationConfig);
      delete merged.generationConfig;
    }
    Object.assign(body, merged);
  }

  return {
    url: endpointOf(cfg),
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': String(apiKey || ''),
      ...(extraHeaders || {})
    },
    body: JSON.stringify(body)
  };
}

export function parseResponse(json) {
  const feedback = json && json.promptFeedback;
  if (feedback && feedback.blockReason) {
    return { text: '', reasoning: false, error: '内容被 Gemini 的安全策略拦截（' + feedback.blockReason + '）' };
  }

  const candidate = json && json.candidates && json.candidates[0];
  if (!candidate) return { text: '', reasoning: false };
  const finishReason = candidate.finishReason || '';

  const parts = (candidate.content && candidate.content.parts) || [];
  const text = parts
    .filter((p) => p && typeof p.text === 'string')
    .map((p) => p.text)
    .join('');

  if (!text && finishReason === 'MAX_TOKENS') {
    return { text: '', reasoning: false, finishReason, error: '输出被截断（达到 maxOutputTokens），请调小单批长度' };
  }

  return { text, reasoning: false, finishReason };
}

export function parseError(status, bodyText) {
  const detail = String(bodyText || '').slice(0, 400);
  const extra = extractMessage(bodyText);

  // 地区限制：文案由产品侧确认过，不要随意改动
  if (/User location is not supported/i.test(extra) || /User location is not supported/i.test(detail)) {
    return new ApiError(LOCATION_MESSAGE, status, detail);
  }
  if (/API_KEY_INVALID|API key not valid|API key expired/i.test(extra + detail)) {
    return new ApiError('API Key 无效或没有权限', status, detail);
  }
  if (status === 429) {
    return new ApiError('触发限流，请降低并发或稍后重试', status, detail);
  }
  if (status === 404) {
    return new ApiError('接口地址或模型名不存在', status, detail);
  }
  return new ApiError(extra ? httpMessage(status) + '：' + extra : httpMessage(status), status, detail);
}

// 只保留能对话的模型；名字去掉 "models/" 前缀
export function parseModels(json) {
  const list = (json && json.models) || [];
  const ids = list
    .filter((m) => {
      if (!m || typeof m.name !== 'string') return false;
      const methods = m.supportedGenerationMethods;
      // 没有这个字段时不强行过滤（部分网关会省略）
      return !Array.isArray(methods) || methods.indexOf('generateContent') >= 0;
    })
    .map((m) => m.name.replace(/^models\//, ''))
    .filter((x) => x);

  return Array.from(new Set(ids));
}

export async function listModels({ baseUrl, apiKey, timeoutMs = 15000 } = {}) {
  const base = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '');
  if (!base) throw new ApiError('未填写 API 地址', 0, '');
  if (!apiKey) throw new ApiError('还没有填写 API Key', 0, '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let raw;
  try {
    res = await fetch(base + '/models', {
      headers: { 'x-goog-api-key': apiKey },
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

  if (!res.ok) throw parseError(res.status, raw);

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ApiError('模型列表不是合法 JSON', res.status, raw.slice(0, 300));
  }
  return parseModels(data);
}
