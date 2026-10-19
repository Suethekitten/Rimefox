// 悬浮入口（Dock）：网页边上的一个小球，悬停展开一列按钮 —— 开关翻译、切双语 / 仅译文、
// 翻译选中文字、打开置顶小窗、查看当前服务商。设置项：dockEnabled / dockSide / dockAutoHide（默认关闭）。
// 界面放在 Shadow DOM 里（closed）：网页的样式进不来，网页脚本也摸不到里面的按钮。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT || DT.__dockReady) return;
  DT.__dockReady = true;
  // 只在顶层页面显示：iframe（广告位、嵌入的编辑器）里不要各冒一个
  if (window.top !== window) return;

  var OPEN_DELAY = 120; // 悬停多久展开
  var CLOSE_DELAY = 360; // 移开多久收起
  var TIP_DELAY = 380; // 悬停多久出说明

  var host = null;
  var shadow = null;
  var dock = null;
  var menu = null;
  var tip = null;
  var buttons = {};
  var openTimer = 0;
  var closeTimer = 0;
  var tipTimer = 0;
  var attrObserver = null;

  var ICONS = {
    // 文 / A：开关翻译
    toggle: 'M4 5h8M8 3v2M5.5 5c.8 3 3 5.5 6 7M10.5 5c-.8 3.3-3 6-6.5 7.5M13 21l4-9 4 9M14.5 18h5',
    // 上下两行：双语 ↔ 仅译文
    mode: 'M4 6h16M4 10h10M4 15h16M4 19h10',
    // 光标 + 文本：翻译选中
    selection: 'M5 4h4M7 4v16M5 20h4M13 8h7M13 12h7M13 16h5',
    // 图钉：置顶小窗
    pin: 'M9 3h6l-1 6 3 3H7l3-3-1-6zM12 15v6',
    // 左右双向箭头：悬停对照开关
    hover: 'M4 7h16M7 4 4 7l3 3M20 17H4M17 14l3 3-3 3',
    // 服务器：当前服务商
    provider: 'M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01'
  };

  var CSS = [
    // 只有小球和展开后的面板接收鼠标：收起时看不见的面板区域不能挡住网页
    ':host{all:initial;position:fixed;z-index:2147483644;left:0;top:0;pointer-events:none;transition:left .16s ease,top .16s ease}',
    ':host([data-drag]){transition:none}',
    ':host([hidden]){display:none!important}',
    '@media print{:host{display:none!important}}',
    '.dock{--acc:var(--dt-accent,#6a5cf0);--bg:rgba(255,255,255,.97);--fg:#1d2030;--line:rgba(20,24,40,.12);--hover:color-mix(in srgb,var(--acc) 14%,transparent);' +
      'position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 6px;' +
      'font:13px/1.4 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg);' +
      'transition:transform .2s ease,opacity .2s ease;touch-action:none;cursor:grab}',
    '.dock[data-dark]{--bg:rgba(30,32,42,.97);--fg:#eef0f8;--line:rgba(255,255,255,.14);--acc:color-mix(in srgb,var(--dt-accent,#6a5cf0) 72%,white)}',
    // 自动隐藏：收起时只露出小球的一半，半透明
    '.dock[data-auto][data-snapped]:not([data-open]){transform:translateX(40%);opacity:.72}',
    ':host([data-side="left"]) .dock[data-auto][data-snapped]:not([data-open]){transform:translateX(-40%)}',
    '.dock[data-drag],.dock[data-drag] .ball{cursor:grabbing}',
    '.panel{display:flex;flex-direction:column;gap:4px;padding:5px;border-radius:14px;background:var(--bg);border:1px solid var(--line);' +
      'box-shadow:0 12px 32px -12px rgba(0,0,0,.35);opacity:0;transform:translateY(8px) scale(.96);pointer-events:none;' +
      'transition:opacity .16s ease,transform .16s ease}',
    '.dock[data-open] .panel,.ball{pointer-events:auto}',
    '.dock[data-open] .panel{opacity:1;transform:none}',
    'button{all:unset;box-sizing:border-box;display:grid;place-items:center;width:32px;height:32px;border-radius:9px;color:var(--fg);cursor:pointer}',
    'button:hover{background:var(--hover);color:var(--acc)}',
    'button:focus-visible{outline:2px solid var(--acc);outline-offset:1px}',
    'button[aria-pressed="true"]{background:var(--acc);color:#fff}',
    'button[data-act="mode"][data-mode="translation"] svg{transform:scaleY(-1)}',
    '.ball{width:40px;height:40px;border-radius:50%;background:var(--bg);border:1px solid var(--line);box-shadow:0 6px 18px -6px rgba(0,0,0,.35)}',
    '.ball img{width:24px;height:24px;display:block;pointer-events:none}',
    '.ball[aria-pressed="true"]{background:var(--bg);box-shadow:0 0 0 2px var(--acc),0 6px 18px -6px rgba(0,0,0,.35)}',
    '.tip{position:absolute;right:calc(100% + 4px);top:0;max-width:260px;padding:5px 9px;border-radius:7px;background:rgba(20,22,30,.94);color:#fff;' +
      'font-size:12px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0;pointer-events:none;transition:opacity .12s ease}',
    ':host([data-side="left"]) .tip{right:auto;left:calc(100% + 4px)}',
    '.tip[data-show]{opacity:1}',
    // 服务商切换菜单：从面板左侧弹出，不改变 dock 自身的布局
    '.menu{position:absolute;top:0;right:calc(100% + 6px);min-width:170px;max-width:260px;padding:6px;border-radius:12px;' +
      'background:var(--bg);border:1px solid var(--line);box-shadow:0 12px 32px -12px rgba(0,0,0,.35);' +
      'display:flex;flex-direction:column;gap:2px;pointer-events:auto;z-index:1}',
    ':host([data-side="left"]) .menu{right:auto;left:calc(100% + 6px)}',
    '.menu[hidden]{display:none}',
    '.menu-item{all:unset;box-sizing:border-box;display:flex;flex-direction:column;gap:1px;padding:6px 8px;border-radius:8px;cursor:pointer;text-align:left}',
    '.menu-item:hover,.menu-item:focus-visible{background:var(--hover)}',
    '.menu-item[aria-current="true"]{background:var(--hover)}',
    '.menu-name{font-size:12.5px;font-weight:600;white-space:nowrap}',
    '.menu-model{font-size:11px;opacity:.72;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:230px}',
    '.menu-empty{padding:6px 8px;font-size:12px;opacity:.78}',
    '@media (prefers-reduced-motion:reduce){:host,.dock,.panel,.tip{transition:none}}'
  ].join('\n');

  function cfg() {
    return DT.state.config || {};
  }

  // ---------------- 文案 ----------------
  function labelOf(act) {
    var st = DT.control ? DT.control.status() : { enabled: false, mode: 'dual' };
    if (act === 'toggle' || act === 'ball') {
      return st.enabled ? DT.uiText('还原原文', 'Show original') : DT.uiText('翻译此页', 'Translate this page');
    }
    if (act === 'mode') {
      return st.mode === 'translation' ? DT.uiText('切到双语对照', 'Switch to bilingual') : DT.uiText('切到仅译文', 'Switch to translation only');
    }
    if (act === 'hover') {
      return cfg().hoverCompare === false
        ? DT.uiText('开启悬停对照', 'Enable hover compare')
        : DT.uiText('关闭悬停对照', 'Disable hover compare');
    }
    if (act === 'selection') return DT.uiText('翻译选中的文字', 'Translate selected text');
    if (act === 'pin') return DT.uiText('置顶小窗：划词译文始终在最上层', 'Pinned window: selection translations stay on top');
    if (act === 'provider') {
      var list = cfg().providers || [];
      var cur = null;
      for (var i = 0; i < list.length; i += 1) {
        if (list[i].current) cur = list[i];
      }
      var name = (cur && cur.name) || (cfg().page || {}).provider || '—';
      return DT.uiText('切换服务商（当前：', 'Switch provider (current: ') + name + ')';
    }
    return '';
  }

  // ---------------- 构建 ----------------
  function makeButton(act, cls) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.act = act;
    if (cls) btn.className = cls;
    if (act === 'ball') {
      var img = document.createElement('img');
      img.alt = '';
      try {
        img.src = chrome.runtime.getURL('icons/icon32.png');
      } catch (err) {
        img.hidden = true;
      }
      btn.appendChild(img);
    } else {
      btn.appendChild(DT.icon(ICONS[act], 18));
    }
    // 别抢走网页上的选区：「翻译选中」要在点击时还能拿到选区
    btn.addEventListener('mousedown', function (event) {
      event.preventDefault();
    });
    btn.addEventListener('click', function (event) {
      event.stopPropagation();
      run(act === 'ball' ? 'toggle' : act);
    });
    btn.addEventListener('mouseenter', function () {
      scheduleTip(btn);
    });
    btn.addEventListener('mouseleave', hideTip);
    btn.addEventListener('focus', function () {
      showTip(btn);
    });
    btn.addEventListener('blur', hideTip);
    buttons[act] = btn;
    return btn;
  }

  function build() {
    host = document.createElement('div');
    host.setAttribute('data-dt-ui', '1');
    host.id = 'dt-dock';
    shadow = host.attachShadow({ mode: 'closed' });
    var style = document.createElement('style');
    style.textContent = CSS;
    shadow.appendChild(style);

    dock = document.createElement('div');
    dock.className = 'dock';
    dock.setAttribute('role', 'toolbar');
    dock.setAttribute('aria-orientation', 'vertical');
    var panel = document.createElement('div');
    panel.className = 'panel';
    ['toggle', 'mode', 'hover', 'selection', 'pin', 'provider'].forEach(function (act) {
      panel.appendChild(makeButton(act));
    });
    dock.appendChild(panel);
    menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    dock.appendChild(menu);
    dock.appendChild(makeButton('ball', 'ball'));
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'tooltip');
    dock.appendChild(tip);
    shadow.appendChild(dock);

    // 悬停 / 键盘聚焦时展开，移开 / 失焦后收起
    dock.addEventListener('mouseenter', function () {
      if (drag && drag.moved) return;
      clearTimeout(closeTimer);
      openTimer = setTimeout(setOpen.bind(null, true), OPEN_DELAY);
    });
    dock.addEventListener('mouseleave', function () {
      if (drag && drag.moved) return;
      clearTimeout(openTimer);
      closeTimer = setTimeout(setOpen.bind(null, false), CLOSE_DELAY);
    });
    dock.addEventListener('focusin', function () {
      clearTimeout(closeTimer);
      setOpen(true);
    });
    dock.addEventListener('focusout', function (event) {
      if (!dock.contains(event.relatedTarget)) closeTimer = setTimeout(setOpen.bind(null, false), CLOSE_DELAY);
    });
    dock.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        setOpen(false);
        if (shadow.activeElement) shadow.activeElement.blur();
      }
    });
    // ---- 拖拽：按住移动 >5px 起拖，松手按离边距离吸附或悬浮，并写回配置 ----
    dock.addEventListener('pointerdown', function (event) {
      if (drag) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      var rect = host.getBoundingClientRect();
      drag = {
        id: event.pointerId,
        dx: event.clientX - rect.left,
        dy: event.clientY - rect.top,
        sx: event.clientX,
        sy: event.clientY,
        moved: false
      };
      // 注意：这里不能立刻 setPointerCapture。捕获后 pointerup 会重定向到 dock，
      // 浏览器据此把 click 也算到 dock 上，按钮自己的 click 永远收不到（0.9.3 实测
      // 服务商按钮点不开菜单、翻译按钮点了没反应）。等真正开始拖再捕获。
      window.addEventListener('pointermove', onDragMove, true);
      window.addEventListener('pointerup', onDragEnd, true);
      window.addEventListener('pointercancel', onDragEnd, true);
    });

    dock.addEventListener('click', function (event) {
      if (!suppressClick) return;
      event.stopPropagation();
      event.preventDefault();
    }, true);

    window.addEventListener('resize', function () {
      place();
    });
    // 内容变长 / 变短导致滚动条出现或消失时只有 clientWidth 变，没有 resize 事件
    if (window.ResizeObserver) {
      var viewportObserver = new ResizeObserver(function () {
        place();
      });
      viewportObserver.observe(document.documentElement);
    }

    // 点菜单外面收起（服务商按钮自己负责开关，不在这里抢）
    dock.addEventListener('mousedown', function (event) {
      if (!menu || menu.hidden) return;
      if (menu.contains(event.target)) return;
      var btn = event.target && event.target.closest ? event.target.closest('[data-act="provider"]') : null;
      if (btn) return;
      hideMenu();
    });

    // 翻译开关 / 显示方式 / 页面明暗都写在 <html> 的属性上：跟着变
    attrObserver = new MutationObserver(render);
    attrObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-dt', 'data-dt-mode', 'data-dt-scheme', 'data-dt-night']
    });
    document.addEventListener('fullscreenchange', render);
  }

  // ---------------- 位置与拖拽（0.9.3） ----------------
  var suppressClick = false;
  var drag = null;

  function viewOf() {
    var r = dock ? dock.getBoundingClientRect() : null;
    // 用布局视口（clientWidth/clientHeight）：innerWidth 含经典滚动条，
    // 按它贴右会把悬浮入口塞到滚动条下面（0.9.3 实测被盖住一截）
    return {
      vw: document.documentElement.clientWidth || window.innerWidth || 1,
      vh: document.documentElement.clientHeight || window.innerHeight || 1,
      w: r && r.width ? r.width : 52,
      h: r && r.height ? r.height : 240
    };
  }

  // 按配置（或刚拖完的位置）摆放 host；data-side / data-snapped 也在这里一起定
  function place() {
    if (!host || host.hidden) return null;
    var view = viewOf();
    var saved = cfg().dockPos;
    var want = saved && typeof saved.x === 'number' && typeof saved.y === 'number'
      ? saved
      : DT.dockDefault(cfg().dockSide === 'left' ? 'left' : 'right', view);
    var got = DT.dockPlace(want, view);
    host.style.left = got.x + 'px';
    host.style.top = got.y + 'px';
    host.setAttribute('data-side', got.side);
    dock.toggleAttribute('data-snapped', !!got.snapped);
    return got;
  }

  function endDragListeners() {
    window.removeEventListener('pointermove', onDragMove, true);
    window.removeEventListener('pointerup', onDragEnd, true);
    window.removeEventListener('pointercancel', onDragEnd, true);
  }

  function onDragMove(event) {
    if (!drag || event.pointerId !== drag.id) return;
    if (!drag.moved) {
      // 移动超过 5px 才算拖，否则保持「点击按钮」的语义
      if (Math.abs(event.clientX - drag.sx) + Math.abs(event.clientY - drag.sy) < 5) return;
      drag.moved = true;
      // 真正开始拖了才捕获指针：太早捕获会把按钮的 click 抢到 dock 上
      try {
        dock.setPointerCapture(event.pointerId);
      } catch (err) {
        /* 合成事件 / 旧浏览器拿不到捕获：靠 window 监听也能拖 */
      }
      host.setAttribute('data-drag', '');
      dock.setAttribute('data-drag', '');
      clearTimeout(openTimer);
      clearTimeout(closeTimer);
      hideTip();
      hideMenu();
    }
    if (event.cancelable) event.preventDefault();
    host.style.left = Math.round(event.clientX - drag.dx) + 'px';
    host.style.top = Math.round(event.clientY - drag.dy) + 'px';
  }

  function onDragEnd(event) {
    if (!drag || event.pointerId !== drag.id) return;
    var moved = drag.moved;
    drag = null;
    endDragListeners();
    try {
      dock.releasePointerCapture(event.pointerId);
    } catch (err) {
      /* 合成事件拿不到捕获，忽略 */
    }
    host.removeAttribute('data-drag');
    dock.removeAttribute('data-drag');
    if (!moved) return;
    // 拖完紧跟的那次 click 是「拖拽余波」：吞掉，避免误触翻译开关
    suppressClick = true;
    setTimeout(function () {
      suppressClick = false;
    }, 0);
    var rect = host.getBoundingClientRect();
    var got = DT.dockPlace({ x: rect.left, y: rect.top }, viewOf());
    host.style.left = got.x + 'px';
    host.style.top = got.y + 'px';
    host.setAttribute('data-side', got.side);
    dock.toggleAttribute('data-snapped', !!got.snapped);
    DT.send({ type: 'dock:pos', pos: { x: got.x, y: got.y } }, 5000).catch(function () {});
  }

  function setOpen(open) {
    if (!dock) return;
    if (open) dock.setAttribute('data-open', '');
    else {
      dock.removeAttribute('data-open');
      hideTip();
      hideMenu();
    }
  }

  // ---------------- 说明气泡 ----------------
  var tipFor = null;

  function showTip(btn) {
    clearTimeout(tipTimer);
    if (!tip || !btn) return;
    // 服务商菜单开着时不再弹说明，否则会和菜单叠在一起
    if (menu && !menu.hidden && btn.dataset.act === 'provider') return;
    tipFor = btn;
    tip.textContent = labelOf(btn.dataset.act);
    tip.setAttribute('data-show', '');
    tip.style.top = Math.round(btn.offsetTop + btn.offsetHeight / 2 - tip.offsetHeight / 2) + 'px';
  }

  function scheduleTip(btn) {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(function () {
      showTip(btn);
    }, TIP_DELAY);
  }

  function hideTip() {
    clearTimeout(tipTimer);
    tipFor = null;
    if (tip) tip.removeAttribute('data-show');
  }

  // ---------------- 服务商菜单 ----------------
  function hideMenu() {
    if (menu) menu.hidden = true;
  }

  function renderMenu() {
    if (!menu) return;
    menu.textContent = '';
    var list = (cfg().providers || []).filter(function (p) {
      return p.hasKey;
    });

    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'menu-empty';
      empty.textContent = DT.uiText('还没有可切换的服务商，先在设置里填 Key', 'No provider yet — add a key in Settings');
      menu.appendChild(empty);
      return;
    }

    list.forEach(function (p) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'menu-item';
      item.setAttribute('role', 'menuitem');
      item.setAttribute('aria-current', p.current ? 'true' : 'false');
      item.dataset.provider = p.id;

      var name = document.createElement('span');
      name.className = 'menu-name';
      name.textContent = p.name + (p.current ? ' · ' + DT.uiText('当前', 'Current') : '');
      item.appendChild(name);

      if (p.model) {
        var model = document.createElement('span');
        model.className = 'menu-model';
        model.textContent = p.model;
        item.appendChild(model);
      }

      item.addEventListener('click', function (event) {
        event.stopPropagation();
        switchProvider(p.id);
      });
      menu.appendChild(item);
    });
  }

  function toggleMenu() {
    if (!menu) return;
    if (!menu.hidden) {
      hideMenu();
      return;
    }
    // 菜单和说明气泡都在 dock 左侧，同时出现会叠在一起
    hideTip();
    renderMenu();
    menu.hidden = false;
  }

  function switchProvider(id) {
    hideMenu();
    DT.send({ type: 'provider:set', provider: id }, 5000)
      .then(function (res) {
        if (res && res.ok) {
          DT.toast(DT.uiText('已切换到 ', 'Switched to ') + (res.name || id) + DT.uiText('，重新翻译后生效', ' — retranslate to apply'));
          render();
          return;
        }
        if (res && res.error === 'no_key') DT.toast(DT.uiText('这家服务商还没填 Key', 'No API key for this provider'));
        else DT.toast(DT.uiText('切换失败', 'Switch failed'));
      })
      .catch(function () {
        DT.toast(DT.uiText('切换失败', 'Switch failed'));
      });
  }

  // ---------------- 动作 ----------------
  function run(act) {
    if (act === 'toggle' && DT.control) {
      DT.control.toggle().then(render, render);
      return;
    }
    if (act === 'mode' && DT.control) {
      var next = DT.control.status().mode === 'translation' ? 'dual' : 'translation';
      DT.control.setMode(next);
      // 和弹窗一样记进配置：否则之后配置一广播，状态会被改回去，和页面上的显示对不上
      DT.send({ type: 'mode:set', mode: next }, 5000).catch(function () {});
      render();
      return;
    }
    if (act === 'hover') {
      var next = cfg().hoverCompare === false;
      DT.send({ type: 'hover:set', value: next }, 5000)
        .then(function (res) {
          if (!res || !res.ok) {
            DT.toast(DT.uiText('设置保存失败，请重试', 'Could not save the setting — please retry'));
            render();
            return;
          }
          if (DT.state.config) DT.state.config.hoverCompare = res.value;
          DT.emitConfig(DT.state.config || {});
          render();
        })
        .catch(function () {
          DT.toast(DT.uiText('设置保存失败，请重试', 'Could not save the setting — please retry'));
          render();
        });
      return;
    }
    if (act === 'selection') {
      if (cfg().selectionTranslate === false) {
        DT.toast(DT.uiText('划词翻译已在设置里关闭', 'Selection translation is turned off in Settings'));
        return;
      }
      if (!DT.selectionTranslate || DT.selectionTranslate() === false) {
        DT.toast(DT.uiText('先在网页上选中要翻译的文字', 'Select some text on the page first'));
      }
      return;
    }
    if (act === 'pin' && DT.pip) {
      DT.pip.open();
      return;
    }
    if (act === 'provider') {
      // 触屏没有悬停：点一下弹出服务商列表
      toggleMenu();
    }
  }

  // ---------------- 状态 ----------------
  function render() {
    if (!host) return;
    var c = cfg();
    var html = document.documentElement;
    host.hidden = !!document.fullscreenElement;
    place();
    dock.toggleAttribute('data-auto', c.dockAutoHide !== false);
    dock.toggleAttribute('data-dark', html.getAttribute('data-dt-scheme') === 'dark' || html.getAttribute('data-dt-night') === 'on');
    var st = DT.control ? DT.control.status() : { enabled: false, mode: 'dual' };
    buttons.toggle.setAttribute('aria-pressed', String(!!st.enabled));
    buttons.ball.setAttribute('aria-pressed', String(!!st.enabled));
    buttons.mode.dataset.mode = st.mode;
    buttons.hover.setAttribute('aria-pressed', String(cfg().hoverCompare !== false));
    buttons.pin.hidden = !(DT.pip && DT.pip.supported());
    Object.keys(buttons).forEach(function (act) {
      buttons[act].setAttribute('aria-label', labelOf(act));
    });
    dock.setAttribute('aria-label', DT.uiText('凛狐悬浮入口', 'Rimefox quick actions'));
    // 正在显示的说明换成新文案（比如刚点了开关），不收起
    if (tipFor) showTip(tipFor);
    // 菜单开着时配置变了（比如切换成功）就重画列表
    if (menu && !menu.hidden) renderMenu();
  }

  function mount() {
    if (!host) build();
    var parent = document.body || document.documentElement;
    // 有的单页应用会整个换掉 body：重新挂回去
    if (host.parentNode !== parent) parent.appendChild(host);
    render();
  }

  function unmount() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    setOpen(false);
  }

  function apply(c) {
    if (c && c.dockEnabled === true) mount();
    else unmount();
  }

  DT.onConfig(apply);
  // 给自检用：拿到 closed shadow 里的元素（网页脚本看不到 DT，这里不会泄露）
  DT.dock = {
    root: function () {
      return shadow;
    },
    host: function () {
      return host;
    },
    menu: function () {
      return menu;
    },
    run: run,
    setOpen: setOpen,
    place: place,
    view: viewOf
  };
})();