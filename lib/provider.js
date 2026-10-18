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

  // 超时按"多久没收到任何数据"计，不按总时长：
  // DeepSeek 等接口的非流式请求会立刻回响应头，生成期间持续发空行保活，
  // 正文要等整批生成完才来。0.4.2 曾把总超时套在整个响应体上，生成超过 60 秒的批次
  // 全被中止、重试 3 次也不会成功。现在每收到一块数据就重新计时；
  // 另设一个总上限，防止保活不断但永远不出结果的连接一直占着并发名额。
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

  if (!res.ok) {
    throw new ApiError(httpMessage(res.status), res.status, raw.slice(0, 400));
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new ApiError('接口返回的不是合法 JSON', res.status, raw.slice(0, 300));
  }

  const message = data && data.choices && data.choices[0] && data.choices[0].message;
  const content = message ? message.content : null;

  if (typeof content !== 'string') {
    throw new ApiError('返回结构里没有 choices[0].message.content', res.status, raw.slice(0, 300));
  }
  // 带"思考"过程的模型（推理模型）每批都要先想一阵再输出，整页翻译会慢很多倍
  if (opts.meta) {
    const details = data.usage && data.usage.completion_tokens_details;
    opts.meta.reasoning =
      !!(message.reasoning_content || message.reasoning) ||
      !!(details && details.reasoning_tokens > 0);
  }
  return content;
}

// 单个请求的总上限（保活不断但一直不出结果时兜底）
const TOTAL_CAP_MS = 180000;

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
