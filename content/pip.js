// 置顶翻译窗：把划词译文放进一个始终在最上层的小窗，看 PDF、全屏视频或多窗口阅读时不用来回切。
// 优先用 Document Picture-in-Picture（Chrome 116+，真正置顶）；不支持时退回 window.open 的普通小窗。
// 小窗是空白文档，内容全部由这里用 textContent 写入；样式是我们自己的一段 CSS，不搬网页的样式。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT || DT.__pipReady) return;
  DT.__pipReady = true;
  // 只在顶层页面开：iframe 里的内容脚本也会跑，别每个框架各开一个
  if (window.top !== window) return;

  var win = null;
  var view = null; // { source, result, empty }

  // 和扩展页面同一套冷调玻璃变量（lib/ui-tokens.css 的取值）：画布 / 卡片 / 三级文字
  var CSS = [
    ':root{color-scheme:light dark;--canvas:#f4f6fa;--card:rgba(255,255,255,.86);--fg:#0f172a;--muted:#475569;--weak:#94a3b8;' +
      '--line:rgba(15,23,42,.08);--hi:inset 0 1px 0 rgba(255,255,255,.9);--acc:#6a5cf0}',
    '@media (prefers-color-scheme:dark){:root{--canvas:#090b10;--card:rgba(18,22,33,.8);--fg:#f1f5f9;--muted:#94a3b8;--weak:#64748b;' +
      '--line:rgba(255,255,255,.08);--hi:inset 0 1px 0 rgba(255,255,255,.07);--acc:#8b80f3}}',
    '*{box-sizing:border-box}',
    'html,body{margin:0;height:100%;background:var(--canvas);color:var(--fg)}',
    'body{display:flex;flex-direction:column;font:14px/1.65 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
      'background-image:radial-gradient(600px 260px at 10% -20%,color-mix(in srgb,var(--acc) 9%,transparent),transparent 70%)}',
    'header{position:sticky;top:0;display:flex;align-items:center;gap:8px;height:32px;padding:0 8px 0 10px;border-bottom:1px solid var(--line);' +
      'background:color-mix(in srgb,var(--canvas) 82%,transparent);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);font-size:12px;color:var(--muted)}',
    'header img{width:16px;height:16px;border-radius:4px}',
    '.title{flex:1;min-width:0;font-weight:600;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
    '.lang{padding:0 7px;border-radius:999px;border:1px solid var(--line);color:var(--weak);font:500 10.5px/18px "JetBrains Mono","SF Mono",Consolas,monospace}',
    '.lang:empty{display:none}',
    'button{height:22px;border:1px solid var(--line);border-radius:7px;background:var(--card);box-shadow:var(--hi);color:inherit;font:inherit;font-size:12px;padding:0 9px;cursor:pointer}',
    'button:hover{border-color:color-mix(in srgb,var(--acc) 50%,transparent);color:var(--acc)}',
    'main{flex:1;overflow:auto;padding:12px;scrollbar-width:thin}',
    '.card{padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:var(--card);box-shadow:var(--hi),0 8px 24px -12px rgba(15,23,42,.18)}',
    '.src{margin:0 0 8px;padding-bottom:8px;border-bottom:1px dashed var(--line);color:var(--muted);font-size:12.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word}',
    '.out{margin:0;white-space:pre-wrap;word-break:break-word;font-size:15px;line-height:1.65}',
    '.empty{margin:24px 8px;color:var(--weak);font-size:13px;text-align:center}'
  ].join('\n');

  function supported() {
    return !!window.documentPictureInPicture || typeof window.open === 'function';
  }

  function isOpen() {
    return !!(win && !win.closed);
  }

  function el(doc, tag, cls, text) {
    var node = doc.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function render() {
    if (!isOpen()) return;
    var doc = win.document;
    var main = doc.getElementById('dt-pip-main');
    if (!main) return;
    main.textContent = '';
    var entry = DT.lastSelection;
    if (!entry) {
      main.appendChild(el(doc, 'p', 'empty', DT.uiText('划词翻译的结果会显示在这里：在原网页选中文字并翻译即可。', 'Selection translations will appear here: select text on the page and translate it.')));
      return;
    }
    var card = el(doc, 'div', 'card');
    card.appendChild(el(doc, 'p', 'src', entry.source));
    card.appendChild(el(doc, 'p', 'out', entry.result));
    main.appendChild(card);
    var lang = doc.getElementById('dt-pip-lang');
    if (lang) lang.textContent = (DT.state && ((DT.state.langInfo && DT.state.langInfo.label) || DT.state.target)) || '';
  }

  function build(target) {
    var doc = target.document;
    doc.title = DT.uiText('凛狐 · 置顶译文', 'Rimefox · Pinned translation');
    var style = doc.createElement('style');
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
    // 跟随网页里的强调色
    var accent = document.documentElement.style.getPropertyValue('--dt-accent');
    if (accent) doc.documentElement.style.setProperty('--acc', accent);

    var header = el(doc, 'header');
    var logo = doc.createElement('img');
    logo.alt = '';
    try {
      logo.src = chrome.runtime.getURL('icons/icon32.png');
    } catch (err) {
      logo.hidden = true;
    }
    header.appendChild(logo);
    header.appendChild(el(doc, 'span', 'title', DT.uiText('置顶译文', 'Pinned translation')));
    // 目标语言小胶囊（例如 zh-CN）
    var lang = el(doc, 'span', 'lang', (DT.state && ((DT.state.langInfo && DT.state.langInfo.label) || DT.state.target)) || '');
    lang.id = 'dt-pip-lang';
    header.appendChild(lang);
    var copy = el(doc, 'button', '', DT.uiText('复制', 'Copy'));
    copy.type = 'button';
    copy.addEventListener('click', function () {
      var entry = DT.lastSelection;
      if (!entry) return;
      try {
        target.navigator.clipboard.writeText(entry.result).then(function () {
          copy.textContent = DT.uiText('已复制', 'Copied');
          setTimeout(function () {
            copy.textContent = DT.uiText('复制', 'Copy');
          }, 900);
        });
      } catch (err) {
        /* 剪贴板不可用 */
      }
    });
    header.appendChild(copy);
    doc.body.appendChild(header);
    var main = el(doc, 'main');
    main.id = 'dt-pip-main';
    doc.body.appendChild(main);
    target.addEventListener('pagehide', function () {
      if (win === target) win = null;
    });
  }

  // 必须在用户点击里调用（两种小窗都要用户手势）
  async function open() {
    if (isOpen()) {
      try {
        win.focus();
      } catch (err) {
        /* 有的窗口不让聚焦 */
      }
      render();
      return true;
    }
    var target = null;
    try {
      if (window.documentPictureInPicture && window.documentPictureInPicture.requestWindow) {
        target = await window.documentPictureInPicture.requestWindow({ width: 380, height: 220 });
      }
    } catch (err) {
      DT.log('pip requestWindow failed', err);
      target = null;
    }
    if (!target) {
      try {
        target = window.open('', 'rimefox-pinned', 'popup,width=380,height=240');
      } catch (err) {
        target = null;
      }
      // 网页设置了 COOP 等隔离时拿不到小窗的文档
      try {
        if (target && !target.document) target = null;
      } catch (err) {
        target = null;
      }
    }
    if (!target) {
      DT.toast(DT.uiText('浏览器没有让小窗打开：请允许本网站弹出窗口后再试', 'The browser blocked the window: allow pop-ups for this site and try again'));
      return false;
    }
    win = target;
    // window.open 复用同名窗口时里面可能还有上次的内容：清掉重建
    win.document.body.textContent = '';
    build(win);
    render();
    return true;
  }

  function close() {
    if (isOpen()) win.close();
    win = null;
  }

  if (DT.onSelectionResult) DT.onSelectionResult(render);

  DT.pip = {
    open: open,
    close: close,
    isOpen: isOpen,
    supported: supported,
    // 自检 / 调试用：当前小窗（网页脚本看不到 DT）
    window: function () {
      return isOpen() ? win : null;
    }
  };
})();
