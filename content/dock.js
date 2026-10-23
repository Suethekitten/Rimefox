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
  var bodyObserver = null;

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
    // 首次挂载先把 host 藏起来并禁用位移过渡；等实际尺寸 / 保存坐标 / 贴边状态都算好再显示，避免从左上角飞过去。
    ':host([data-init]){visibility:hidden!important;transition:none!important}',
    ':host([data-drag]){transition:none}',
    ':host([hidden]){display:none!important}',
    '@media print{:host{display:none!important}}',
    // 冷调毛玻璃：浅色 rgba(255,255,255,.88) / 深色 rgba(18,22,33,.78)，细描边 + 顶部 1px 内高光 + 深景深阴影
    '.dock{--acc:var(--dt-accent,#6a5cf0);--bg:rgba(255,255,255,.88);--fg:#1d2030;--muted:#64748b;--line:rgba(15,23,42,.1);' +
      '--hi:inset 0 1px 0 rgba(255,255,255,.9);--soft:color-mix(in srgb,var(--acc) 14%,transparent);--hover:rgba(15,23,42,.06);' +
      '--shadow:0 2px 6px rgba(15,23,42,.08),0 16px 36px -12px rgba(15,23,42,.3);' +
      'position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 6px;' +
      'font:13px/1.4 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg);' +
      'transition:transform .32s cubic-bezier(.22,1,.36,1),opacity .2s ease;touch-action:none;cursor:grab}',
    '.dock[data-dark]{--bg:rgba(18,22,33,.78);--fg:#eef0f8;--muted:#94a3b8;--line:rgba(255,255,255,.12);--hi:inset 0 1px 0 rgba(255,255,255,.07);' +
      '--hover:rgba(255,255,255,.08);--shadow:0 2px 6px rgba(0,0,0,.4),0 18px 40px -12px rgba(0,0,0,.7);--acc:color-mix(in srgb,var(--dt-accent,#6a5cf0) 72%,white)}',
    // 自动隐藏：收起时缩进屏幕边缘，只露出半个小球；鼠标移入弹簧滑出。
    // 用 ±50%（相对 .dock 自身宽度）而不是固定的 14px：小球在 .dock 里水平居中，
    // 整块挪半个 dock 宽度 = 把小球圆心挪到视口边上，露出的正好是半个球；
    // 球径、dock 宽度、页面缩放、滚动条都不影响这个比例。
    '.dock[data-auto][data-snapped]:not([data-open]):not([data-drag]){transform:translateX(50%);opacity:.8}',
    ':host([data-side="left"]) .dock[data-auto][data-snapped]:not([data-open]):not([data-drag]){transform:translateX(-50%)}',
    // 拖动中撤掉半隐藏位移（见 onDragMove 的坐标折算），并且不要过渡：否则起拖会滑一下
    '.dock[data-drag]{transition:none}',
    '.dock[data-drag],.dock[data-drag] .ball{cursor:grabbing}',
    '.panel{display:flex;flex-direction:column;gap:3px;padding:5px;border-radius:14px;background:var(--bg);border:1px solid var(--line);' +
      'box-shadow:var(--hi),var(--shadow);-webkit-backdrop-filter:blur(16px) saturate(140%);backdrop-filter:blur(16px) saturate(140%);' +
      'opacity:0;transform:translateY(8px) scale(.96);pointer-events:none;' +
      'transition:opacity .16s ease,transform .22s cubic-bezier(.22,1,.36,1)}',
    '.dock[data-open] .panel,.ball{pointer-events:auto}',
    '.dock[data-open] .panel{opacity:1;transform:none}',
    'button{all:unset;box-sizing:border-box;display:grid;place-items:center;width:32px;height:32px;border-radius:9px;color:var(--fg);cursor:pointer;' +
      'transition:background .15s ease,color .15s ease}',
    'button:hover{background:var(--hover);color:var(--acc)}',
    'button:focus-visible{outline:2px solid var(--acc);outline-offset:1px}',
    // 打开状态的开关：柔和强调色底 + 强调色图标（不用整块实心色）
    'button[aria-pressed="true"]{background:var(--soft);color:var(--acc)}',
    'button[data-act="mode"][data-mode="translation"] svg{transform:scaleY(-1)}',
    '.ball{position:relative;width:36px;height:36px;border-radius:50%;background:var(--bg);border:1px solid var(--line);' +
      'box-shadow:var(--hi),var(--shadow);-webkit-backdrop-filter:blur(16px) saturate(140%);backdrop-filter:blur(16px) saturate(140%)}',
    '.ball img{width:22px;height:22px;display:block;pointer-events:none}',
    '.ball[aria-pressed="true"]{background:var(--bg);box-shadow:var(--hi),var(--shadow)}',
    // 状态点：未开启不显示；翻译中强调色呼吸；已翻译翠绿
    '.ball::after{content:"";position:absolute;right:1px;bottom:1px;width:6px;height:6px;border-radius:50%;' +
      'border:1.5px solid var(--bg);background:transparent;opacity:0;transition:opacity .2s ease,background .2s ease}',
    '.ball[data-state="on"]::after{opacity:1;background:#10b981}',
    '.ball[data-state="busy"]::after{opacity:1;background:var(--acc);animation:dt-dock-pulse 1.2s ease-in-out infinite}',
    '@keyframes dt-dock-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--acc) 55%,transparent)}50%{box-shadow:0 0 0 4px color-mix(in srgb,var(--acc) 0%,transparent)}}',
    '.tip{position:absolute;right:calc(100% + 6px);top:0;max-width:260px;padding:5px 10px;border-radius:8px;background:rgba(15,18,28,.92);color:#fff;' +
      'font-size:12px;line-height:1.45;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0;pointer-events:none;' +
      'box-shadow:0 8px 20px -8px rgba(0,0,0,.4);transition:opacity .12s ease}',
    ':host([data-side="left"]) .tip{right:auto;left:calc(100% + 6px)}',
    '.tip[data-show]{opacity:1}',
    // 服务商切换菜单：从面板侧边弹出，当前项左侧带 ✓
    '.menu{position:absolute;top:0;right:calc(100% + 8px);min-width:180px;max-width:260px;padding:6px;border-radius:14px;' +
      'background:var(--bg);border:1px solid var(--line);box-shadow:var(--hi),var(--shadow);' +
      '-webkit-backdrop-filter:blur(16px) saturate(140%);backdrop-filter:blur(16px) saturate(140%);' +
      'display:flex;flex-direction:column;gap:2px;pointer-events:auto;z-index:1}',
    ':host([data-side="left"]) .menu{right:auto;left:calc(100% + 8px)}',
    '.menu[hidden]{display:none}',
    '.menu-item{all:unset;box-sizing:border-box;display:flex;flex-direction:column;gap:1px;padding:6px 10px 6px 24px;border-radius:9px;cursor:pointer;text-align:left;position:relative}',
    '.menu-item:hover,.menu-item:focus-visible{background:var(--hover)}',
    '.menu-item[aria-current="true"]{background:var(--soft)}',
    '.menu-item[aria-current="true"]::before{content:"✓";position:absolute;left:8px;top:6px;font-size:12px;font-weight:700;color:var(--acc)}',
    '.menu-name{font-size:12.5px;font-weight:600;white-space:nowrap}',
    '.menu-model{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:220px;' +
      'font-family:"JetBrains Mono","SF Mono","Cascadia Code",Consolas,monospace}',
    '.menu-empty{padding:6px 8px;font-size:12px;color:var(--muted)}',
    '@media (prefers-reduced-motion:reduce){:host,.dock,.panel,.tip{transition:none}.ball::after{animation:none}}'
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
      // 小球是拖拽手柄：按下就捕获指针。如果等到第一次 pointermove 再捕获，那次移动
      // 必须由顶层文档收到才行；指针一先滑进页面里的 iframe（广告位、嵌入编辑器），
      // 事件就交给子框架，顶层窗口的 pointermove 永远不触发 —— 拖拽起不来，dock 原地
      // 不动（0.9.5 e2e 实测：从贴左边的小球往页面中间拖，第一步正好落进测试页的 iframe）。
      // 只在小球上捕获，不是整个 dock：捕获会把随后的 click 改投到捕获元素，捕在 .dock
      // 上时面板按钮的 click 就收不到了（0.9.3 实测服务商菜单点不开、翻译按钮没反应）；
      // 小球自己就是那个按钮，click 仍然落在它身上，点按照常生效。
      if (event.target === buttons.ball) {
        try {
          buttons.ball.setPointerCapture(event.pointerId);
        } catch (err) {
          /* 合成事件拿不到捕获：靠 window 监听也能拖 */
        }
      }
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
    window.addEventListener('pageshow', function () {
      if (cfg().dockEnabled === true) mount();
    });
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

  // 半隐藏时 .dock 被 transform 推出的横向位移（像素）；展开 / 自由悬浮 / 拖动中为 0。
  // 读计算样式而不是自己按 50% 算：从悬停展开动画中途开始拖时，也能拿到真实位移。
  function hideShiftX() {
    if (!dock) return 0;
    var t = window.getComputedStyle(dock).transform;
    if (!t || t === 'none') return 0;
    var m = /^matrix\(([^)]+)\)$/.exec(t);
    if (!m) return 0;
    var x = parseFloat(m[1].split(',')[4]);
    return isFinite(x) ? Math.round(x) : 0;
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
      // 半隐藏时 .dock 被 transform 推出视口一半：起拖先把这段位移折算进 host 坐标，
      // 再打开 data-drag（CSS 会撤掉半隐藏位移）。同步改完，小球才不会在起拖瞬间跳一下。
      var hide = hideShiftX();
      // 真正开始拖了才捕获指针：太早捕获会把按钮的 click 抢到 dock 上
      try {
        dock.setPointerCapture(event.pointerId);
      } catch (err) {
        /* 合成事件 / 旧浏览器拿不到捕获：靠 window 监听也能拖 */
      }
      host.setAttribute('data-drag', '');
      dock.setAttribute('data-drag', '');
      if (hide) {
        host.style.left = Math.round(host.getBoundingClientRect().left + hide) + 'px';
        drag.dx -= hide;
      }
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
    paintState(st);
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

  // 小球右下角的状态点：翻译中 / 已翻译。「翻译中」不写在 <html> 属性上，
  // 开着翻译时每 700ms 读一次 DT.control.status()（只是读一个布尔值），关掉就停
  var stateTimer = 0;
  function paintState(st) {
    if (!buttons.ball) return;
    var state = st.busy ? 'busy' : st.enabled ? 'on' : '';
    if (buttons.ball.getAttribute('data-state') !== state) buttons.ball.setAttribute('data-state', state);
    if (st.enabled && !stateTimer && host && host.isConnected) {
      stateTimer = setInterval(function () {
        if (!host || !host.isConnected || !DT.control) {
          clearInterval(stateTimer);
          stateTimer = 0;
          return;
        }
        var now = DT.control.status();
        paintState(now);
        if (!now.enabled) {
          clearInterval(stateTimer);
          stateTimer = 0;
        }
      }, 700);
    }
  }

  // body 被 SPA 整个替换 / 清空时把宿主重新挂回去；这里只观察 html 和 body 的直接子节点，
  // 不开 subtree，避免在全站长文上每次改字都跑回调。
  function watchBody() {
    if (bodyObserver) bodyObserver.disconnect();
    if (!window.MutationObserver) return;
    bodyObserver = new MutationObserver(function () {
      if (!host || cfg().dockEnabled !== true) return;
      var parent = document.body || document.documentElement;
      if (parent && host.parentNode !== parent) mount();
    });
    if (document.body) bodyObserver.observe(document.body, { childList: true });
    if (document.documentElement) bodyObserver.observe(document.documentElement, { childList: true });
  }

  function mount() {
    if (!host) {
      build();
      watchBody();
    }
    var parent = document.body || document.documentElement;
    if (!parent) return;
    // 首次挂载 / body 重建 / 从关闭再打开：先藏起来，量到真实尺寸并算好坐标后再显示。
    var first = host.parentNode !== parent;
    if (first) {
      host.setAttribute('data-init', '');
      parent.appendChild(host);
      // 强制同步布局，让 viewOf() 拿到真实宽高；否则会按兜底尺寸算一次，首帧再跳。
      host.getBoundingClientRect();
      dock.getBoundingClientRect();
    }
    render();
    if (first) {
      // render -> place 已经在 data-init 下写好最终 left/top / data-side / data-snapped；
      // 同一个任务里撤掉隐藏，浏览器第一次绘制就是最终位置，且没有 left/top 过渡。
      host.getBoundingClientRect();
      host.removeAttribute('data-init');
      watchBody();
    }
  }

  function unmount() {
    if (host && host.parentNode) host.parentNode.removeChild(host);
    if (host) host.removeAttribute('data-init');
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