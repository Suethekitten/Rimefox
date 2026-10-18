// OpenAI 兼容接口客户端（DeepSeek / 智谱 / 硅基流动 / 通义 / 自建 均可）
export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 0;
    this.detail = detail || '';
  }
}

function endpointOf(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new ApiError('未填写 API 地址', 0, '');
  // 允许用户直接粘贴完整地址
  if (/\/chat\/completions$/.test(base)) return base;
  return base + '/chat/completions';
}

function httpMessage(status) {
  if (status === 401 || status === 403) return 'API Key 无效或没有权限';
  if (status === 404) return '接口地址或模型名不存在';
  if (status === 402) return '账户余额不足';
  if (status === 429) return '触发限流，请降低并发或稍后重试';
  if (status >= 500) return '服务端错误';
  return '接口返回 ' + status;
}

export async function chat(opts) {
  const {
    baseUrl,
    apiKey,
    model,
    messages,
    temperature = 0.2,
    maxTokens = 2048,
    timeoutMs = 60000
  } = opts || {};

  if (!apiKey) throw new ApiError('还没有配置 API Key', 0, '');
  if (!model) throw new ApiError('还没有配置模型名', 0, '');

  const url = endpointOf(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, timeoutMs));

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
        stream: false
      }),
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      throw new ApiError('请求超时（' + Math.round(timeoutMs / 1000) + 's）', 0, '');
    }
    throw new ApiError('网络请求失败：' + (err && err.message ? err.message : String(err)), 0, '');
  }
  clearTimeout(timer);

  const raw = await res.text();
  if (!res.ok) {
    throw new ApiError(httpMessage(res.status), res.status, raw.slice(0, 400));
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ApiError('接口返回的不是合法 JSON', res.status, raw.slice(0, 300));
  }

  const content = data && data.choices && data.choices[0] && data.choices[0].message
    ? data.choices[0].message.content
    : null;

  if (typeof content !== 'string') {
    throw new ApiError('返回结构里没有 choices[0].message.content', res.status, raw.slice(0, 300));
  }
  return content;
}
