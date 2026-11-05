// 扩展页面（PDF 阅读器 / 设置页）使用的 OCR 帮助函数：只经后台的可信路由，不直接连接本地组件。
// 用法见 docs/OCR-INTERFACE.md §6。
import { OcrError, splitDataUrl } from './protocol.js';

export const OCR_SETTINGS_HASH = '#sec-ocr';
export const OCR_PERMISSION = 'nativeMessaging';

async function call(message) {
  const res = await chrome.runtime.sendMessage(message);
  if (!res || !res.ok) throw new OcrError((res && res.errorCode) || 'error', (res && res.error) || 'OCR 请求失败');
  return res;
}

// → { choice, status, backend, reason, backends, sources, checkedAt }
export async function getOcrStatus({ refresh } = {}) {
  return (await call({ type: 'ocr:status', refresh: refresh === true })).ocr;
}

// canvas：已渲染好的页面画布（HTMLCanvasElement 或 OffscreenCanvas 均可）。
// → { backend, engine, fallback, durationMs, lines: [{ text, confidence, box }] }
export async function recognizeCanvas(canvas, { jobId, languages, device, mime } = {}) {
  const type = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  let url;
  if (typeof canvas.convertToBlob === 'function') {
    const blob = await canvas.convertToBlob({ type });
    url = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } else {
    url = canvas.toDataURL(type);
  }
  const { mime: m, data } = splitDataUrl(url);
  const image = { mime: m, data, width: canvas.width, height: canvas.height };
  return (await call({ type: 'ocr:recognize', image, languages, jobId, device })).result;
}

export async function cancelOcr(jobId) {
  return (await call({ type: 'ocr:cancel', jobId: String(jobId) })).cancelled === true;
}

// 必须在用户手势（点击）里调用；manifest 须在 optional_permissions 声明 nativeMessaging。
// 返回是否已授权。拒绝时不抛错，调用方显示 permission_needed 状态即可。
export async function requestOcrPermission() {
  try {
    return await chrome.permissions.request({ permissions: [OCR_PERMISSION] });
  } catch (err) {
    return false;
  }
}

export async function hasOcrPermission() {
  try {
    return await chrome.permissions.contains({ permissions: [OCR_PERMISSION] });
  } catch (err) {
    return false;
  }
}

// 从阅读器等页面打开设置页的 OCR 区块。设置页已打开时浏览器会新开一个标签页，这是有意的简单实现。
export function openOcrSettings() {
  return chrome.tabs.create({ url: chrome.runtime.getURL('options/index.html' + OCR_SETTINGS_HASH) });
}
