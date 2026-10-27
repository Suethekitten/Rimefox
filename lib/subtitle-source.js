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