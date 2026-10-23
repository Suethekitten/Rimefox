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

  // ---------------- 配色 ----------------
  // 气泡和小按钮放在网页里（不在 Shadow DOM 里），只能用行内样式；
  // 深色网页（深色适配 / 夜间模式开着）换一套深色玻璃。强调色跟随 --dt-accent
  var ACCENT = 'var(--dt-accent,#6a5cf0)';
  var FONT = '-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif';

  function paletteOf() {
    var html = document.documentElement;
    var dark = html.getAttribute('data-dt-scheme') === 'dark' || html.getAttribute('data-dt-night') === 'on';
    return dark
      ? {
          bg: 'rgba(24,28,40,.94)',
          fg: '#eef1f7',
          muted: '#94a3b8',
          line: 'rgba(255,255,255,.12)',
          subtle: 'rgba(255,255,255,.05)',
          hover: 'rgba(255,255,255,.09)',
          field: 'rgba(0,0,0,.25)',
          shadow: 'inset 0 1px 0 rgba(255,255,255,.07),0 2px 6px rgba(0,0,0,.4),0 18px 44px -12px rgba(0,0,0,.7)',
          warnBg: 'rgba(251,191,36,.12)',
          warnLine: 'rgba(251,191,36,.35)',
          warnFg: '#fcd34d',
          errFg: '#fca5a5'
        }
      : {
          bg: 'rgba(255,255,255,.94)',
          fg: '#0f172a',
          muted: '#64748b',
          line: 'rgba(15,23,42,.1)',
          subtle: '#f1f4f9',
          hover: 'rgba(15,23,42,.06)',
          field: '#ffffff',
          shadow: 'inset 0 1px 0 rgba(255,255,255,.9),0 2px 6px rgba(15,23,42,.08),0 16px 40px -12px rgba(15,23,42,.28)',
          warnBg: 'rgba(217,119,6,.1)',
          warnLine: 'rgba(217,119,6,.3)',
          warnFg: '#92400e',
          errFg: '#b91c1c'
        };
  }

  function paintBubble() {
    var pal = paletteOf();
    bubble.style.background = pal.bg;
    bubble.style.color = pal.fg;
    bubble.style.borderColor = pal.line;
    bubble.style.boxShadow = pal.shadow;
    bubble._pal = pal;
    (bubble._pills || []).forEach(function (pill) {
      pill.style.borderColor = pal.line;
      pill.style.color = pal.muted;
    });
    if (bubble._form) paintForm(bubble._form, pal);
  }

  // 动作胶囊：图标 + 小字，平时弱化，悬停浮现底色
  function pill(path, text) {
    var el = document.createElement('span');
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.style.cssText =
      'flex:none;display:none;align-items:center;gap:4px;height:24px;padding:0 9px;border:1px solid transparent;border-radius:999px;' +
      'font:500 11.5px/1 ' + FONT + ';white-space:nowrap;cursor:pointer;user-select:none;transition:background .15s ease,color .15s ease;';
    el.appendChild(DT.icon(path, 13));
    var label = document.createElement('span');
    label.textContent = text;
    el.appendChild(label);
    el._label = label;
    el.addEventListener('mouseenter', function () {
      el.style.background = (bubble._pal || paletteOf()).hover;
      el.style.color = (bubble._pal || paletteOf()).fg;
    });
    el.addEventListener('mouseleave', function () {
      el.style.background = 'transparent';
      el.style.color = (bubble._pal || paletteOf()).muted;
    });
    el.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        el.click();
      }
    });
    return el;
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
      'box-sizing:border-box',
      'max-width:420px',
      'padding:12px 14px 8px',
      'border-radius:12px',
      'border:1px solid transparent',
      '-webkit-backdrop-filter:blur(16px) saturate(140%)',
      'backdrop-filter:blur(16px) saturate(140%)',
      'font:13.5px/1.65 ' + FONT,
      'white-space:pre-wrap',
      'word-break:break-word',
      'cursor:pointer',
      'user-select:text'
    ].join(';');

    // 内层：上面译文，下面一行动作胶囊（复制 / 置顶 / 加入术语表）+ 右下角品牌水印
    var body = document.createElement('div');
    body.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

    var textEl = document.createElement('div');
    textEl.style.cssText = 'min-width:0;';
    bubble._textEl = textEl;

    var actions = document.createElement('div');
    actions.style.cssText = 'display:flex;align-items:center;gap:2px;margin:0 -6px;white-space:nowrap;';
    bubble._actions = actions;

    var logo = document.createElement('img');
    logo.alt = '';
    logo.title = '凛狐 Rimefox';
    logo.style.cssText = 'width:14px;height:14px;flex:none;opacity:.4;display:block;margin:0 6px 0 auto;';
    logo.addEventListener('error', function () {
      logo.style.display = 'none'; // 取不到图标就不显示，别留个破图
    });
    try {
      logo.src = chrome.runtime.getURL('icons/icon32.png');
    } catch (err) {
      logo.style.display = 'none';
    }

    // 「复制」：和点气泡本身一样复制译文，只是更好找
    var copy = pill('M9 9h11v11H9zM5 15V4h11', DT.uiText('复制', 'Copy'));
    copy.addEventListener('click', function (event) {
      event.stopPropagation();
      var text = bubble._textEl.textContent || '';
      if (!text) return;
      try {
        navigator.clipboard.writeText(text).then(function () {
          copy._label.textContent = DT.uiText('已复制', 'Copied');
          copy.style.color = '#10b981';
          setTimeout(function () {
            copy._label.textContent = DT.uiText('复制', 'Copy');
            copy.style.color = (bubble._pal || paletteOf()).muted;
          }, 1200);
        });
      } catch (err) {
        /* 剪贴板不可用就算了 */
      }
    });
    bubble._copyEl = copy;

    // 「置顶」：把这条译文放进始终在最上层的小窗（pip.js），翻完才显示
    var pin = pill('M9 3h6l-1 6 3 3H7l3-3-1-6zM12 15v6', DT.uiText('置顶', 'Pin'));
    pin.addEventListener('click', function (event) {
      event.stopPropagation(); // 别触发气泡的「点击复制」
      if (DT.pip) DT.pip.open();
    });
    bubble._pinEl = pin;

    // 「加入术语表」：把这条「原文 → 译法」收进术语表，不必再去设置页手填
    var addTerm = pill('M12 5v14M5 12h14', DT.uiText('加入术语表', 'Add to glossary'));
    addTerm.addEventListener('click', function (event) {
      event.stopPropagation(); // 别触发气泡的「点击复制」
      openTermForm();
    });
    bubble._addEl = addTerm;
    bubble._body = body;
    bubble._pills = [copy, pin, addTerm];

    actions.appendChild(copy);
    actions.appendChild(pin);
    actions.appendChild(addTerm);
    actions.appendChild(logo);
    body.appendChild(textEl);
    body.appendChild(actions);
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
      if (bubble._actions) bubble._actions.style.display = 'flex';
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
    if (bubble._actions) bubble._actions.style.display = 'flex';
    paintBubble();
    bubble.dataset.state = state || 'done';
    bubble._textEl.textContent = text;
    if (DT.direction) {
      var targetDir = DT.direction.dirForLang(DT.state.target);
      bubble._textEl.setAttribute('dir', targetDir);
      bubble._textEl.style.setProperty('direction', targetDir, 'important');
      bubble._textEl.style.setProperty('text-align', 'start', 'important');
      bubble._textEl.style.setProperty('unicode-bidi', 'isolate', 'important');
    }
    bubble._lastRect = rect;
    var canAdd = (state || 'done') === 'done' && !!lastPair;
    bubble._copyEl.style.display = (state || 'done') === 'done' ? 'inline-flex' : 'none';
    bubble._addEl.style.display = canAdd ? 'inline-flex' : 'none';
    var addTitle = DT.uiText('加入术语表', 'Add to glossary');
    bubble._addEl.title = addTitle;
    bubble._addEl.setAttribute('aria-label', addTitle);
    var pinTitle = DT.uiText('置顶：放进始终在最上层的小窗', 'Pin to an always-on-top window');
    bubble._pinEl.title = pinTitle;
    bubble._pinEl.setAttribute('aria-label', pinTitle);
    bubble._pinEl.style.display = (state || 'done') === 'done' && DT.pip && DT.pip.supported() ? 'inline-flex' : 'none';
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

    // 内嵌抽屉：译文下面一条细分割线，下半部是二级底色的表单区（原文 → 译法 两栏）
    var form = document.createElement('div');
    form.setAttribute('data-dt-ui', '1');
    form.style.cssText =
      'display:none;min-width:300px;margin:8px -14px -8px;padding:10px 14px 12px;border-top:1px solid transparent;' +
      'border-radius:0 0 12px 12px;cursor:default;white-space:normal;';

    function label(text) {
      var el = document.createElement('div');
      el.style.cssText = 'font-size:11.5px;margin:0 0 3px;';
      el.textContent = text;
      return el;
    }

    function field() {
      var input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 200;
      input.setAttribute('data-dt-ui', '1');
      input.style.cssText =
        'width:100%;box-sizing:border-box;height:28px;margin:0;padding:0 8px;border:1px solid transparent;' +
        'border-radius:7px;font:12.5px/1.4 ' + FONT + ';outline:none;transition:border-color .15s ease,box-shadow .15s ease;';
      input.addEventListener('focus', function () {
        input.style.borderColor = ACCENT;
        input.style.boxShadow = '0 0 0 3px color-mix(in srgb,' + ACCENT + ' 28%,transparent)';
      });
      input.addEventListener('blur', function () {
        input.style.borderColor = (bubble._pal || paletteOf()).line;
        input.style.boxShadow = 'none';
      });
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

    // 提示条：冲突（已有译法）是琥珀色微光条，出错是红字，「保存中…」是弱文字
    var note = document.createElement('div');
    note.style.cssText = 'display:none;font-size:12px;line-height:1.5;margin:8px 0 0;padding:6px 8px;border-radius:8px;border:1px solid transparent;';

    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;justify-content:flex-end;margin-top:10px;';

    function button(text, primary) {
      var el = document.createElement('button');
      el.type = 'button';
      el.textContent = text;
      el.style.cssText =
        'height:28px;padding:0 12px;border-radius:8px;cursor:pointer;font:500 12.5px/1 ' + FONT + ';' +
        (primary
          ? 'border:1px solid transparent;background:' + ACCENT + ';color:#fff;box-shadow:inset 0 1px 0 rgba(255,255,255,.25);'
          : 'border:1px solid transparent;background:transparent;');
      el._primary = !!primary;
      return el;
    }

    var save = button(DT.uiText('保存', 'Save'), true);
    var overwrite = button(DT.uiText('覆盖', 'Overwrite'), true);
    overwrite.style.display = 'none';
    overwrite.style.background = '#d97706';
    overwrite.style.fontWeight = '600';
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

    // 两栏：[原文] → [译法]
    var grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:end;column-gap:6px;';
    var left = document.createElement('div');
    left.appendChild(label(DT.uiText('原文', 'Source')));
    left.appendChild(src);
    var arrow = document.createElement('div');
    arrow.textContent = '→';
    arrow.style.cssText = 'height:28px;line-height:28px;font-size:12px;opacity:.55;';
    var right = document.createElement('div');
    right.appendChild(label(DT.uiText('译法', 'Translation')));
    right.appendChild(dst);
    grid.appendChild(left);
    grid.appendChild(arrow);
    grid.appendChild(right);
    form.appendChild(grid);
    form.appendChild(note);
    form.appendChild(row);
    form._labels = [left.firstChild, right.firstChild];
    form._cancel = cancel;

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
    paintForm(form, bubble._pal || paletteOf());
    return form;
  }

  function paintForm(form, pal) {
    form.style.background = pal.subtle;
    form.style.borderTopColor = pal.line;
    form._labels.forEach(function (el) {
      el.style.color = pal.muted;
    });
    [form._src, form._dst].forEach(function (input) {
      input.style.background = pal.field;
      input.style.color = pal.fg;
      if (document.activeElement !== input) input.style.borderColor = pal.line;
    });
    form._cancel.style.color = pal.muted;
  }

  function openTermForm() {
    if (!lastPair) return;
    var form = ensureTermForm();
    form._src.value = lastPair.source;
    form._dst.value = lastPair.target;
    form._note.style.display = 'none';
    form._overwrite.style.display = 'none';
    // 译文留在上面，只收起动作胶囊；表单在下半部展开
    if (bubble._actions) bubble._actions.style.display = 'none';
    paintForm(form, bubble._pal || paletteOf());
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
    if (bubble._actions) bubble._actions.style.display = 'flex';
    bubble.dataset.state = 'done';
    if (bubble._lastRect) placeBubble(bubble._lastRect);
  }

  // kind：warn = 同名原文已有译法（琥珀色提示条）；info = 「保存中…」；默认 = 出错（红字）
  function showTermNote(text, kind) {
    if (!bubble || !bubble._form) return;
    var note = bubble._form._note;
    var pal = bubble._pal || paletteOf();
    note.textContent = text;
    note.style.display = text ? 'block' : 'none';
    note.style.background = kind === 'warn' ? pal.warnBg : 'transparent';
    note.style.borderColor = kind === 'warn' ? pal.warnLine : 'transparent';
    note.style.color = kind === 'warn' ? pal.warnFg : kind === 'info' ? pal.muted : pal.errFg;
    note.style.padding = kind === 'warn' ? '6px 8px' : '0';
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
    showTermNote(DT.uiText('保存中…', 'Saving…'), 'info');
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
          ),
          'warn'
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
    // 28px 圆角方块，毛玻璃底 + 强调色「译」；出现时 120ms 从 0.88 弹到 1
    btn.style.cssText = [
      'position:fixed',
      'z-index:2147483645',
      'display:none',
      'box-sizing:border-box',
      'width:28px',
      'height:28px',
      'text-align:center',
      'border-radius:8px',
      'border:1px solid transparent',
      '-webkit-backdrop-filter:blur(12px) saturate(140%)',
      'backdrop-filter:blur(12px) saturate(140%)',
      'color:' + ACCENT,
      'font:700 13px/26px ' + FONT,
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
    var size = 28;
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

    var wasHidden = btn.style.display === 'none';
    var pal = paletteOf();
    btn.style.background = pal.bg;
    btn.style.borderColor = pal.line;
    btn.style.boxShadow = pal.shadow;
    btn.style.left = Math.round(left) + 'px';
    btn.style.top = Math.round(top) + 'px';
    btn.style.display = 'block';
    if (wasHidden && btn.animate && !(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches)) {
      btn.animate([{ transform: 'scale(.88)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 120, easing: 'ease-out' });
    }
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

  // 捕获阶段也会收到我们自己界面里的滚动（收录表单里 input.select() 会把长原文横向滚到末尾）：
  // 那不是网页在滚，不能据此收起气泡
  window.addEventListener(
    'scroll',
    function (event) {
      var el = event.target;
      if (el && el.nodeType === 1 && el.closest && el.closest('[data-dt-ui]')) return;
      followSelection();
    },
    true
  );
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