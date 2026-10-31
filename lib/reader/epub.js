// EPUB 2/3 解析：ZIP → container.xml → OPF → spine / metadata / TOC。
// 只做结构解析与资源读取；XHTML 清洗在 sanitize.js，DOM 渲染在 reader.js。
// 输入一律视为不可信文件：限制单条/总量/压缩比，拒绝路径穿越和加密内容。
import { unzipSync } from '../vendor/fflate.browser.mjs';

export const EPUB_LIMITS = Object.freeze({
  maxEntryBytes: 24 * 1024 * 1024,
  maxTotalBytes: 320 * 1024 * 1024,
  maxCompressionRatio: 180
});

export class EpubError extends Error {
  constructor(code, message) {
    super(message || code);
    this.name = 'EpubError';
    this.code = code;
  }
}

const UTF8 = new TextDecoder('utf-8');

function decodeName(name) {
  try { return decodeURIComponent(name); } catch (err) { return name; }
}

function safeName(name) {
  const raw = String(name || '').replace(/\\/g, '/');
  if (!raw || raw.startsWith('/') || /(^|\/).\.(\/|$)/.test(raw) || raw.indexOf('\u0000') >= 0) {
    throw new EpubError('unsafe_archive', 'EPUB contains an unsafe path');
  }
  return decodeName(raw);
}

function normalizePath(base, href) {
  const raw = String(href || '').split('#')[0].split('?')[0];
  if (!raw) return '';
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch (err) { decoded = raw; }
  if (decoded.startsWith('/')) decoded = decoded.slice(1);
  const baseDir = String(base || '').split('/').slice(0, -1).join('/');
  const parts = (baseDir ? baseDir + '/' : '').concat(decoded).split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!out.length) throw new EpubError('unsafe_archive', 'EPUB path escapes root');
      out.pop();
    } else out.push(part);
  }
  return out.join('/');
}

function splitHref(href) {
  const s = String(href || '');
  const hash = s.indexOf('#');
  return {
    path: normalizePath('', hash >= 0 ? s.slice(0, hash) : s),
    fragment: hash >= 0 ? s.slice(hash + 1) : ''
  };
}

function localName(el) {
  return String(el && (el.localName || el.tagName || '')).toLowerCase().replace(/^.*:/, '');
}

function attr(el, name) {
  if (!el || !el.getAttribute) return '';
  return el.getAttribute(name) || el.getAttribute(name.replace(/^.*:/, '')) || '';
}

function elements(root, name) {
  const want = String(name).toLowerCase();
  return Array.from(root.getElementsByTagName('*')).filter((el) => localName(el) === want);
}

function first(root, name) {
  return elements(root, name)[0] || null;
}

function textOf(el) {
  return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
}

function parseXml(text, DOMParserCtor, type) {
  if (!DOMParserCtor) throw new EpubError('corrupt_epub', 'DOMParser is not available');
  const doc = new DOMParserCtor().parseFromString(String(text || ''), type || 'application/xml');
  const errors = doc.getElementsByTagName('parsererror');
  if (errors && errors.length) throw new EpubError('corrupt_epub', 'Invalid XML');
  return doc;
}

function resolveTocHref(base, href) {
  const split = splitHref(href);
  return { sectionHref: split.path ? normalizePath(base, split.path) : normalizePath('', base), fragment: split.fragment };
}

function collectNavPoints(navRoot, base) {
  const out = [];
  const points = elements(navRoot, 'navPoint');
  for (const point of points) {
    const label = first(point, 'navLabel');
    const content = first(point, 'content');
    const href = attr(content, 'src');
    if (!href) continue;
    const item = {
      title: textOf(label) || 'Untitled',
      href: href,
      sectionHref: resolveTocHref(base, href).sectionHref,
      children: []
    };
    out.push(item);
  }
  // NCX 的 navPoint 可能是嵌套的；用 DOM 父级恢复树，而不是上面的平铺列表。
  const byEl = new Map(out.map((x) => [x, null]));
  const ordered = [];
  const rootMap = first(navRoot, 'navMap');
  function walk(parentEl, list) {
    if (!parentEl) return;
    for (const child of Array.from(parentEl.children || [])) {
      if (localName(child) !== 'navpoint') continue;
      const label = first(child, 'navLabel');
      const content = first(child, 'content');
      const href = attr(content, 'src');
      if (!href) continue;
      const item = {
        title: textOf(label) || 'Untitled',
        href: href,
        sectionHref: resolveTocHref(base, href).sectionHref,
        children: []
      };
      list.push(item);
      walk(child, item.children);
    }
  }
  if (rootMap) walk(rootMap, ordered);
  return ordered.length ? ordered : out.map((x) => ({ title: x.title, href: x.href, sectionHref: x.sectionHref, children: [] }));
}

