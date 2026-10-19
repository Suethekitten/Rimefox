// 各引擎拉模型列表共用的一次 GET：带超时，把超时 / 网络错误 / 非 2xx / 坏 JSON 统一成 ApiError。
// 以前三个引擎各写一份，已经开始不一致；以后改超时或报错只改这里。
// notOk(status, raw)：非 2xx 时由引擎给出错误（各家说法不同，有的 404 表示「不提供模型列表」）
import { ApiError } from './errors.js';

export async function fetchModelList(url, headers, timeoutMs, notOk) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let raw;
  try {
    res = await fetch(url, { headers, signal: controller.signal });
    raw = await res.text();
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new ApiError('获取模型列表超时（' + Math.round(timeoutMs / 1000) + 's）', 0, '');
    }
    throw new ApiError('网络请求失败：' + (err && err.message ? err.message : String(err)), 0, '');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw notOk(res.status, raw);

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ApiError('模型列表不是合法 JSON', res.status, raw.slice(0, 300));
  }
}
