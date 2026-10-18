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
    // 服务器：当前服务商
    provider: 'M4 5h16v5H4zM4 14h16v5H4zM8 7.5h.01M8 16.5h.01'
  };

  var CSS = [
    // 只有小球和展开后的面板接收鼠标：收起时看不见的面板区域不能挡住网页
    ':host{all:initial;position:fixed;z-index:2147483644;top:58%;right:0;transform:translateY(-50%);pointer-events:none}',
    ':host([data-side="left"]){right:auto;left:0}',
    ':host([hidden]){display:none!important}',
    '@media print{:host{display:none!important}}',
    '.dock{--acc:var(--dt-accent,#6a5cf0);--bg:rgba(255,255,255,.97);--fg:#1d2030;--line:rgba(20,24,40,.12);--hover:color-mix(in srgb,var(--acc) 14%,transparent);' +
      'position:relative;display:flex;flex-direction:column;align-items:center;gap:8px;padding:8px 6px;' +
      'font:13px/1.4 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg);' +
      'transition:transform .2s ease,opacity .2s ease}',
    '.dock[data-dark]{--bg:rgba(30,32,42,.97);--fg:#eef0f8;--line:rgba(255,255,255,.14);--acc:color-mix(in srgb,var(--dt-accent,#6a5cf0) 72%,white)}',
    // 自动隐藏：收起时只露出小球的一半，半透明
    '.dock[data-auto]:not([data-open]){transform:translateX(40%);opacity:.72}',
    ':host([data-side="left"]) .dock[data-auto]:not([data-open]){transform:translateX(-40%)}',
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
    '@media (prefers-reduced-motion:reduce){.dock,.panel,.tip{transition:none}}'
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
    if (act === 'selection') return DT.uiText('翻译选中的文字', 'Translate selected text');
    if (act === 'pin') return DT.uiText('置顶小窗：划词译文始终在最上层', 'Pinned window: selection translations stay on top');
    if (act === 'provider') {
      var page = cfg().page || {};
      return DT.uiText('当前服务商：', 'Current provider: ') + (page.provider || '—');
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
    ['toggle', 'mode', 'selection', 'pin', 'provider'].forEach(function (act) {
      panel.appendChild(makeButton(act));
    });
    dock.appendChild(panel);
    dock.appendChild(makeButton('ball', 'ball'));
    tip = document.createElement('div');
    tip.className = 'tip';
    tip.setAttribute('role', 'tooltip');
    dock.appendChild(tip);
    shadow.appendChild(dock);

    // 悬停 / 键盘聚焦时展开，移开 / 失焦后收起
    dock.addEventListener('mouseenter', function () {
      clearTimeout(closeTimer);
      openTimer = setTimeout(setOpen.bind(null, true), OPEN_DELAY);
    });
    dock.addEventListener('mouseleave', function () {
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

    // 翻译开关 / 显示方式 / 页面明暗都写在 <html> 的属性上：跟着变
    attrObserver = new MutationObserver(render);
    attrObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-dt', 'data-dt-mode', 'data-dt-scheme', 'data-dt-night']
    });
    document.addEventListener('fullscreenchange', render);
  }

  function setOpen(open) {
    if (!dock) return;
    if (open) dock.setAttribute('data-open', '');
    else {
      dock.removeAttribute('data-open');
      hideTip();
    }
  }

  // ---------------- 说明气泡 ----------------
  var tipFor = null;

  function showTip(btn) {
    clearTimeout(tipTimer);
    if (!tip || !btn) return;
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
      // 触屏没有悬停：点一下用提示条显示
      DT.toast(labelOf('provider'));
    }
  }

  // ---------------- 状态 ----------------
  function render() {
    if (!host) return;
    var c = cfg();
    var html = document.documentElement;
    host.hidden = !!document.fullscreenElement;
    host.setAttribute('data-side', c.dockSide === 'left' ? 'left' : 'right');
    dock.toggleAttribute('data-auto', c.dockAutoHide !== false);
    dock.toggleAttribute('data-dark', html.getAttribute('data-dt-scheme') === 'dark' || html.getAttribute('data-dt-night') === 'on');
    var st = DT.control ? DT.control.status() : { enabled: false, mode: 'dual' };
    buttons.toggle.setAttribute('aria-pressed', String(!!st.enabled));
    buttons.ball.setAttribute('aria-pressed', String(!!st.enabled));
    buttons.mode.dataset.mode = st.mode;
    buttons.pin.hidden = !(DT.pip && DT.pip.supported());
    Object.keys(buttons).forEach(function (act) {
      buttons[act].setAttribute('aria-label', labelOf(act));
    });
    dock.setAttribute('aria-label', DT.uiText('凛狐悬浮入口', 'Rimefox quick actions'));
    // 正在显示的说明换成新文案（比如刚点了开关），不收起
    if (tipFor) showTip(tipFor);
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
    run: run,
    setOpen: setOpen
  };
})();
