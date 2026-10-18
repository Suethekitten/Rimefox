// 悬停对照：鼠标停在已翻译段落的某一句上，只高亮这一句原文和对应的那句译文，移开取消。
//
// 只读 dom.js 注入时留下的标记，不改注入逻辑：
//   双语追加   源元素 [data-dt-src] 的直接子节点 [data-dt-target] 是它的译文
//   原地替换   （仅译文模式、控件 / 导航）原文已经不在页面上 → 高亮鼠标下那句译文，
//             用 DT.replaced 记下的原值弹小气泡，只显示对应的那一句原文
//
// 句子高亮用 CSS Custom Highlight API（CSS.highlights + ::highlight()）：直接给 Range 上色，
// 不拆分、不改动页面的文本节点。样式在 content/styles/inject.css。
// 浏览器不支持这个 API 时退回整段高亮（data-dt-hover 属性）。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT) return;
  if (DT.hover) return; // 允许重复注入

  var hover = (DT.hover = {});
  var SRC_HL = 'dt-hover-src';
  var TGT_HL = 'dt-hover-target';
  var HAS_HIGHLIGHT = typeof Highlight === 'function' && typeof CSS !== 'undefined' && !!CSS.highlights;

  var current = null; // 当前单元
  var currentKey = ''; // 当前高亮的是哪一句（没变就不重画）
  var cache = null; // { unit, src, tgt }：同一个单元里移动时不重复建文本表
  var marked = []; // 退回整段高亮时加过属性的元素
  var tip = null;

  // ---------------- 配对 ----------------

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

  // ---------------- 句子（纯函数，自检直接测） ----------------

  // 句末：西文的 .!?… 后面要跟空白或结尾（避开 3.5、e.g 这种）；中日文的 。！？； 直接断
  var SENT_END = /[.!?…]+["'”’)\]]*(?=\s|$)|[。！？；]+["'”’）」』]*/g;

  // 把文本切成句子：返回 [[start, end], ...]（去掉首尾空白，偏移对应原文本）
  hover.sentencesOf = function (text) {
    var s = String(text || '');
    var out = [];
    var start = 0;
    var m;
    function push(a, b) {
      while (a < b && /\s/.test(s[a])) a += 1;
      while (b > a && /\s/.test(s[b - 1])) b -= 1;
      if (b > a) out.push([a, b]);
    }
    SENT_END.lastIndex = 0;
    while ((m = SENT_END.exec(s))) {
      push(start, m.index + m[0].length);
      start = m.index + m[0].length;
    }
    push(start, s.length);
    return out;
  };

  // 第 i 句对应另一边的第几句：句数相同按序号；不同就按这句的中点在全文里的相对位置找
  hover.alignSentence = function (fromSents, fromLen, toSents, toLen, i) {
    if (!toSents.length || i < 0) return -1;
    if (fromSents.length === toSents.length) return i;
    var s = fromSents[i];
    var pos = ((s[0] + s[1]) / 2 / Math.max(1, fromLen)) * toLen;
    for (var j = 0; j < toSents.length; j += 1) {
      if (pos < toSents[j][1]) return j;
    }
    return toSents.length - 1;
  };

  function sentenceAt(sents, offset) {
    for (var i = 0; i < sents.length; i += 1) {
      if (offset < sents[i][1]) return offset >= sents[i][0] ? i : Math.max(0, i - 1);
    }
    return sents.length - 1;
  }

  // ---------------- 文本表：单元里的文本节点 ↔ 拼起来的文本偏移 ----------------
  var NON_TEXT = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, MATH: 1, TEXTAREA: 1, SELECT: 1 };

  // root 里的文本节点（不含译文节点和我们自己的界面），拼成一段文本并记下每个节点的起点
  hover.textMap = function (root) {
    var nodes = [];
    var text = '';
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (n !== root && (n.hasAttribute('data-dt-target') || n.hasAttribute('data-dt-ui'))) return NodeFilter.FILTER_REJECT;
        if (NON_TEXT[String(n.tagName).toUpperCase()]) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      nodes.push({ node: node, start: text.length });
      text += node.nodeValue;
    }
    return { text: text, nodes: nodes, sents: hover.sentencesOf(text) };
  };

  function offsetIn(map, node, offset) {
    for (var i = 0; i < map.nodes.length; i += 1) {
      if (map.nodes[i].node === node) return map.nodes[i].start + offset;
    }
    return -1;
  }

  function pointIn(map, offset, isEnd) {
    for (var i = 0; i < map.nodes.length; i += 1) {
      var n = map.nodes[i];
      var len = n.node.nodeValue.length;
      if (offset < n.start + len || (isEnd && offset === n.start + len)) return { node: n.node, offset: offset - n.start };
    }
    var last = map.nodes[map.nodes.length - 1];
    return last ? { node: last.node, offset: last.node.nodeValue.length } : null;
  }

  // 第 i 句在页面上的 Range
  hover.rangeOf = function (map, i) {
    var s = map.sents[i];
    if (!s) return null;
    var a = pointIn(map, s[0], false);
    var b = pointIn(map, s[1], true);
    if (!a || !b) return null;
    var range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    return range;
  };

  // 鼠标下是哪个文本节点的第几个字
  function caretAt(x, y) {
    if (document.caretRangeFromPoint) {
      var r = document.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    if (document.caretPositionFromPoint) {
      var p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    return null;
  }

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

  function showTip(anchor, text) {
    ensureTip();
    tip.textContent = text;
    tip.hidden = false;
    var r = anchor.getBoundingClientRect();
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
  function paint(name, range) {
    if (range) CSS.highlights.set(name, new Highlight(range));
    else CSS.highlights.delete(name);
  }

  function clear() {
    if (HAS_HIGHLIGHT) {
      CSS.highlights.delete(SRC_HL);
      CSS.highlights.delete(TGT_HL);
    }
    marked.forEach(function (el) {
      el.removeAttribute('data-dt-hover');
    });
    marked = [];
    current = null;
    currentKey = '';
    hideTip();
  }

  // 不支持 Highlight API 的浏览器：退回整段高亮
  function markWhole(unit) {
    if (unit.hasAttribute('data-dt-replaced')) {
      var original = hover.originalOf(unit);
      if (!original || original === DT.normalizeText(unit.textContent)) return;
      unit.setAttribute('data-dt-hover', 'replaced');
      marked.push(unit);
      showTip(unit, original);
      return;
    }
    var target = hover.targetOf(unit);
    if (!target) return;
    unit.setAttribute('data-dt-hover', 'src');
    target.setAttribute('data-dt-hover', 'target');
    marked.push(unit, target);
  }

  function mapsFor(unit) {
    var fresh =
      cache &&
      cache.unit === unit &&
      cache.src.nodes.every(function (n) {
        return n.node.isConnected;
      });
    if (fresh) return cache;
    var target = unit.hasAttribute('data-dt-replaced') ? null : hover.targetOf(unit);
    cache = { unit: unit, src: hover.textMap(unit), tgt: target ? hover.textMap(target) : null, target: target };
    return cache;
  }

  // 鼠标在 (x, y)、落在 node 上：找到那一句并高亮
  hover.updateAt = function (x, y, node) {
    var unit = enabled() ? hover.unitOf(node) : null;
    if (!unit) {
      if (current) clear();
      return;
    }
    if (!HAS_HIGHLIGHT) {
      if (unit !== current) {
        clear();
        current = unit;
        markWhole(unit);
      }
      return;
    }

    var caret = caretAt(x, y);
    if (!caret || caret.node.nodeType !== 3 || !unit.contains(caret.node)) return;
    var maps = mapsFor(unit);

    if (unit.hasAttribute('data-dt-replaced')) {
      // 页面上显示的是译文：高亮鼠标下那句，气泡里放对应的那句原文
      var page = maps.src;
      var at = offsetIn(page, caret.node, caret.offset);
      if (at < 0 || !page.sents.length) return;
      var i = sentenceAt(page.sents, at);
      var key = 'r' + i;
      if (unit === current && key === currentKey) return;
      clear();
      current = unit;
      currentKey = key;
      paint(TGT_HL, hover.rangeOf(page, i));
      var original = hover.originalOf(unit);
      var origSents = hover.sentencesOf(original);
      var j = hover.alignSentence(page.sents, page.text.length, origSents, original.length, i);
      var sentence = j >= 0 ? original.slice(origSents[j][0], origSents[j][1]) : original;
      if (sentence && DT.normalizeText(sentence) !== DT.normalizeText(page.text.slice(page.sents[i][0], page.sents[i][1]))) {
        showTip(unit, sentence);
      }
      return;
    }

    if (!maps.tgt) return;
    var onTarget = maps.target.contains(caret.node);
    var from = onTarget ? maps.tgt : maps.src;
    var to = onTarget ? maps.src : maps.tgt;
    var pos = offsetIn(from, caret.node, caret.offset);
    if (pos < 0 || !from.sents.length) return;
    var fi = sentenceAt(from.sents, pos);
    var ti = hover.alignSentence(from.sents, from.text.length, to.sents, to.text.length, fi);
    var srcIndex = onTarget ? ti : fi;
    var tgtIndex = onTarget ? fi : ti;
    var k = srcIndex + ':' + tgtIndex;
    if (unit === current && k === currentKey) return;
    clear();
    current = unit;
    currentKey = k;
    paint(SRC_HL, hover.rangeOf(maps.src, srcIndex));
    paint(TGT_HL, hover.rangeOf(maps.tgt, tgtIndex));
  };

  hover.clear = clear;

  document.addEventListener(
    'mousemove',
    function (event) {
      hover.updateAt(event.clientX, event.clientY, event.target);
    },
    { capture: true, passive: true }
  );
  document.addEventListener(
    'mouseout',
    function (event) {
      if (!event.relatedTarget) clear(); // 移出窗口
    },
    true
  );
  // 滚动、点击、按键时收起气泡，免得它停在别的位置上（句子高亮跟着文字走，不用收）
  window.addEventListener('scroll', hideTip, true);
  document.addEventListener('mousedown', hideTip, true);
  document.addEventListener('keydown', hideTip, true);
})();
