// Bilibili 字幕 CDN 白名单：只接受官方 HTTPS 字幕资源。
// 后台取字幕文本前、内容脚本把 URL 交给后台前都校验；两处实现由 test/bilibili-subtitles.test.mjs 做差分。
export function isTrustedBilibiliSubtitleUrl(value) {
  let u;
  try {
    u = new URL(String(value || ''), 'https://www.bilibili.com');
  } catch (err) {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  const host = String(u.hostname || '').toLowerCase();
  const path = String(u.pathname || '');
  if (host === 'aisubtitle.hdslb.com' && /^\/bfs\/(ai_)?subtitle\//.test(path)) return true;
  if (/^i[0-9]\.hdslb\.com$/.test(host) && /^\/bfs\/subtitle\//.test(path)) return true;
  return false;
}

export function isBilibiliVideoPage(value) {
  try {
    const u = new URL(String(value || ''));
    if (u.hostname.toLowerCase() !== 'www.bilibili.com') return false;
    return /^\/(?:[A-Za-z]{2}(?:-[A-Za-z]+)?\/)?video\/(BV[0-9A-Za-z]+|av\d+)/i.test(u.pathname);
  } catch (err) {
    return false;
  }
}

export const SUBTITLE_FETCH_MAX_BYTES = 2 * 1024 * 1024;

// 流式读文本并限制字节数：没有 content-length 的响应不能先整个读进内存再判大小
// （V13：异常 / 恶意的大回包会在 service worker 里撑爆内存）。
export async function readTextCapped(res, maxBytes) {
  const limit = Number(maxBytes) || SUBTITLE_FETCH_MAX_BYTES;
  const body = res && res.body;
  if (!body || typeof body.getReader !== 'function') {
    // 环境没有流（或测试替身只有 arrayBuffer）：退回整读，仍按上限拒绝
    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength > limit) return { ok: false, error: 'too_large' };
    return { ok: true, text: new TextDecoder().decode(buf) };
  }
  const reader = body.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      const value = step.value;
      received += value.byteLength;
      if (received > limit) {
        try { await reader.cancel(); } catch (err) { /* 取消失败不影响结论 */ }
        return { ok: false, error: 'too_large' };
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch (err) { /* 已 release 时忽略 */ }
  }
  const buf = new Uint8Array(received);
  let offset = 0;
  chunks.forEach((chunk) => {
    buf.set(chunk, offset);
    offset += chunk.byteLength;
  });
  return { ok: true, text: new TextDecoder().decode(buf) };
}