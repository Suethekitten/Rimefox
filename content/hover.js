// 悬停对照：鼠标停在已翻译段落的某一句上，只高亮这一句原文和对应的那句译文，移开取消。
//
// 只读 dom.js 注入时留下的标记，不改注入逻辑：
//   双语追加   源元素 [data-dt-src] 的直接子节点 [data-dt-target] 是它的译文
//   原地替换   （仅译文模式、控件 / 导航）原文已经不在页面上 → 高亮鼠标下那句译文，
//             用 DT.replacedOf 记下的原文弹小气泡
//
// 对应关系从粗到细，只认靠得住的那一层：
//   段落   一个翻译单元就是一段，原文和译文一定对应
//   行     原文有分行（<br> / pre-*）且译文行数相同 → 第 i 行对第 i 行
//   句子   行（或段）里两边句数相同，并且每个句界在各自范围里的相对位置接近 → 第 i 句对第 i 句
// 句子对不上（模型合并 / 拆分 / 调换了句子）就退回整行或整段：高亮范围和气泡都放大到那一层，
// 不拿按长度比例猜出来的句子冒充精确对照。
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

  // 原地替换单元的原文（保留分行）；老记录没有 src 时退回拼各文本节点的原值
  hover.originalOf = function (src) {
    var item = DT.replacedOf ? DT.replacedOf(src) : null;
    if (!item) return '';
    if (item.src) return item.src;
    return DT.normalizeText(
      item.nodes
        .map(function (saved) {
          return saved.value;
        })
        .join(' ')
    );
  };

  // ---------------- 句子（纯函数，自检直接测） ----------------

  // 句末：西文的 .!?… 后面要跟空白或结尾（避开 3.5、e.g 这种）；中日文的 。！？； 直接断；换行一定断。
  // 引号 / 括号里的句号不断句：「じゃーん。今日は？」“好的。”他说。都是一句。
  // 只跟踪分得清左右的括号；直引号 " ' 分不清开合，交给西文规则（标点后要有空白）
  var OPEN = '「『“（《〈【';
  var CLOSE = '」』”）》〉】';
  var CJK_END = '。！？；';
  var WEST_END = '.!?…';
  var TRAIL = '"\'”’)]」』）';

  function isSpace(c) {
    return !!c && /\s/.test(c);
  }

  // 把文本切成句子：返回 [[start, end], ...]（去掉首尾空白，偏移对应原文本）
  hover.sentencesOf = function (text) {
    var s = String(text || '');
    var out = [];
    var start = 0;
    var depth = 0;
    function cut(end) {
      var a = start;
      var b = end;
      while (a < b && isSpace(s[a])) a += 1;
      while (b > a && isSpace(s[b - 1])) b -= 1;
      if (b > a) out.push([a, b]);
      start = end;
    }
    var i = 0;
    while (i < s.length) {
      var c = s[i];
      if (c === '\n') {
        cut(i);
        depth = 0; // 引号跨行没闭合：下一行重新算
        i += 1;
        continue;
      }
      if (OPEN.indexOf(c) >= 0) {
        depth += 1;
        i += 1;
        continue;
      }
      if (CLOSE.indexOf(c) >= 0 && depth > 0) {
        depth -= 1;
        i += 1;
        // 「……。」收尾：后面是空白 / 行尾 / 下一段引号才断，「……。」と言った 这种接着往下
        if (!depth && (CJK_END + WEST_END).indexOf(s[i - 2]) >= 0 && (i >= s.length || isSpace(s[i]) || OPEN.indexOf(s[i]) >= 0)) cut(i);
        continue;
      }
      if (!depth && CJK_END.indexOf(c) >= 0) {
        var j = i + 1;
        while (j < s.length && (CJK_END.indexOf(s[j]) >= 0 || TRAIL.indexOf(s[j]) >= 0)) j += 1;
        cut(j);
        i = j;
        continue;
      }
      if (!depth && WEST_END.indexOf(c) >= 0) {
        var k = i + 1;
        while (k < s.length && (WEST_END.indexOf(s[k]) >= 0 || TRAIL.indexOf(s[k]) >= 0)) k += 1;
        if (k >= s.length || isSpace(s[k])) cut(k);
        i = k;
        continue;
      }
      i += 1;
    }
    cut(s.length);
    return out;
  };

  // 非空的行：[[start, end], ...]（去掉行首尾空白）
  hover.linesOf = function (text) {
    var s = String(text || '');
    var out = [];
    var start = 0;
    for (var i = 0; i <= s.length; i += 1) {
      if (i < s.length && s[i] !== '\n') continue;
      var a = start;
      var b = i;
      while (a < b && isSpace(s[a])) a += 1;
      while (b > a && isSpace(s[b - 1])) b -= 1;
      if (b > a) out.push([a, b]);
      start = i + 1;
    }
    return out;
  };

  // span 范围里的句子（偏移仍对应整段文本）
  function sentencesIn(text, span) {
    return hover.sentencesOf(String(text || '').slice(span[0], span[1])).map(function (r) {
      return [r[0] + span[0], r[1] + span[0]];
    });
  }

  function spanOf(x) {
    return typeof x === 'number' ? [0, x] : x;
  }

  // 两边的句子能不能一一对应：句数相同，且每个句界在各自范围里的相对位置相差不超过 SENT_DRIFT。
  // 位置只用来否决：一边合并、一边拆分凑出相同句数时，句界会明显错开
  hover.SENT_DRIFT = 0.25;
  hover.sentencesAgree = function (a, aSpan, b, bSpan) {
    if (!a.length || a.length !== b.length) return false;
    var sa = spanOf(aSpan);
    var sb = spanOf(bSpan);
    var la = Math.max(1, sa[1] - sa[0]);
    var lb = Math.max(1, sb[1] - sb[0]);
    for (var i = 0; i < a.length - 1; i += 1) {
      var pa = (a[i][1] - sa[0]) / la;
      var pb = (b[i][1] - sb[0]) / lb;
      if (Math.abs(pa - pb) > hover.SENT_DRIFT) return false;
    }
    return true;
  };

  // 第 i 句对应另一边的第几句：句子能一一对应时就是 i；对不上返回 -1，
  // 调用方退回整行 / 整段（不按相对位置去猜）。范围可以传 [start, end] 或文本长度
  hover.alignSentence = function (fromSents, fromSpan, toSents, toSpan, i) {
    if (i < 0 || i >= fromSents.length) return -1;
    return hover.sentencesAgree(fromSents, fromSpan, toSents, toSpan) ? i : -1;
  };

  // offset 落在第几个范围里（落在两个范围之间算前一个）
  function indexAt(ranges, offset) {
    for (var i = 0; i < ranges.length; i += 1) {
      if (offset < ranges[i][1]) return offset >= ranges[i][0] ? i : Math.max(0, i - 1);
    }
    return ranges.length - 1;
  }

  function wholeOf(lines, len) {
    return lines.length ? [lines[0][0], lines[lines.length - 1][1]] : [0, len];
  }

  // 双语：鼠标在 fromText 的 at 处，返回两边要高亮的范围 { from, to, scope }。
  // 两边行数相同按行配对，否则整段配对；行 / 段里再看句子能不能一一对应
  hover.matchDual = function (fromText, toText, at) {
    var fl = hover.linesOf(fromText);
    var tl = hover.linesOf(toText);
    if (!fl.length || !tl.length) return null;
    var byLine = fl.length === tl.length;
    var L = byLine ? indexAt(fl, at) : 0;
    var fromSpan = byLine ? fl[L] : wholeOf(fl, fromText.length);
    var toSpan = byLine ? tl[L] : wholeOf(tl, toText.length);
    var fs = sentencesIn(fromText, fromSpan);
    var ts = sentencesIn(toText, toSpan);
    var i = indexAt(fs, at);
    var j = hover.alignSentence(fs, fromSpan, ts, toSpan, i);
    if (j >= 0) return { from: fs[i], to: ts[j], scope: 'sentence' };
    return { from: fromSpan, to: toSpan, scope: byLine ? 'line' : 'paragraph' };
  };

  // 原地替换：页面上显示的是译文 pageText，鼠标在 at 处；item 是 DT.replacedOf 的记录
  // （src 原文、lines 原文各行、aligned 译文是否逐行写回）。
  // 返回 { span: 页面上要高亮的范围, tip: 气泡里的原文, scope }
  hover.matchReplaced = function (pageText, at, item) {
    var orig = (item && item.src) || '';
    var pl = hover.linesOf(pageText);
    if (!orig || !pl.length) return null;
    var span = wholeOf(pl, pageText.length);
    var scope = 'paragraph';
    var srcLines = item.lines || [];
    if (item.aligned && srcLines.length === pl.length) {
      var L = indexAt(pl, at);
      span = pl[L];
      orig = srcLines[L];
      scope = 'line';
    }
    var ps = sentencesIn(pageText, span);
    var os = hover.sentencesOf(orig);
    var i = indexAt(ps, at);
    var j = hover.alignSentence(ps, span, os, orig.length, i);
    if (j >= 0) return { span: ps[i], tip: orig.slice(os[j][0], os[j][1]), scope: 'sentence' };
    return { span: span, tip: orig, scope: scope };
  };

  // ---------------- 文本表：单元里的文本节点 ↔ 拼起来的文本偏移 ----------------
  var NON_TEXT = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, MATH: 1, TEXTAREA: 1, SELECT: 1 };

  // root 里的文本节点（不含译文节点、我们自己的界面、隐藏子树），拼成一段文本并记下每个节点的起点。
  // <br> 记成一个换行（不对应任何节点；收起的不算）。不保留换行的元素里，源码折行的 \n 按空格算
  // （长度不变，偏移照样对得上），和 dom.js 送翻时的分行规则一致
  hover.textMap = function (root) {
    var nodes = [];
    var text = '';
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (n !== root && (n.hasAttribute('data-dt-target') || n.hasAttribute('data-dt-ui'))) return NodeFilter.FILTER_REJECT;
        var tag = String(n.tagName).toUpperCase();
        if (NON_TEXT[tag]) return NodeFilter.FILTER_REJECT;
        if (tag === 'BR') return n.hasAttribute('data-dt-collapsed') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        if (n !== root && (n.hidden || getComputedStyle(n).display === 'none')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_SKIP;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 1) {
        text += '\n';
        continue;
      }
      var value = node.nodeValue;
      var cs = node.parentElement ? getComputedStyle(node.parentElement) : null;
      if (!cs || !DT.keepsLineBreaks(cs.whiteSpace, cs.whiteSpaceCollapse)) value = value.replace(/[\r\n]/g, ' ');
      nodes.push({ node: node, start: text.length, len: value.length });
      text += value;
    }
    return { text: text, nodes: nodes };
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
      // 落在 <br> 记的那个换行上时取下一个节点的开头
      if (offset < n.start + len || (isEnd && offset === n.start + len)) return { node: n.node, offset: Math.max(0, offset - n.start) };
    }
    var last = map.nodes[map.nodes.length - 1];
    return last ? { node: last.node, offset: last.node.nodeValue.length } : null;
  }

  // 文本里 [start, end) 这一段在页面上的 Range
  hover.rangeOf = function (map, span) {
    if (!span) return null;
    var a = pointIn(map, span[0], false);
    var b = pointIn(map, span[1], true);
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
  // 短句：轻量纯文本，pointer-events:none，不打断阅读。
  // 长段落：有上限的富气泡（预览 + 展开 / 收起 / 关闭），允许鼠标移进去滚动查看。
  var TIP_PREVIEW_CHARS = 180;
  var TIP_HIDE_DELAY = 200;
  var tipText = '';
  var tipScope = '';
  var tipFull = '';
  var tipExpanded = false;
  var tipRich = false;
  var tipAnchor = null;
  var tipTimer = 0;

  function ensureTip() {
    if (tip && tip.isConnected) return tip;
    tip = document.createElement('div');
    tip.setAttribute('data-dt-ui', '1');
    tip.className = 'dt-hover-tip';
    tip.hidden = true;
    tip.setAttribute('role', 'dialog');

    var head = document.createElement('div');
    head.className = 'dt-hover-head';
    var label = document.createElement('span');
    label.className = 'dt-hover-label';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'dt-hover-close';
    close.textContent = '×';
    close.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      clear();
    });
    head.appendChild(label);
    head.appendChild(close);

    var body = document.createElement('div');
    body.className = 'dt-hover-body';
    body.setAttribute('tabindex', '0');

    var actions = document.createElement('div');
    actions.className = 'dt-hover-actions';
    var expand = document.createElement('button');
    expand.type = 'button';
    expand.className = 'dt-hover-expand';
    expand.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      toggleExpand();
    });
    actions.appendChild(expand);

    tip.appendChild(head);
    tip.appendChild(body);
    tip.appendChild(actions);
    tip._head = head;
    tip._label = label;
    tip._close = close;
    tip._body = body;
    tip._actions = actions;
    tip._expand = expand;

    // 鼠标能从原文移进气泡，不能一离开锚点就消失
    tip.addEventListener('mouseenter', cancelHide);
    tip.addEventListener('mouseleave', function () {
      if (tipRich) scheduleClear();
    });

    (document.body || document.documentElement).appendChild(tip);
    return tip;
  }

  function scopeLabel(scope, truncated) {
    if (scope === 'paragraph') {
      return DT.uiText('段落级对应', 'Paragraph-level match') + (truncated ? ' · ' + DT.uiText('原文节选', 'excerpt') : '');
    }
    if (scope === 'line') return DT.uiText('行级对应', 'Line-level match');
    return '';
  }

  function positionTip(anchor) {
    if (!tip || tip.hidden || !anchor) return;
    var pad = 8;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var r = anchor.getBoundingClientRect();
    var w = tip.offsetWidth;
    var h = tip.offsetHeight;
    var left = Math.min(Math.max(pad, r.left), Math.max(pad, vw - w - pad));
    var top = r.bottom + 6;
    if (top + h > vh - pad) top = Math.max(pad, r.top - h - 6);
    if (top + h > vh - pad) top = Math.max(pad, vh - h - pad);
    tip.style.left = Math.round(left) + 'px';
    tip.style.top = Math.round(top) + 'px';
  }

  function toggleExpand() {
    if (!tip) return;
    tipExpanded = !tipExpanded;
    tip._body.textContent = tipExpanded ? tipFull : tipPreview(tipFull);
    tip._expand.textContent = tipExpanded ? DT.uiText('收起', 'Collapse') : DT.uiText('展开全文', 'Show full text');
    tip._body.scrollTop = 0;
    positionTip(tipAnchor);
  }

  // 长原文的节选：前 TIP_PREVIEW_CHARS 个字，去掉截断处的空白再加省略号。
  // 以前写成 /s+$/（字母 s），英文节选末尾的 s 会被吃掉、空白反而留着。
  // 截断点落在代理对中间（emoji、扩展区汉字）时往前退一位，不留半个字
  function tipPreview(text) {
    var full = String(text || '');
    if (full.length <= TIP_PREVIEW_CHARS) return full;
    var cut = TIP_PREVIEW_CHARS;
    var code = full.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    return full.slice(0, cut).replace(/\s+$/, '') + '…';
  }
  hover.tipPreview = tipPreview; // 自检直接测

  // 节点在不在原文气泡里（气泡正文滚动、点按钮都发生在这里面）
  function insideTip(node) {
    return !!tip && !!node && node.nodeType === 1 && tip.contains(node);
  }

  function showTip(anchor, text, scope) {
    ensureTip();
    var full = String(text || '');
    var truncated = full.length > TIP_PREVIEW_CHARS;
    var sc = scope || 'sentence';
    tipText = full;
    tipScope = sc;
    tipFull = full;
    tipExpanded = false;
    tipAnchor = anchor;
    // 段落 / 行级对应必须明确标识；长句即使 scope=sentence 也要能展开
    tipRich = sc === 'paragraph' || sc === 'line' || truncated;
    tip.classList.toggle('is-rich', tipRich);
    tip.classList.toggle('is-plain', !tipRich);
    tip._head.hidden = !tipRich;
    tip._close.hidden = !tipRich;
    tip._actions.hidden = !truncated;
    tip._label.textContent = tipRich ? scopeLabel(sc, truncated) : '';
    tip._expand.textContent = DT.uiText('展开全文', 'Show full text');
    tip._close.setAttribute('aria-label', DT.uiText('关闭原文提示', 'Close source text'));
    tip._body.textContent = tipPreview(full);
    tip._body.setAttribute('aria-label', DT.uiText('原文内容，可滚动查看', 'Source text, scrollable'));
    tip.hidden = false;
    positionTip(anchor);
    if (tipRich) cancelHide();
  }

  function hideTip(force) {
    cancelHide();
    if (tip) tip.hidden = true;
    // 保留 tipText / tipScope：滚动或点击暂时收起后，鼠标回到同一句要能重新显示
    if (force) {
      tipRich = false;
      tipAnchor = null;
    }
  }

  function scheduleClear() {
    cancelHide();
    tipTimer = setTimeout(function () {
      tipTimer = 0;
      clear();
    }, TIP_HIDE_DELAY);
  }

  function cancelHide() {
    if (tipTimer) {
      clearTimeout(tipTimer);
      tipTimer = 0;
    }
  }

  // ---------------- 高亮 ----------------
  function paint(name, range) {
    if (range) CSS.highlights.set(name, new Highlight(range));
    else CSS.highlights.delete(name);
  }

  function clear() {
    cancelHide();
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
    cache = null;
    hideTip(true);
    tipText = '';
    tipScope = '';
    tipFull = '';
    tipExpanded = false;
    tipRich = false;
    tipAnchor = null;
  }

  // 不支持 Highlight API 的浏览器：退回整段高亮
  function markWhole(unit) {
    if (unit.hasAttribute('data-dt-replaced')) {
      var original = hover.originalOf(unit);
      if (!original || DT.normalizeText(original) === DT.normalizeText(unit.textContent)) return;
      unit.setAttribute('data-dt-hover', 'replaced');
      marked.push(unit);
      showTip(unit, original, 'paragraph');
      return;
    }
    var target = hover.targetOf(unit);
    if (!target) return;
    unit.setAttribute('data-dt-hover', 'src');
    target.setAttribute('data-dt-hover', 'target');
    marked.push(unit, target);
  }

  // 同一个单元里移动时复用文本表；节点被换掉、或者文字变了（重新翻译、切换模式）就重建
  function mapsFor(unit) {
    var fresh =
      cache &&
      cache.unit === unit &&
      [cache.src, cache.tgt].every(function (map) {
        return (
          !map ||
          map.nodes.every(function (n) {
            return n.node.isConnected && n.node.nodeValue.length === n.len;
          })
        );
      });
    if (fresh) return cache;
    var target = unit.hasAttribute('data-dt-replaced') ? null : hover.targetOf(unit);
    cache = { unit: unit, src: hover.textMap(unit), tgt: target ? hover.textMap(target) : null, target: target };
    return cache;
  }

  // 鼠标在 (x, y)、落在 node 上：找到那一句并高亮
  hover.updateAt = function (x, y, node) {
    // 鼠标在长气泡里滚动 / 点按钮：不要把它当成"移到空白处"而收起
    if (tip && tipRich && !tip.hidden && tip.contains(node)) {
      cancelHide();
      return;
    }
    var unit = enabled() ? hover.unitOf(node) : null;
    if (!unit) {
      if (current) {
        // 长气泡允许鼠标从原文移进去；给它一点时间，短句仍然立即消失
        if (tipRich && !tip.hidden) scheduleClear();
        else clear();
      }
      return;
    }
    cancelHide();
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
      // 页面上显示的是译文：高亮鼠标下那句（对不上时是那一行 / 整段），气泡里放对应的原文
      var page = maps.src;
      var at = offsetIn(page, caret.node, caret.offset);
      if (at < 0) return;
      var hit = hover.matchReplaced(page.text, at, DT.replacedOf(unit));
      if (!hit) return;
      var key = 'r' + hit.span.join(':');
      if (unit === current && key === currentKey) {
        if (tipRich && tip && tip.hidden) showTip(unit, tipText, tipScope);
        return;
      }
      clear();
      current = unit;
      currentKey = key;
      paint(TGT_HL, hover.rangeOf(page, hit.span));
      if (DT.normalizeText(hit.tip) !== DT.normalizeText(page.text.slice(hit.span[0], hit.span[1]))) {
        showTip(unit, hit.tip, hit.scope);
      }
      return;
    }

    if (!maps.tgt) return;
    var onTarget = maps.target.contains(caret.node);
    var from = onTarget ? maps.tgt : maps.src;
    var to = onTarget ? maps.src : maps.tgt;
    var pos = offsetIn(from, caret.node, caret.offset);
    if (pos < 0) return;
    var pair = hover.matchDual(from.text, to.text, pos);
    if (!pair) return;
    var srcSpan = onTarget ? pair.to : pair.from;
    var tgtSpan = onTarget ? pair.from : pair.to;
    var k = srcSpan.join(':') + '|' + tgtSpan.join(':');
    if (unit === current && k === currentKey) return;
    clear();
    current = unit;
    currentKey = k;
    paint(SRC_HL, hover.rangeOf(maps.src, srcSpan));
    paint(TGT_HL, hover.rangeOf(maps.tgt, tgtSpan));
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
  // 配置变更（设置页 / 弹窗 / 悬浮入口）要主动清理，不能等鼠标再动
  DT.onConfig(function () {
    clear();
  });

  // 网页滚动后锚点位置失效，整组清掉；点击页面只收气泡，保留高亮。
  // 捕获阶段也会收到元素自己的滚动：气泡正文在滚（读展开后的长原文、收起时 scrollTop 归零）
  // 不能算网页滚动，否则读到一半气泡就没了。网页其它容器在滚照样清掉
  window.addEventListener(
    'scroll',
    function (event) {
      if (insideTip(event.target)) return;
      clear();
    },
    true
  );
  document.addEventListener(
    'mousedown',
    function (event) {
      if (tip && tipRich && !tip.hidden && insideTip(event.target)) return;
      clear();
    },
    true
  );
  document.addEventListener(
    'keydown',
    function (event) {
      if (event.key === 'Escape') {
        clear();
        return;
      }
      if (!tipRich) hideTip(true);
    },
    true
  );
})();