function parseNavToc(navDoc, navBase) {
  const navs = elements(navDoc, 'nav');
  let nav = navs.find((one) => /(?:^|\s)toc(?:\s|$)/i.test(attr(one, 'type') + ' ' + attr(one, 'epub:type')));
  if (!nav) nav = navs.find((one) => /doc-toc/i.test(attr(one, 'role')));
  if (!nav) nav = navs[0];
  if (!nav) return [];
  function walk(listEl) {
    const out = [];
    for (const child of Array.from(listEl.children || [])) {
      if (localName(child) !== 'li') continue;
      const link = Array.from(child.children || []).find((x) => localName(x) === 'a') || first(child, 'a');
      if (!link) continue;
      const href = attr(link, 'href');
      if (!href) continue;
      const item = {
        title: textOf(link) || 'Untitled',
        href: href,
        sectionHref: resolveTocHref(navBase, href).sectionHref,
        children: []
      };
      const nested = Array.from(child.children || []).find((x) => localName(x) === 'ol' || localName(x) === 'ul');
      if (nested) item.children = walk(nested);
      out.push(item);
    }
    return out;
  }
  const list = Array.from(nav.children || []).find((x) => localName(x) === 'ol' || localName(x) === 'ul');
  return list ? walk(list) : [];
}

function flattenToc(items, out) {
  out = out || [];
  for (const item of items || []) {
    out.push(item);
    flattenToc(item.children, out);
  }
  return out;
}

/**
 * @param {ArrayBuffer|Uint8Array} input
 * @param {{DOMParser?: Function, TextDecoder?: Function}} [opts]
 */
