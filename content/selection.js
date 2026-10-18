// 划词翻译：选中一段文字，在选区下方弹一个小气泡显示译文。
// 独立文件，不依赖 main.js 的调度；只复用 core.js 的 DT.send 与后台缓存。
// 设置项：selectionTranslate（设置页「选中文字后弹出气泡翻译」）。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT) return;
  if (DT.__selectionReady) return; // 允许被重复注入（popup 的 ensure 会再执行一次）
  DT.__selectionReady = true;

  var MAX_CHARS = 800;
  var bubble = null;
  var seq = 0;
  var lastAt = 0;

  // ---------------- 气泡 UI ----------------
  function ensureBubble() {
    if (bubble && bubble.isConnected) return bubble;

    bubble = document.createElement('div');
    bubble.setAttribute('data-dt-ui', '1'); // 让切分 / 观察器忽略它
    bubble.style.cssText = [
      'position:fixed',
      'z-index:2147483646',
      'display:none',
      'max-width:360px',
      'padding:10px 12px',
      'border-radius:10px',
      'background:#ffffff',
      'color:#111111',
      'border:1px solid rgba(0,0,0,.12)',
      'box-shadow:0 8px 28px rgba(0,0,0,.18)',
      'font:13px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'white-space:pre-wrap',
      'word-break:break-word',
      'cursor:pointer',
      'user-select:text'
    ].join(';');

    // 点击气泡复制译文
    bubble.addEventListener('mousedown', function (event) {
      event.stopPropagation();
    });
    bubble.addEventListener('click', function () {
      if (bubble.dataset.state !== 'done') return;
      var text = bubble.textContent || '';
      if (!text) return;
      try {
        navigator.clipboard.writeText(text).then(function () {
          var old = text;
          bubble.textContent = '已复制';
          setTimeout(function () {
            // 期间可能已经有新的译文了，别把新内容覆盖掉
            if (bubble && bubble.textContent === '已复制') bubble.textContent = old;
          }, 600);
        });
      } catch (err) {
        /* 剪贴板不可用就算了 */
      }
    });

    (document.body || document.documentElement).appendChild(bubble);
    return bubble;
  }

  function hideBubble() {
    seq += 1; // 作废进行中的请求
    if (bubble) bubble.style.display = 'none';
  }

  function place(rect) {
    var pad = 8;
    var bw = bubble.offsetWidth;
    var bh = bubble.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    var left = Math.min(Math.max(pad, rect.left), Math.max(pad, vw - bw - pad));
    var top = rect.bottom + 8;
    if (top + bh > vh - pad) {
      top = rect.top - bh - 8;
    }
    if (top < pad) top = pad;

    bubble.style.left = Math.round(left) + 'px';
    bubble.style.top = Math.round(top) + 'px';
  }

  function showBubble(rect, text, state) {
    ensureBubble();
    bubble.dataset.state = state || 'done';
    bubble.textContent = text;
    bubble.style.display = 'block';
    // 先显示再量尺寸，否则 offsetWidth 为 0
    bubble.style.visibility = 'hidden';
    place(rect);
    bubble.style.visibility = 'visible';
  }

  // ---------------- 选区 ----------------
  function currentSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;

    var text = String(sel.toString() || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;

    var range = sel.getRangeAt(0);
    var node = range.commonAncestorContainer;
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || !el.closest) return null;

    // 输入类元素、我们自己的 UI、以及我们已经插入的译文，都不参与划词
    if (el.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"]')) return null;
    if (el.closest('[data-dt-ui]')) return null;
    if (el.closest('[data-dt-target]')) return null;

    var rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;

    return { text: text, rect: rect };
  }

  function cfg() {
    return DT.state.config || {};
  }

  function eligible(info) {
    if (cfg().selectionTranslate === false) return false;
    if (info.text.length < 2 || info.text.length > MAX_CHARS) return false;
    if (!/[\p{L}]/u.test(info.text)) return false; // 纯数字 / 纯符号不翻
    return true;
  }

  async function translateSelection(info) {
    var mySeq = ++seq;
    showBubble(info.rect, '翻译中…', 'loading');

    try {
      var res = await DT.send({
        type: 'translate',
        texts: [info.text],
        target: DT.state.target || cfg().targetLang || 'zh-CN'
      });
      if (mySeq !== seq) return; // 期间又划了别的词，或气泡已关

      var value = res && res.results && res.results[0];
      if (res && res.ok && typeof value === 'string' && value.trim()) {
        showBubble(info.rect, value.trim(), 'done');
      } else if (res && res.ok && typeof value === 'string') {
        showBubble(info.rect, '与原文相同', 'done');
      } else {
        showBubble(info.rect, '翻译失败：' + ((res && res.error) || '未知错误'), 'error');
      }
    } catch (err) {
      if (mySeq !== seq) return;
      showBubble(info.rect, '翻译失败：' + (err && err.message ? err.message : String(err)), 'error');
    }
  }

  // ---------------- 事件 ----------------
  document.addEventListener(
    'mouseup',
    function (event) {
      var target = event.target;
      if (target && target.closest && target.closest('[data-dt-ui]')) return;

      // 让浏览器先把选区落定
      setTimeout(function () {
        var info = currentSelection();
        if (!info) return;
        if (!eligible(info)) {
          hideBubble();
          return;
        }
        var now = Date.now();
        if (now - lastAt < 120) return;
        lastAt = now;
        translateSelection(info);
      }, 10);
    },
    true
  );

  document.addEventListener(
    'mousedown',
    function (event) {
      if (!bubble || bubble.style.display === 'none') return;
      if (event.target && event.target.closest && event.target.closest('[data-dt-ui]')) return;
      hideBubble();
    },
    true
  );

  document.addEventListener(
    'keydown',
    function (event) {
      if (event.key === 'Escape') hideBubble();
    },
    true
  );

  // 滚动后选区位置就对不上了，直接收起
  window.addEventListener('scroll', hideBubble, true);
  window.addEventListener('resize', hideBubble, true);

  DT.log('selection translate ready');
})();
