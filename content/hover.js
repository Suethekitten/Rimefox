// 悬停对照：鼠标移到某个已翻译单元上，只给这一处的原文和译文同时加高亮，移开取消。
//
// 只读 dom.js 注入时留下的标记，不改注入逻辑：
//   双语追加   源元素 [data-dt-src] 的直接子节点 [data-dt-target] 就是它的译文 → 两者配对高亮
//   原地替换   （仅译文模式、控件 / 导航）原文已经不在页面上 → 用 DT.replaced 记下的原值弹小气泡
//
// 高亮用 data-dt-hover 属性而不是 class：不碰站点自己管理的 className（有些框架重渲染会覆盖）。
// 样式在 content/styles/inject.css，限定在 html[data-dt="on"] 下，还原后自动失效。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT) return;
  if (DT.hover) return; // 允许重复注入

  var hover = (DT.hover = {});
  var current = null; // 当前高亮的源元素
  var currentTarget = null;
  var tip = null;

  // ---------------- 配对（纯 DOM 查询，自检直接测） ----------------

  // 鼠标下的节点属于哪个已翻译单元（最近的 [data-dt-src]）；我们自己的界面不算
  hover.unitOf = function (node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || !el.closest) return null;
    if (el.closest('[data-dt-ui]')) return null;
    return el.closest('[data-dt-src]');
  };

  // 双语单元的译文节点：dom.js 追加在源元素内部末尾
  hover.targetOf = function (src) {
    return (src && src.querySelector(':scope > [data-dt-target]')) || null;
  };

  // 原地替换单元的原文：DT.replaced 里每个文本节点的原值
  hover.originalOf = function (src) {
    var list = DT.replaced || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].el !== src) continue;
      return DT.normalizeText(
        list[i].nodes
          .map(function (saved) {
            return saved.value;
          })
          .join(' ')
      );
    }
    return '';
  };

  function enabled() {
    var cfg = DT.state.config;
    return !!DT.state.enabled && (!cfg || cfg.hoverCompare !== false);
  }

  // ---------------- 原文气泡（原地替换的单元用） ----------------
  function ensureTip() {
    if (tip && tip.isConnected) return tip;
    tip = document.createElement('div');
    tip.setAttribute('data-dt-ui', '1');
    tip.className = 'dt-hover-tip';
    tip.hidden = true;
    (document.body || document.documentElement).appendChild(tip);
    return tip;
  }

  function showTip(src, text) {
    ensureTip();
    tip.textContent = text;
    tip.hidden = false;
    var r = src.getBoundingClientRect();
    var pad = 8;
    var w = tip.offsetWidth;
    var h = tip.offsetHeight;
    var left = Math.min(Math.max(pad, r.left), Math.max(pad, window.innerWidth - w - pad));
    var top = r.bottom + 6;
    if (top + h > window.innerHeight - pad) top = Math.max(pad, r.top - h - 6);
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
  }

  function hideTip() {
    if (tip) tip.hidden = true;
  }

  // ---------------- 高亮 ----------------
  function clear() {
    if (current) current.removeAttribute('data-dt-hover');
    if (currentTarget) currentTarget.removeAttribute('data-dt-hover');
    current = null;
    currentTarget = null;
    hideTip();
  }

  function activate(src) {
    current = src;
    if (src.hasAttribute('data-dt-replaced')) {
      var original = hover.originalOf(src);
      if (original && original !== DT.normalizeText(src.textContent)) {
        src.setAttribute('data-dt-hover', 'replaced');
        showTip(src, original);
      }
      return;
    }
    var target = hover.targetOf(src);
    if (!target) return;
    currentTarget = target;
    src.setAttribute('data-dt-hover', 'src');
    target.setAttribute('data-dt-hover', 'target');
  }

  // 鼠标移到哪个单元就高亮哪个；移到别处（或别的单元）先取消上一处
  hover.update = function (node) {
    var unit = enabled() ? hover.unitOf(node) : null;
    if (unit === current) return;
    clear();
    if (unit) activate(unit);
  };

  hover.clear = clear;

  document.addEventListener(
    'mouseover',
    function (event) {
      hover.update(event.target);
    },
    true
  );
  document.addEventListener(
    'mouseout',
    function (event) {
      if (!event.relatedTarget) clear(); // 移出窗口
    },
    true
  );
  // 滚动、点击、按键时收起气泡，免得它停在别的位置上
  window.addEventListener('scroll', hideTip, true);
  document.addEventListener('mousedown', hideTip, true);
  document.addEventListener('keydown', hideTip, true);
})();
