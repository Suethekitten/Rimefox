// EPUB XHTML → 安全 DOM。所有不可信标签/属性在这里丢弃，reader 不把原始 HTML 写入 innerHTML。
// 这里只依赖调用方传入的 document / DOMParser；Node 测试可只测纯 allowlist 辅助函数。
const BLOCK = new Set(['p','div','section','article','header','footer','main','aside','h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote','figure','figcaption','table','thead','tbody','tfoot','tr','td','th','dl','dt','dd','pre','hr']);
const INLINE = new Set(['span','b','strong','i','em','u','s','strike','del','ins','sup','sub','small','code','br','img','a']);
const ALLOWED = new Set([...BLOCK, ...INLINE]);
const VOID = new Set(['br','img','hr']);
const DROP_SUBTREE = new Set(['script','style','iframe','object','embed','form','input','button','select','textarea','link','meta','svg','math','audio','video','source','track','canvas']);
const SAFE_ATTR = new Set(['id','title','lang','dir','colspan','rowspan','scope','headers']);
const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif' };

function localName(el) {
  return String(el && (el.localName || el.tagName || '')).toLowerCase().replace(/^.*:/, '');
}
function attr(el, name) {
  if (!el || !el.getAttribute) return '';
  return el.getAttribute(name) || el.getAttribute(name.replace(/^.*:/, '')) || '';
}
function resolvePath(base, href) {
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
    if (part === '..') { if (!out.length) return ''; out.pop(); }
    else out.push(part);
  }
  return out.join('/');
}
function mimeOf(path) {
  const ext = String(path || '').split('.').pop().toLowerCase();
  return IMAGE_TYPES[ext] || '';
}
function makeBlob(doc, bytes, type) {
  const view = doc.defaultView || (typeof window !== 'undefined' ? window : null);
  if (!view || !view.Blob || !view.URL || !view.URL.createObjectURL) return '';
  return view.URL.createObjectURL(new view.Blob([bytes], { type: type || 'application/octet-stream' }));
}

/**
 * @param {string} html
 * @param {{baseHref:string, book:object, document:Document, DOMParser?:Function, assets?:Map<string,string>}} opts
 */
export function sanitizeXhtml(html, opts) {
  const doc = opts.document;
  const Parser = opts.DOMParser || doc.defaultView && doc.defaultView.DOMParser || globalThis.DOMParser;
  if (!Parser) throw new Error('DOMParser is not available');
  let source = null;
  try {
    source = new Parser().parseFromString(String(html || ''), 'application/xhtml+xml');
    if (source.getElementsByTagName('parsererror').length) source = null;
  } catch (err) {
    source = null;
  }
  if (!source) {
    source = new Parser().parseFromString(String(html || ''), 'text/html');
  }
  const fragment = doc.createDocumentFragment();
  const assets = opts.assets || new Map();
  const notes = new Map();
  const sourceRoot = source.body || source.documentElement;
  if (!sourceRoot) return { fragment, assets, notes };

  function copyText(value, parent) {
    const text = String(value == null ? '' : value);
    if (text) parent.appendChild(doc.createTextNode(text));
  }

  function copyChildren(from, to) {
    for (const child of Array.from(from.childNodes || [])) walk(child, to);
  }

  function image(node, parent) {
    const src = attr(node, 'src');
    const path = resolvePath(opts.baseHref, src);
    const type = mimeOf(path);
    const bytes = path && type && opts.book && opts.book.getResource ? opts.book.getResource(path) : null;
    const img = doc.createElement('img');
    img.setAttribute('alt', attr(node, 'alt'));
    img.setAttribute('loading', 'lazy');
    if (bytes && type) {
      let url = assets.get(path);
      if (!url) {
        url = makeBlob(doc, bytes, type);
        if (url) assets.set(path, url);
      }
      if (url) img.src = url;
    }
    if (!img.getAttribute('src')) img.setAttribute('data-reader-missing-image', '1');
    parent.appendChild(img);
  }

  function link(node, parent) {
    const href = String(attr(node, 'href') || '').trim();
    const a = doc.createElement('a');
    if (!href || /^javascript:/i.test(href) || /^data:/i.test(href)) {
      copyChildren(node, a);
      parent.appendChild(a);
      return;
    }
    const hash = href.indexOf('#') >= 0 ? href.slice(href.indexOf('#')) : '';
    const target = href.charAt(0) === '#'
      ? { sectionHref: opts.baseHref, fragment: href.slice(1), sectionId: '' }
      : (opts.book && opts.book.resolveHref ? opts.book.resolveHref(href, opts.baseHref) : null);
    if (target && (target.sectionHref || target.fragment)) {
      a.setAttribute('href', hash || '#');
      a.setAttribute('data-reader-target', target.sectionHref || opts.baseHref);
      a.setAttribute('data-reader-fragment', target.fragment || '');
      if (target.sectionId) a.setAttribute('data-reader-section', target.sectionId);
      if (attr(node, 'epub:type') === 'noteref' || /noteref/.test(attr(node, 'class'))) a.setAttribute('data-reader-note', '1');
    } else {
      a.setAttribute('href', href);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
    if (attr(node, 'title')) a.setAttribute('title', attr(node, 'title'));
    copyChildren(node, a);
    parent.appendChild(a);
  }

  function walk(node, parent) {
    if (!node) return;
    if (node.nodeType === 3) {
      copyText(node.nodeValue, parent);
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = localName(node);
    if (DROP_SUBTREE.has(tag)) return;
    if (tag === 'img') { image(node, parent); return; }
    if (tag === 'a') { link(node, parent); return; }
    const target = ALLOWED.has(tag) ? doc.createElement(tag) : doc.createDocumentFragment();
    if (ALLOWED.has(tag)) {
      for (const attribute of Array.from(node.attributes || [])) {
        const name = attribute.name || '';
        const value = attribute.value || '';
        const key = String(name).toLowerCase();
        if (key === 'href' || key === 'src' || key === 'style' || key.indexOf('on') === 0) continue;
        if (SAFE_ATTR.has(key) || key === 'colspan' || key === 'rowspan' || key === 'scope' || key === 'headers') {
          try { target.setAttribute(key, String(value)); } catch (err) { /* ignore */ }
        }
      }
      if (tag === 'pre' || tag === 'code') target.setAttribute('data-dt-ui', '1');
    }
    copyChildren(node, target);
    if (ALLOWED.has(tag)) parent.appendChild(target);
    else {
      while (target.firstChild) parent.appendChild(target.firstChild);
    }
  }

  copyChildren(sourceRoot, fragment);
  // 空段落 / 只有空白的块不渲染。
  for (const el of Array.from(fragment.querySelectorAll ? fragment.querySelectorAll('*') : [])) {
    if (BLOCK.has(localName(el)) && !String(el.textContent || '').trim() && !el.querySelector('img, table, hr, br')) {
      try { el.remove(); } catch (err) { /* ignore */ }
    }
  }
  return { fragment, assets, notes };
}

export const READER_ALLOWED_TAGS = Array.from(ALLOWED);
export const READER_DROP_TAGS = Array.from(DROP_SUBTREE);
