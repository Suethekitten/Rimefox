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
  // 小按钮相对选区左上角的偏移（松开鼠标时指针所在的位置）。
  // 记偏移而不是屏幕坐标：页面滚动后按钮还能跟着选区走
  var btnOffset = null;
  // 最近一次划词结果：置顶小窗（pip.js）打开时先显示它，之后每翻一次就推过去
  var resultHooks = [];
  // 气泡上「加入术语表」用的当前这条：原文 + 刚才的译文（表单里可以改）。
  // 只在 done 状态可用；气泡一关就清掉，免得把上一条的译法带进下一次
  var lastPair = null;
  DT.lastSelection = null;
  DT.onSelectionResult = function (fn) {
    resultHooks.push(fn);
  };
  function emitResult(entry) {
    DT.lastSelection = entry;
    resultHooks.forEach(function (fn) {
      try {
        fn(entry);
      } catch (err) {
        DT.log('selection hook failed', err);
      }
    });
  }

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

    // 「置顶」：把这条译文放进始终在最上层的小窗（pip.js），翻完才显示
    var pin = document.createElement('span');
    pin.setAttribute('role', 'button');
    pin.style.cssText = 'flex:none;display:none;width:14px;height:14px;opacity:.5;cursor:pointer;color:inherit;';
    pin.appendChild(DT.icon('M9 3h6l-1 6 3 3H7l3-3-1-6zM12 15v6', 14));
    pin.addEventListener('mouseenter', function () {
      pin.style.opacity = '1';
    });
    pin.addEventListener('mouseleave', function () {
      pin.style.opacity = '.55';
    });
    pin.addEventListener('click', function (event) {
      event.stopPropagation(); // 别触发气泡的「点击复制」
      if (DT.pip) DT.pip.open();
    });
    bubble._pinEl = pin;

    // 「加入术语表」：把这条「原文 → 译法」收进术语表，不必再去设置页手填
    var addTerm = document.createElement('span');
    addTerm.setAttribute('role', 'button');
    addTerm.style.cssText = 'flex:none;display:none;width:14px;height:14px;opacity:.5;cursor:pointer;color:inherit;';
    addTerm.appendChild(DT.icon('M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 3H20v18H6.5A2.5 2.5 0 0 1 4 18.5v-13A2.5 2.5 0 0 1 6.5 3z', 14));
    addTerm.addEventListener('mouseenter', function () {
      addTerm.style.opacity = '1';
    });
    addTerm.addEventListener('mouseleave', function () {
      addTerm.style.opacity = '.5';
    });
    addTerm.addEventListener('click', function (event) {
      event.stopPropagation(); // 别触发气泡的「点击复制」
      openTermForm();
    });
    bubble._addEl = addTerm;
    bubble._body = body;

    body.appendChild(textEl);
    body.appendChild(addTerm);
    body.appendChild(pin);
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
    lastPair = null;
    if (bubble) {
      bubble.style.display = 'none';
      if (bubble._form) bubble._form.style.display = 'none';
      if (bubble._body) bubble._body.style.display = 'flex';
    }
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
    // 从收录表单切回译文：表单收起，正文重新露出来
    if (bubble._form) bubble._form.style.display = 'none';
    if (bubble._body) bubble._body.style.display = 'flex';
    bubble.dataset.state = state || 'done';
    bubble._textEl.textContent = text;
    bubble._lastRect = rect;
    var canAdd = (state || 'done') === 'done' && !!lastPair;
    bubble._addEl.style.display = canAdd ? 'block' : 'none';
    var addTitle = DT.uiText('加入术语表', 'Add to glossary');
    bubble._addEl.title = addTitle;
    bubble._addEl.setAttribute('aria-label', addTitle);
    var pinTitle = DT.uiText('置顶：放进始终在最上层的小窗', 'Pin to an always-on-top window');
    bubble._pinEl.title = pinTitle;
    bubble._pinEl.setAttribute('aria-label', pinTitle);
    bubble._pinEl.style.display = (state || 'done') === 'done' && DT.pip && DT.pip.supported() ? 'block' : 'none';
    bubble.style.display = 'block';
    bubble.style.visibility = 'hidden'; // 先量尺寸再定位
    placeBubble(rect);
    bubble.style.visibility = 'visible';
  }

  // ---------------- 加入术语表（翻完以后） ----------------
  // 两栏小表单：原文 = 选中的文字，译法 = 刚才的译文，都可以改。
  // 写入只能走后台的 glossary:add（内容脚本拿不到 Key，也就不该能写配置）。
  function ensureTermForm() {
    if (bubble._form && bubble._form.isConnected) return bubble._form;

    var form = document.createElement('div');
    form.setAttribute('data-dt-ui', '1');
    form.style.cssText = 'display:none;min-width:236px;max-width:320px;cursor:default;white-space:normal;';

    function label(text) {
      var el = document.createElement('div');
      el.style.cssText = 'font-size:12px;opacity:.7;margin:0 0 2px;';
      el.textContent = text;
      return el;
    }

    function field() {
      var input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 200;
      input.setAttribute('data-dt-ui', '1');
      input.style.cssText =
        'width:100%;box-sizing:border-box;margin:0 0 8px;padding:5px 7px;border:1px solid rgba(0,0,0,.18);' +
        'border-radius:6px;background:#fff;color:#111;font:13px/1.4 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;';
      input.addEventListener('keydown', function (event) {
        event.stopPropagation(); // 别让页面快捷键抢走 Enter / Esc
        if (event.key === 'Enter') {
          event.preventDefault();
          saveTerm(false);
        }
      });
      return input;
    }

    var src = field();
    var dst = field();

    var note = document.createElement('div');
    note.style.cssText = 'display:none;font-size:12px;line-height:1.5;margin:0 0 8px;color:#b91c1c;';

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;';

    function button(text, primary) {
      var el = document.createElement('button');
      el.type = 'button';
      el.textContent = text;
      el.style.cssText =
        'padding:4px 12px;border-radius:6px;cursor:pointer;font:13px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;' +
        (primary
          ? 'border:1px solid #2563eb;background:#2563eb;color:#fff;'
          : 'border:1px solid rgba(0,0,0,.18);background:#fff;color:#111;');
      return el;
    }

    var save = button(DT.uiText('保存', 'Save'), true);
    var overwrite = button(DT.uiText('覆盖', 'Overwrite'), true);
    overwrite.style.display = 'none';
    overwrite.style.background = '#b45309';
    overwrite.style.borderColor = '#b45309';
    var cancel = button(DT.uiText('取消', 'Cancel'), false);

    save.addEventListener('click', function (event) {
      event.stopPropagation();
      saveTerm(false);
    });
    overwrite.addEventListener('click', function (event) {
      event.stopPropagation();
      saveTerm(true);
    });
    cancel.addEventListener('click', function (event) {
      event.stopPropagation();
      closeTermForm();
    });

    row.appendChild(save);
    row.appendChild(overwrite);
    row.appendChild(cancel);

    form.appendChild(label(DT.uiText('原文', 'Source')));
    form.appendChild(src);
    form.appendChild(label(DT.uiText('译法', 'Translation')));
    form.appendChild(dst);
    form.appendChild(note);
    form.appendChild(row);

    form._src = src;
    form._dst = dst;
    form._note = note;
    form._save = save;
    form._overwrite = overwrite;
    form.addEventListener('mousedown', function (event) {
      event.stopPropagation();
    });
    form.addEventListener('click', function (event) {
      event.stopPropagation();
    });

    bubble.appendChild(form);
    bubble._form = form;
    return form;
  }

  function openTermForm() {
    if (!lastPair) return;
    var form = ensureTermForm();
    form._src.value = lastPair.source;
    form._dst.value = lastPair.target;
    form._note.style.display = 'none';
    form._overwrite.style.display = 'none';
    if (bubble._body) bubble._body.style.display = 'none';
    form.style.display = 'block';
    bubble.dataset.state = 'form'; // 表单里点击不再触发「复制译文」
    bubble.style.visibility = 'hidden';
    placeBubble(bubble._lastRect || { left: 24, top: 24, right: 264, bottom: 44 });
    bubble.style.visibility = 'visible';
    try {
      form._src.focus();
      form._src.select();
    } catch (err) {
      /* 拿不到焦点就算了 */
    }
  }

  function closeTermForm() {
    if (!bubble || !bubble._form) return;
    bubble._form.style.display = 'none';
    if (bubble._body) bubble._body.style.display = 'flex';
    bubble.dataset.state = 'done';
    if (bubble._lastRect) placeBubble(bubble._lastRect);
  }

  function showTermNote(text) {
    if (!bubble || !bubble._form) return;
    bubble._form._note.textContent = text;
    bubble._form._note.style.display = text ? 'block' : 'none';
  }

  function termErrorOf(res) {
    var code = (res && res.error) || '';
    if (code === 'too_long') return DT.uiText('太长：原文和译法最多 200 字', 'Too long: 200 characters max');
    if (code === 'full') {
      var max = (res && res.max) || 500;
      return DT.uiText(
        '术语表已满（' + max + ' 条），先在设置页删几条',
        'Glossary is full (' + max + ' terms); remove a few in Options first'
      );
    }
    if (code === 'bad_value') return DT.uiText('原文和译法都要填', 'Both fields are required');
    return DT.uiText('保存失败：' + (code || '未知错误'), 'Save failed: ' + (code || 'unknown error'));
  }

  async function saveTerm(overwrite) {
    var form = bubble && bubble._form;
    if (!form) return;
    var source = String(form._src.value || '').trim();
    var target = String(form._dst.value || '').trim();
    if (!source || !target) {
      showTermNote(DT.uiText('原文和译法都要填', 'Both fields are required'));
      return;
    }
    form._save.disabled = true;
    form._overwrite.disabled = true;
    showTermNote(DT.uiText('保存中…', 'Saving…'));
    try {
      var res = await DT.send(
        { type: 'glossary:add', source: source, target: target, overwrite: overwrite === true },
        20000
      );
      if (res && res.ok && res.action === 'conflict') {
        // 同名原文已有别的译法：问一句再覆盖
        showTermNote(
          DT.uiText(
            '已有译法：' + res.current + '。要覆盖吗？',
            'Already defined as ' + res.current + '. Overwrite?'
          )
        );
        form._overwrite.style.display = 'inline-block';
        return;
      }
      if (res && res.ok) {
        closeTermForm();
        if (res.action === 'same') {
          DT.toast(DT.uiText('术语表里已经有这条：' + source, 'Already in the glossary: ' + source));
        } else if (res.action === 'updated') {
          DT.toast(DT.uiText('已更新术语：' + source + ' → ' + target, 'Term updated: ' + source + ' → ' + target));
        } else {
          DT.toast(DT.uiText('已加入术语表：' + source + ' → ' + target, 'Added to glossary: ' + source + ' → ' + target));
        }
        return;
      }
      showTermNote(termErrorOf(res));
    } catch (err) {
      showTermNote(
        DT.uiText('保存失败：' + ((err && err.message) || err), 'Save failed: ' + ((err && err.message) || err))
      );
    } finally {
      if (form && form.isConnected) {
        form._save.disabled = false;
        form._overwrite.disabled = false;
      }
    }
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
    btnOffset = null;
    if (btn) btn.style.display = 'none';
  }

  // 按钮放在鼠标指针的右下方。以前放在选区包围盒的右下角：
  // 选区一跨行，包围盒的右下角就是整段文字的末尾，离松开鼠标的地方很远。
  // point：松开鼠标时的指针坐标；不传时沿用上次记下的偏移（滚动跟随），都没有才退回选区右下角
  function showButton(rect, point) {
    ensureButton();
    var pad = 6;
    var size = 26;
    var gap = 10; // 别盖住指针本身
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    if (point) btnOffset = { dx: point.x - rect.left, dy: point.y - rect.top };
    var x = btnOffset ? rect.left + btnOffset.dx : rect.right;
    var y = btnOffset ? rect.top + btnOffset.dy : rect.bottom;

    // 右边 / 下边放不下就翻到指针的左边 / 上边
    var left = x + gap + size > vw - pad ? x - gap - size : x + gap;
    var top = y + gap + size > vh - pad ? y - gap - size : y + gap;
    left = Math.min(Math.max(pad, left), vw - size - pad);
    top = Math.min(Math.max(pad, top), vh - size - pad);

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
      }, 190000);
      if (mySeq !== seq) return; // 期间又划了别的词，或气泡已关

      var value = res && res.results && res.results[0];
      if (res && res.ok && typeof value === 'string' && value.trim()) {
        lastPair = { source: info.text, target: value.trim() };
        showBubble(info.rect, value.trim(), 'done');
        emitResult({ source: info.text, result: value.trim(), at: Date.now() });
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
      var point = { x: event.clientX, y: event.clientY };

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
        if (cfg().selectionButton !== false) showButton(info.rect, point);
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

  // 让整页快捷键复用划词：有选区时由 main.js 调用（返回 false 表示没有可翻的选区）
  DT.selectionTranslate = function () {
    var info = currentSelection();
    if (!info || !info.text) return false;
    var payload = { text: info.text, rect: info.rect };
    if (!eligible(payload)) return false;
    run(payload);
    return true;
  };

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