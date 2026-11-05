// Local TXT / Markdown adapter. Produces escaped XHTML for the existing sanitizer;
// raw HTML and remote images never become active content.
export const TEXT_LIMITS = { bytes: 16 * 1024 * 1024, chars: 8 * 1024 * 1024, lines: 100000, blocks: 20000, sectionChars: 24000 };
export function textFormat(name) {
  if (/\.(md|markdown)$/i.test(name || '')) return 'markdown';
  if (/\.(txt|text|log)$/i.test(name || '')) return 'txt';
  return '';
}
function failure(code, message) { return Object.assign(new Error(message), { code }); }
export function decodeText(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > TEXT_LIMITS.bytes) throw failure('too_large', '纯文本文档最大支持 16 MB。');
  let text;
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
    else {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
    }
  } catch { throw failure('invalid_text', '无法解码文档，请另存为 UTF-8 文本后再导入。'); }
  if (text.length > TEXT_LIMITS.chars) throw failure('too_large', '文本文档内容过大，请分成多个文件。');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) throw failure('invalid_text', '文件包含二进制内容，不是可读取的文本文档。');
  return text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n');
}
function escape(text) { return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function inline(text, depth = 0) {
  if (depth > 6) return escape(text);
  const tokens = /(`[^`\n]+`|!?\[[^\[\]\n]*\]\([^\s)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|~~[^~\n]+~~)/g;
  let out = '', last = 0;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    out += escape(text.slice(last, match.index));
    last = match.index + token.length;
    if (token[0] === '`') out += '<code>' + escape(token.slice(1, -1)) + '</code>';
    else if (/^!?\[/.test(token)) {
      const link = /^(!?)\[([^\]]*)\]\(([^)]+)\)$/.exec(token);
      const label = inline(link[2], depth + 1), href = link[3];
      if (link[1]) out += '<span>[' + label + ']</span>'; // Single-file imports do not fetch image URLs.
      else if (/^(?:https?:\/\/|mailto:|#)/i.test(href)) out += '<a href="' + escape(href) + '">' + label + '</a>';
      else out += label;
    } else {
      const size = /^(?:\*\*|__|~~)/.test(token) ? 2 : 1;
      const tag = token.startsWith('~~') ? 's' : size === 2 ? 'strong' : 'em';
      out += '<' + tag + '>' + inline(token.slice(size, -size), depth + 1) + '</' + tag + '>';
    }
  }
  return out + escape(text.slice(last));
}

function markdownBlocks(text) {
  const lines = text.split('\n'), blocks = [];
  let paragraph = [], fence = null, code = [], list = null;
  const anchors = new Map();
  const flush = () => { if (paragraph.length) { blocks.push({ html: '<p>' + inline(paragraph.join('\n')) + '</p>' }); paragraph = []; } };
  const closeList = () => { if (list) { blocks.push({ html: '<' + list.tag + '>' + list.items.join('') + '</' + list.tag + '>' }); list = null; } };
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, '|'));
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) {
        blocks.push({ html: '<pre><code>' + escape(code.join('\n')) + '</code></pre>' }); fence = null; code = [];
      } else code.push(line);
      continue;
    }
    if (marker) { flush(); closeList(); fence = marker[1]; continue; }
    if (!line.trim()) { flush(); closeList(); continue; }
    if (line.includes('|') && lines[lineIndex + 1] && cells(lines[lineIndex + 1]).every(s => /^:?-{3,}:?$/.test(s))) {
      flush(); closeList();
      const header = cells(line);
      if (header.length > 64) throw failure('too_large', 'Markdown 表格列数过多。');
      let table = '<table><thead><tr>' + header.map(s => '<th>' + inline(s) + '</th>').join('') + '</tr></thead><tbody>';
      lineIndex += 1;
      while (lines[lineIndex + 1]?.trim() && lines[lineIndex + 1].includes('|')) {
        const row = cells(lines[++lineIndex]);
        table += '<tr>' + header.map((_, i) => '<td>' + inline(row[i] || '') + '</td>').join('') + '</tr>';
      }
      blocks.push({ html: table + '</tbody></table>' });
      continue;
    }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      flush(); closeList();
      const title = heading[2];
      const slug = title.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s+/g, '-') || 'heading';
      const count = anchors.get(slug) || 0; anchors.set(slug, count + 1);
      const id = slug + (count ? '-' + count : '');
      blocks.push({ title, id, html: '<h' + heading[1].length + ' id="' + id + '">' + inline(title) + '</h' + heading[1].length + '>' });
      continue;
    }
    if (/^ {0,3}(?:---+|\*\*\*+|___+)\s*$/.test(line)) { flush(); closeList(); blocks.push({ html: '<hr/>' }); continue; }
    const item = /^\s*(?:([-+*])|\d+[.)])\s+(.+)$/.exec(line);
    if (item) {
      flush(); const tag = item[1] ? 'ul' : 'ol';
      if (list && list.tag !== tag) closeList();
      if (!list) list = { tag, items: [] };
      list.items.push('<li>' + inline(item[2]) + '</li>'); continue;
    }
    closeList();
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { flush(); blocks.push({ html: '<blockquote><p>' + inline(quote[1]) + '</p></blockquote>' }); continue; }
    paragraph.push(line);
  }
  flush(); closeList();
  if (fence) blocks.push({ html: '<pre><code>' + escape(code.join('\n')) + '</code></pre>' });
  return blocks;
}

