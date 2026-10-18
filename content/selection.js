// 划词翻译：三种触发方式共用同一套取词 / 气泡逻辑。
//   A 右键菜单      —— 由 background.js 的 chrome.contextMenus 触发，消息进来才翻
//   B 选区小按钮    —— 选中后旁边出现「译」，点击才翻（默认）
//   D 选中即翻译    —— 打开后选中立刻翻（旧行为）
//   C 快捷键        —— 暂缓（监听在 main.js，等 P0-d 合并后统一做）
//
// 设置项：selectionTranslate（总开关）、selectionMenu、selectionButton、selectionImmediate。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT) return;
  if (DT.__selectionReady) return; // 允许被重复注入（popup 的 ensure 会再执行一次）
  DT.__selectionReady = true;

  var MAX_CHARS = 800;
  var bubble = null;
  var btn = null;
  var seq = 0;
  var lastAt = 0;
  // 选区所在的元素：有些站点（比如 X）一滚动就把选区清掉，
  // 这时没法再用 getSelection 定位，改用这个元素跟着走
  var anchorEl = null;

  function cfg() {
    return DT.state.config || {};
  }
  function masterOn() {
    return cfg().selectionTranslate !== false;
  }

  // ---------------- 气泡 ----------------
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

    // 内层：左边译文，右下角品牌 logo
    var body = document.createElement('div');
    body.style.cssText = 'display:flex;align-items:flex-end;gap:8px;';

    var textEl = document.createElement('div');
    textEl.style.cssText = 'flex:1 1 auto;min-width:0;';
    bubble._textEl = textEl;

    var logo = document.createElement('img');
    logo.alt = '';
    logo.title = '凛狐 Rimefox';
    logo.style.cssText = 'width:14px;height:14px;flex:none;opacity:.45;display:block;';
    logo.addEventListener('error', function () {
      logo.style.display = 'none'; // 取不到图标就不显示，别留个破图
    });
    try {
      logo.src = chrome.runtime.getURL('icons/icon32.png');
    } catch (err) {
      logo.style.display = 'none';
    }

    body.appendChild(textEl);
    body.appendChild(logo);
    bubble.appendChild(body);

    bubble.addEventListener('mousedown', function (event) {
      event.stopPropagation();
    });
    bubble.addEventListener('click', function () {
      if (bubble.dataset.state !== 'done') return;
      var text = bubble._textEl.textContent || '';
      if (!text) return;
      try {
        navigator.clipboard.writeText(text).then(function () {
          bubble._textEl.textContent = '已复制';
          setTimeout(function () {
            if (bubble && bubble._textEl.textContent === '已复制') bubble._textEl.textContent = text;
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
    anchorEl = null;
    if (bubble) bubble.style.display = 'none';
  }

  function placeBubble(rect) {
    var pad = 8;
    var bw = bubble.offsetWidth;
    var bh = bubble.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    var left = Math.min(Math.max(pad, rect.left), Math.max(pad, vw - bw - pad));
    var top = rect.bottom + 8;
    if (top + bh > vh - pad) top = rect.top - bh - 8;
    if (top < pad) top = pad;

    bubble.style.left = Math.round(left) + 'px';
    bubble.style.top = Math.round(top) + 'px';
  }

  function showBubble(rect, text, state) {
    hideButton();
    ensureBubble();
    bubble.dataset.state = state || 'done';
    bubble._textEl.textContent = text;
    bubble.style.display = 'block';
    bubble.style.visibility = 'hidden'; // 先量尺寸再定位
    placeBubble(rect);
    bubble.style.visibility = 'visible';
  }

  // ---------------- 选区小按钮（B 方案） ----------------
  function ensureButton() {
    if (btn && btn.isConnected) return btn;

    btn = document.createElement('div');
    btn.setAttribute('data-dt-ui', '1');
    btn.textContent = '译';
    btn.title = '翻译所选文字';
    btn.style.cssText = [
      'position:fixed',
      'z-index:2147483645',
      'display:none',
      'width:26px',
      'height:26px',
      'line-height:26px',
      'text-align:center',
      'border-radius:6px',
      'background:#2563eb',
      'color:#ffffff',
      'font:600 13px/26px -apple-system,"Segoe UI","Microsoft YaHei",sans-serif',
      'box-shadow:0 4px 12px rgba(0,0,0,.22)',
      'cursor:pointer',
      'user-select:none'
    ].join(';');

    btn.addEventListener('mousedown', function (event) {
      event.stopPropagation();
      event.preventDefault(); // 别清掉选区
    });
    btn.addEventListener('click', function (event) {
      event.stopPropagation();
      var info = currentSelection();
      hideButton();
      if (info) run(info);
    });

    (document.body || document.documentElement).appendChild(btn);
    return btn;
  }

  function hideButton() {
    if (btn) btn.style.display = 'none';
  }

  function showButton(rect) {
    ensureButton();
    var pad = 6;
    var size = 26;
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    var left = Math.min(Math.max(pad, rect.right + 6), vw - size - pad);
    var top = Math.min(Math.max(pad, rect.bottom + 6), vh - size - pad);

    btn.style.left = Math.round(left) + 'px';
    btn.style.top = Math.round(top) + 'px';
    btn.style.display = 'block';
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

    if (el.closest('input,textarea,select,[contenteditable=""],[contenteditable="true"]')) return null;
    if (el.closest('[data-dt-ui]')) return null;
    if (el.closest('[data-dt-target]')) return null;

    var rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;

    return { text: text, rect: rect, el: el };
  }

  function eligible(info) {
    if (!masterOn()) return false;
    if (!info || !info.text) return false;
    if (info.text.length < 2 || info.text.length > MAX_CHARS) return false;
    if (!/[\p{L}]/u.test(info.text)) return false; // 纯数字 / 纯符号不翻
    return true;
  }

  // ---------------- 翻译 ----------------
  async function run(info) {
    hideButton();
    anchorEl = info.el || null;
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
        if (!masterOn()) {
          hideButton();
          return;
        }
        var info = currentSelection();
        if (!eligible(info)) {
          hideButton();
          return;
        }
        var now = Date.now();
        if (now - lastAt < 120) return;
        lastAt = now;

        // D 方案：选中立刻翻
        if (cfg().selectionImmediate === true) {
          run(info);
          return;
        }
        // B 方案：只出小按钮，等用户点
        if (cfg().selectionButton !== false) showButton(info.rect);
      }, 10);
    },
    true
  );

  document.addEventListener(
    'mousedown',
    function (event) {
      if (event.target && event.target.closest && event.target.closest('[data-dt-ui]')) return;
      hideButton();
      if (bubble && bubble.style.display !== 'none') hideBubble();
    },
    true
  );

  document.addEventListener(
    'keydown',
    function (event) {
      if (event.key === 'Escape') {
        hideButton();
        hideBubble();
      }
    },
    true
  );

  // 滚动 / 改窗口大小：气泡和小按钮跟着选区走，只有选区滚出屏幕才收起。
  // （早期是"一滚就收"，读长文时很烦 —— 每滚一下都得重新触发）
  function selectionRect() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    try {
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return null;
      return rect;
    } catch (err) {
      return null;
    }
  }

  function inViewport(rect) {
    return (
      rect.bottom > 8 &&
      rect.top < window.innerHeight - 8 &&
      rect.right > 8 &&
      rect.left < window.innerWidth - 8
    );
  }

  // 选区被站点清掉时的兜底锚点：取元素顶部一小段，
  // 避免大块元素的底边把气泡甩到很远
  function anchorRect(el) {
    if (!el || !el.isConnected) return null;
    var r = el.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return null;
    return {
      top: r.top,
      bottom: r.top + 20,
      left: r.left,
      right: r.left + 200,
      width: r.width,
      height: 20
    };
  }

  var followRaf = 0;
  function followSelection() {
    if (followRaf) return;
    followRaf = requestAnimationFrame(function () {
      followRaf = 0;
      var live = selectionRect();

      // 气泡：优先跟随选区；选区被站点清掉了就跟随锚点元素（X 这类站点会清选区）
      if (bubble && bubble.style.display !== 'none') {
        var rect = live || anchorRect(anchorEl);
        if (!rect || !inViewport(rect)) hideBubble();
        else placeBubble(rect);
      }

      // 小按钮：只在真的有选区时显示，选区没了就该消失
      if (btn && btn.style.display !== 'none') {
        if (!live || !inViewport(live)) hideButton();
        else showButton(live);
      }
    });
  }

  window.addEventListener('scroll', followSelection, true);
  window.addEventListener('resize', followSelection);

  // A 方案：右键菜单点击后由 background 发进来
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'dt:translateSelection') return false;
    if (!masterOn()) return false;

    var info = currentSelection();
    var text = String(msg.text || (info && info.text) || '').trim();
    if (!text) return false;

    // 右侧菜单触发的场景下也要能定位气泡：优先用当前选区，取不到就退到屏幕上方中间
    var rect =
      info && info.rect
        ? info.rect
        : {
            left: Math.round(window.innerWidth / 2 - 120),
            right: Math.round(window.innerWidth / 2 + 120),
            top: 80,
            bottom: 100,
            width: 240,
            height: 20
          };

    var payload = { text: text, rect: rect };
    if (!eligible(payload)) return false;
    run(payload);
    return false;
  });

  DT.log('selection translate ready');
})();
