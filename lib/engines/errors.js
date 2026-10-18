// 各引擎共用的错误类型与 HTTP 状态文案
// 纯模块：不读 window、不发请求，可以被 node 直接 import 做单测

export class ApiError extends Error {
  constructor(message, status, detail) {
    super(message);
    this.name = 'ApiError';
    this.status = status || 0;
    this.detail = detail || '';
  }
}

export function httpMessage(status) {
  if (status === 401 || status === 403) return 'API Key 无效或没有权限';
  if (status === 404) return '接口地址或模型名不存在';
  if (status === 402) return '账户余额不足';
  if (status === 429) return '触发限流，请降低并发或稍后重试';
  if (status >= 500) return '服务端错误';
  return '接口返回 ' + status;
}

// 从各种形状的错误体里抠出人话；抠不到就返回空串
export function extractMessage(bodyText) {
  const text = String(bodyText || '');
  try {
    const json = JSON.parse(text);
    const err = json && json.error;
    if (err && typeof err === 'string') return err;
    if (err && typeof err === 'object') return String(err.message || err.msg || err.type || '');
    if (json && typeof json.message === 'string') return json.message;
  } catch (err) {
    /* 不是 JSON：可能是网关返回的 HTML，下面按纯文本处理 */
  }
  return '';
}