export function parseEpub(input, opts = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const DOMParserCtor = opts.DOMParser || globalThis.DOMParser;
  let files;
  let total = 0;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        const name = String(file.name || '');
        if (!name || name.endsWith('/')) return false;
        safeName(name);
        if (file.originalSize > EPUB_LIMITS.maxEntryBytes) throw new EpubError('too_large', 'EPUB entry is too large');
        total += file.originalSize;
        if (total > EPUB_LIMITS.maxTotalBytes) throw new EpubError('too_large', 'EPUB expands beyond the limit');
        if (file.size > 0 && file.originalSize / file.size > EPUB_LIMITS.maxCompressionRatio) {
          throw new EpubError('unsafe_archive', 'EPUB compression ratio is unsafe');
        }
        return true;
      }
    });
  } catch (err) {
    if (err instanceof EpubError) throw err;
    throw new EpubError('not_epub', 'This file is not a readable EPUB');
  }
  const entries = Object.create(null);
  for (const key of Object.keys(files || {})) {
    const name = safeName(key);
    if (!entries[name]) entries[name] = files[key];
  }
  function get(name) {
    const key = normalizePath('', name);
    return entries[key] || entries[decodeName(key)] || null;
  }
  function text(name) {
    const data = get(name);
    if (!data) throw new EpubError('missing_content', 'EPUB resource is missing: ' + name);
    return (opts.TextDecoder ? new opts.TextDecoder('utf-8') : UTF8).decode(data);
  }

  if (get('META-INF/rights.xml')) {
    throw new EpubError('drm_protected', 'EPUB has Adobe DRM rights');
  }
  if (get('META-INF/encryption.xml')) {
    const encryptionDoc = parseXml(text('META-INF/encryption.xml'), DOMParserCtor, 'application/xml');
    const refs = elements(encryptionDoc, 'CipherReference').map((el) => attr(el, 'URI') || attr(el, 'uri')).filter(Boolean);
    const fontOnly = refs.length > 0 && refs.every((uri) => /\.(?:otf|ttf|woff2?|eot)(?:[?#]|$)/i.test(String(uri)));
    // 字体混淆（IDPF / Adobe）不是访问控制；本版不加载出版字体，允许正文继续用回退字体。
    // 其它被加密的资源（正文、图片、LCP license 等）一律拒绝，不做 DRM 绕过。
    if (!fontOnly) throw new EpubError('drm_protected', 'EPUB has encrypted non-font resources');
  }
  const container = get('META-INF/container.xml');
  if (!container) throw new EpubError('not_epub', 'EPUB container.xml is missing');
  const containerDoc = parseXml(text('META-INF/container.xml'), DOMParserCtor, 'application/xml');
  const rootfile = first(containerDoc, 'rootfile');
  const opfPath = rootfile && normalizePath('', attr(rootfile, 'full-path'));
  if (!opfPath) throw new EpubError('corrupt_epub', 'EPUB package path is missing');
  const opfDoc = parseXml(text(opfPath), DOMParserCtor, 'application/xml');

  const metadataEl = first(opfDoc, 'metadata');
  const meta = (name) => first(metadataEl || opfDoc, name);
  const metadata = {
    title: textOf(meta('title')) || 'Untitled',
    authors: elements(metadataEl || opfDoc, 'creator').map(textOf).filter(Boolean),
    language: textOf(meta('language')) || '',
    publisher: textOf(meta('publisher')) || '',
    description: textOf(meta('description')) || '',
    identifier: textOf(meta('identifier')) || ''
  };
  const renditionMeta = elements(metadataEl || opfDoc, 'meta').find((el) => /rendition:layout/i.test(attr(el, 'property') + ' ' + attr(el, 'name')));
  if (renditionMeta && /pre-paginated/i.test(textOf(renditionMeta) + ' ' + attr(renditionMeta, 'content'))) {
    throw new EpubError('unsupported_layout', 'Fixed-layout EPUB is not supported');
  }
  const fixedMeta = elements(metadataEl || opfDoc, 'meta').find((el) => /fixed-layout/i.test(attr(el, 'name') + ' ' + attr(el, 'property')));
  if (fixedMeta && /true|yes|1/i.test(textOf(fixedMeta) + ' ' + attr(fixedMeta, 'content'))) {
    throw new EpubError('unsupported_layout', 'Fixed-layout EPUB is not supported');
  }

  const opfBase = opfPath;
  const manifest = new Map();
  for (const item of elements(opfDoc, 'item')) {
    const id = attr(item, 'id');
    const href = attr(item, 'href');
    if (!id || !href) continue;
    const path = normalizePath(opfBase, href);
    manifest.set(id, {
      id,
      href: path,
      mediaType: attr(item, 'media-type'),
      properties: attr(item, 'properties').split(/\s+/).filter(Boolean)
    });
  }
  const spineEl = first(opfDoc, 'spine');
  const spine = elements(spineEl || opfDoc, 'itemref').map((item) => attr(item, 'idref')).filter((id) => manifest.has(id));
  if (!spine.length) throw new EpubError('corrupt_epub', 'EPUB spine is empty');
  const spineItems = spine.map((idref, index) => {
    const item = manifest.get(idref);
    return { index, item, href: item.href };
  });
  const hrefToSection = new Map();
  const sections = spineItems.map(({ index, item, href }) => {
    const sec = {
      id: 's' + (index + 1),
      title: item.id,
      href,
      index,
      load() {
        return { kind: 'xhtml', html: text(href), baseHref: href };
      }
    };
    hrefToSection.set(href, sec);
    return sec;
  });

  function findNav() {
    for (const item of manifest.values()) if (item.properties.indexOf('nav') >= 0) return item;
    return null;
  }
  const navItem = findNav();
  const ncxItem = Array.from(manifest.values()).find((x) => x.mediaType === 'application/x-dtbncx+xml') ||
    (spineEl && manifest.get(attr(spineEl, 'toc'))) || null;
  let toc = [];
  if (navItem) {
    try {
      toc = parseNavToc(parseXml(text(navItem.href), DOMParserCtor, 'application/xhtml+xml'), navItem.href);
    } catch (err) { toc = []; }
  }
  if (!toc.length && ncxItem) {
    try {
      toc = collectNavPoints(parseXml(text(ncxItem.href), DOMParserCtor, 'application/xml'), ncxItem.href);
    } catch (err) { toc = []; }
  }
  if (!toc.length) toc = sections.map((sec) => ({ title: sec.title, href: sec.href, sectionHref: sec.href, children: [] }));
  const tocFlat = flattenToc(toc);
  for (const item of tocFlat) {
    const sec = hrefToSection.get(item.sectionHref);
    if (sec && item.title) sec.title = item.title;
  }

  let cover = null;
  const coverItem = Array.from(manifest.values()).find((x) => x.properties.indexOf('cover-image') >= 0);
  const coverMeta = elements(metadataEl || opfDoc, 'meta').find((x) => attr(x, 'name') === 'cover');
  const coverId = coverMeta ? attr(coverMeta, 'content') : '';
  const coverFromId = coverId ? manifest.get(coverId) : null;
  const chosenCover = coverItem || coverFromId;
  if (chosenCover) {
    const data = get(chosenCover.href);
    if (data) cover = { bytes: data, mediaType: chosenCover.mediaType || 'image/jpeg', href: chosenCover.href };
  }

  function resolveHref(href, base) {
    const split = splitHref(href);
    const full = split.path ? normalizePath(base || opfBase, split.path) : '';
    return { sectionHref: full, fragment: split.fragment, sectionId: (hrefToSection.get(full) || {}).id || '' };
  }

  return {
    id: '',
    format: 'epub',
    metadata,
    cover,
    toc,
    sections,
    resolveHref,
    getResource(path) { return get(path); },
    getResourceText(path) { return text(path); },
    opfPath,
    limits: EPUB_LIMITS
  };
}
