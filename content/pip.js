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

  var CSS = [
    ':root{color-scheme:light dark;--bg:#ffffff;--fg:#14161f;--muted:#6b7285;--line:rgba(20,24,40,.1);--acc:#6a5cf0}',
    '@media (prefers-color-scheme:dark){:root{--bg:#14161f;--fg:#edf0f9;--muted:#a3a9bd;--line:rgba(255,255,255,.12);--acc:#9182ff}}',
    '*{box-sizing:border-box}',
    'html,body{margin:0;height:100%;background:var(--bg);color:var(--fg)}',
    'body{display:flex;flex-direction:column;font:14px/1.6 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}',
    'header{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--line);font-size:12px;color:var(--muted)}',
    'header img{width:16px;height:16px}',
    'header span{flex:1}',
    'button{border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:2px 8px;cursor:pointer}',
    'button:hover{border-color:var(--acc);color:var(--acc)}',
    'main{flex:1;overflow:auto;padding:12px 14px}',
    '.src{margin:0 0 8px;color:var(--muted);font-size:12.5px;white-space:pre-wrap;word-break:break-word}',
    '.out{margin:0;white-space:pre-wrap;word-break:break-word;font-size:15px}',
    '.empty{color:var(--muted);font-size:13px}'
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
    main.appendChild(el(doc, 'p', 'src', entry.source));
    main.appendChild(el(doc, 'p', 'out', entry.result));
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
    header.appendChild(el(doc, 'span', '', DT.uiText('置顶译文', 'Pinned translation')));
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