export function parseTextDocument(input, { name = 'document.txt', format = textFormat(name) } = {}) {
  if (!['txt', 'markdown'].includes(format)) throw failure('unsupported_text', '请选择 TXT 或 Markdown 文档。');
  const text = decodeText(input);
  if (!text.trim()) throw failure('empty_text', '这个文档没有可阅读的文字。');
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n' && ++lines > TEXT_LIMITS.lines)
    throw failure('too_large', '文档行数过多，请拆分后再导入。');
  const filename = String(name).replace(/\.[^.]+$/, '') || '未命名文档';
  const blocks = format === 'markdown' ? markdownBlocks(text) : text.split(/\n[ \t]*\n/).filter(s => s.trim()).flatMap(s => {
    const out = [];
    for (let i = 0; i < s.length; i += 6000) out.push({ html: '<p>' + escape(s.slice(i, i + 6000)).replace(/\n/g, '<br/>') + '</p>' });
    return out;
  });
  if (blocks.length > TEXT_LIMITS.blocks) throw failure('too_large', '文档段落过多，请拆分后再导入。');
  const sections = [], toc = [];
  let html = '', title = filename;
  function finish() {
    if (!html) return;
    const index = sections.length, href = 'text/section-' + index + '.xhtml', id = 'text:' + index, content = html;
    sections.push({ id, index, href, title, load: () => ({ html: '<html><body>' + content + '</body></html>', baseHref: href }) });
    html = '';
  }
  for (const block of blocks) {
    if (html && (block.title || html.length + block.html.length > TEXT_LIMITS.sectionChars)) finish();
    if (block.title) title = block.title;
    if (block.title) toc.push({ title: block.title, href: 'text/section-' + sections.length + '.xhtml#' + block.id,
      sectionHref: 'text/section-' + sections.length + '.xhtml', children: [] });
    html += block.html;
  }
  finish();
  const indexedToc = new Set(toc.map(item => item.sectionHref));
  for (const section of sections) if (!indexedToc.has(section.href))
    toc.push({ title: sections.length > 1 ? section.title + ' · ' + (section.index + 1) : section.title,
      href: section.href, sectionHref: section.href, children: [] });
  const order = new Map(sections.map(section => [section.href, section.index]));
  toc.sort((a, b) => order.get(a.sectionHref) - order.get(b.sectionHref));
  return { id: '', format, metadata: { title: format === 'markdown' && blocks.find(b => b.title)?.title || filename, authors: [], language: '' },
    cover: null, sections, toc, getResource: () => null,
    resolveHref(href, base) {
      let fragment = String(href).split('#')[1] || '';
      try { fragment = decodeURIComponent(fragment); } catch { /* keep malformed fragments inert */ }
      let anchor = null;
      anchor = toc.find(item => item.href.endsWith('#' + fragment));
      const section = sections.find(s => s.href === (anchor?.sectionHref || String(href).split('#')[0])) || sections.find(s => s.href === base);
      return section ? { sectionHref: section.href, sectionId: section.id, fragment } : null;
    }
  };
}
