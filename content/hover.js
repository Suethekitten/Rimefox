// 悬停对照：直接消费 dom.js 的 TranslationUnit / SentenceUnit，鼠标停在哪一句就只高亮这一句原文和对应译文。
//
// 句子对应关系，按可信程度依次取：
//   1) 模型的结构化对齐（unit.align）：parts [{n,t}]，n 是覆盖的源句数；sum(n) === 源句数、
//      每个 t 按顺序出现在最终译文里才算数。
//   2) 本地句子对齐（units.alignLocal，0.9.3）：两边按同一套规则断句（缩写、首字母、脚注、小写续接），
//      再用句长 + 数字 / 专名锚点 + 句末语气做动态规划，支持一对多 / 多对一，不确定的句界合并成组。
//      旧缓存、后台重启、模型不按格式输出时都靠它，不发请求。
//   3) 真实换行（<br> / pre-*）两边行数相同 → 行级；再不行 → 段落级。
//
// 双语模式原文和译文都在页面上，只高亮、不弹气泡；仅译文 / Ruby 页面上只剩译文，
// 气泡显示鼠标下这句译文对应的原文（行级 / 段落级时标明范围）。
//
// 高亮用 CSS Custom Highlight API（直接给 Range 上色，不改页面文本节点）；
// 不支持时退回整段标记。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT) return;
  if (DT.hover) return; // 允许重复注入

  var hover = (DT.hover = {});
  var SRC_HL = 'dt-hover-src';
  var TGT_HL = 'dt-hover-target';
  var HAS_HIGHLIGHT = typeof Highlight === 'function' && typeof CSS !== 'undefined' && !!CSS.highlights;
  var U = DT.units;

  var current = null;
  var currentKey = '';
  var cache = null;
  var marked = [];
  var tip = null;

  // 纯函数接口，自检页直接测；句子切分只有 content/units.js 一份实现
  hover.sentencesOf = U.sentencesOf;
  hover.linesOf = function (text) {
    return U.linesOf(text);
  };

  // ---------------- 配对 ----------------

  // 鼠标下的节点属于哪个单元：dom.js 的 nodeUnit 同时覆盖原文、<br>、译文
  hover.unitOf = function (node) {
    return DT.unitOfNode ? DT.unitOfNode(node) : null;
  };

  // 单元里的源句范围（unit.sentences 是段落相对偏移）
  function sentenceSpan(unit, from, to) {
    var list = unit.sentences || [];
    if (!list.length) return [0, (unit.map && unit.map.text.length) || 0];
    var a = list[Math.max(0, Math.min(from, list.length - 1))];
    var b = list[Math.max(0, Math.min(to - 1, list.length - 1))];
    return [a.start, b.end];
  }

  // 源文本 offset 落在第几句
  function sourceSentenceAt(unit, offset) {
    return U.sentenceIndexAt(unit.sentences || [], offset);
  }

  function wholeSpan(text) {
    return [0, String(text || '').length];
  }

  // 对齐的译文偏移必须和「实际渲染出来的目标文本」逐字对得上。
  // 仅译文按行写回 / 模型行数不一致时，joinSlots 的文本与页面文本可能略有差别；
  // 对不上就丢掉模型的映射，改用本地对齐（按页面上实际的译文算），不能让高亮偏一格。
  function usableAlign(unit, targetText) {
    var align = unit && unit.align;
    if (!align || !align.reliable) return null;
    var text = String(targetText || '');
    var parts = align.parts || [];
    for (var i = 0; i < parts.length; i += 1) {
      if (text.slice(parts[i].tgtFrom, parts[i].tgtTo) !== parts[i].text) return null;
    }
    return align;
  }

  // 本地对齐按（单元, 源文本, 译文）记住：同一段里移动鼠标不重算
  var localMemo = typeof WeakMap === 'function' ? new WeakMap() : null;
  function localAlign(unit, targetText) {
    var src = (unit.map && unit.map.text) || '';
    var tgt = String(targetText || '');
    var memo = localMemo && localMemo.get(unit);
    if (memo && memo.src === src && memo.tgt === tgt) return memo.align;
    var align = U.alignLocal(src, unit.sentences || [], tgt);
    if (localMemo) localMemo.set(unit, { src: src, tgt: tgt, align: align });
    return align;
  }

  hover.alignOf = function (unit, targetText) {
    return usableAlign(unit, targetText) || localAlign(unit, targetText);
  };

  // 一组对应在什么范围：一句对一句（或几句合成的一组）是 sentence；
  // 合成的组正好是整行（多行段落）标 line、覆盖整段标 paragraph，气泡要说明范围
  function scopeOf(unit, align, part, srcSpan) {
    var srcCount = part.srcTo - part.srcFrom;
    var tgtCount = part.tgtCount || 1;
    if (srcCount <= 1 && tgtCount <= 1) return 'sentence';
    if ((align.parts || []).length <= 1) return 'paragraph';
    var lines = U.linesOf(unit.map.text);
    if (lines.length > 1) {
      var startsLine = false;
      var endsLine = false;
      for (var i = 0; i < lines.length; i += 1) {
        if (lines[i][0] === srcSpan[0]) startsLine = true;
        if (lines[i][1] === srcSpan[1]) endsLine = true;
      }
      if (startsLine && endsLine) return 'line';
    }
    return 'sentence';
  }

  function pairOf(unit, targetText, align, part) {
    var srcSpan = sentenceSpan(unit, part.srcFrom, part.srcTo);
    return {
      srcSpan: srcSpan,
      tgtSpan: [part.tgtFrom, part.tgtTo],
      scope: scopeOf(unit, align, part, srcSpan),
      sourceText: unit.map.text.slice(srcSpan[0], srcSpan[1]),
      targetText: String(targetText || '').slice(part.tgtFrom, part.tgtTo)
    };
  }

  // 没有句子对齐时：两边都有多行且行数相同 → 行级；否则整段
  function lineOrWhole(unit, targetText, onTarget, offset) {
    var srcText = unit.map.text;
    var srcLines = U.linesOf(srcText);
    var tgtLines = U.linesOf(targetText);
    if (srcLines.length > 1 && srcLines.length === tgtLines.length) {
      var list = onTarget ? tgtLines : srcLines;
      var li = 0;
      for (var i = 0; i < list.length; i += 1) {
        if (offset >= list[i][0]) li = i;
      }
      return {
        srcSpan: srcLines[li],
        tgtSpan: tgtLines[li],
        scope: 'line',
        sourceText: srcText.slice(srcLines[li][0], srcLines[li][1]),
        targetText: targetText.slice(tgtLines[li][0], tgtLines[li][1])
      };
    }
    return {
      srcSpan: wholeSpan(srcText),
      tgtSpan: wholeSpan(targetText),
      scope: 'paragraph',
      sourceText: srcText,
      targetText: targetText
    };
  }

  // 双语：鼠标在源文本（onTarget=false）/ 译文（onTarget=true）的 offset 处，
  // 返回两边要高亮的范围 { srcSpan, tgtSpan, scope, sourceText, targetText }
  hover.pairDual = function (unit, targetText, onTarget, offset) {
    var text = String(targetText || '');
    var align = hover.alignOf(unit, text);
    if (align) {
      var part = onTarget ? U.partAtTargetOffset(align, offset) : U.partAt(align, sourceSentenceAt(unit, offset));
      if (part) return pairOf(unit, text, align, part);
    }
    return lineOrWhole(unit, text, onTarget, offset);
  };

  // 仅译文 / Ruby：页面上显示的是译文。返回 { span, sourceText, scope }
  hover.pairReplaced = function (unit, targetText, offset) {
    var pair = hover.pairDual(unit, targetText, true, offset);
    return { span: pair.tgtSpan, sourceText: pair.sourceText, scope: pair.scope };
  };

  // ---------------- 文本映射：单元文本偏移 ↔ DOM Range ----------------

  // 单元里的译文节点（双语 / Ruby 安全替换）
  function mapFromNode(node) {
    var value = node ? String(node.nodeValue == null ? node.textContent : node.nodeValue) : '';
    var chars = [];
    var textNode = node && node.nodeType === 3 ? node : node && node.firstChild;
    if (!textNode || textNode.nodeType !== 3) return { text: value, chars: [] };
    for (var i = 0; i < textNode.nodeValue.length; i += 1) chars.push({ node: textNode, off: i });
    return { text: textNode.nodeValue, chars: chars };
  }

  // 仅译文模式：译文按行写回原来的文本节点。按行读出当前值（去掉行首缩进，和写回时加上的对齐），
  // 拼成与结果字符串逐字一致的目标文本，并记录每个字对应的节点 / 偏移。
  function mapFromGroups(unit) {
    var text = '';
    var chars = [];
    var groups = unit.groups && unit.groups.filled ? unit.groups.filled : [];
    // 同一个文本节点可能被多行共用（pre-* 里的 \n）：按出现顺序取它的第 n 段。
    // 只被一行使用的节点，整段都算这一行（模型可能把多行合成一段写进来）。
    var useCount = new Map();
    groups.forEach(function (group) {
      var uniq = [];
      (group.pieces || []).forEach(function (piece) {
        if (uniq.indexOf(piece.node) < 0) uniq.push(piece.node);
      });
      uniq.forEach(function (node) {
        useCount.set(node, (useCount.get(node) || 0) + 1);
      });
    });
    var seen = new Map();
    groups.forEach(function (group) {
      var nodes = [];
      (group.pieces || []).forEach(function (piece) {
        if (nodes.indexOf(piece.node) < 0) nodes.push(piece.node);
      });
      if (!nodes.length) return;
      var line = '';
      var segs = [];
      var any = false;
      nodes.forEach(function (node) {
        var ordinal = seen.get(node) || 0;
        seen.set(node, ordinal + 1);
        var value = String(node.nodeValue == null ? '' : node.nodeValue);
        var parts = value.split('\n');
        var shared = (useCount.get(node) || 0) > 1;
        var seg = '';
        var segStart = 0;
        if (!shared) {
          seg = value; // 独占节点：整段都是这一行的渲染结果
        } else if (ordinal < parts.length) {
          seg = parts[ordinal];
          for (var q = 0; q < ordinal; q += 1) segStart += parts[q].length + 1;
        }
        if (seg.trim()) any = true;
        segs.push({ node: node, text: seg, start: segStart });
        line += seg;
      });
      if (!any) return;
      var lead = 0;
      while (lead < line.length && /\s/.test(line.charAt(lead))) lead += 1;
      var trail = line.length;
      while (trail > lead && /\s/.test(line.charAt(trail - 1))) trail -= 1;
      if (text) {
        text += '\n';
        chars.push(null);
      }
      var pos = 0;
      segs.forEach(function (seg) {
        for (var i = 0; i < seg.text.length; i += 1) {
          if (pos + i >= lead && pos + i < trail) {
            text += seg.text.charAt(i);
            chars.push({ node: seg.node, off: seg.start + i });
          }
        }
        pos += seg.text.length;
      });
    });
    return { text: text, chars: chars };
  }

  function targetMapOf(unit) {
    if (unit.renderMode === 'replace') return mapFromGroups(unit);
    if (unit.renderMode === 'ruby') return mapFromNode(unit.targetNode);
    return mapFromNode(unit.targetNode);
  }

  function pointIn(map, offset, isEnd) {
    var chars = map && map.chars ? map.chars : [];
    var len = (map && map.text ? map.text.length : 0);
    var at = Math.max(0, Math.min(Number(offset) || 0, len));
    var i;
    if (isEnd) {
      for (i = at - 1; i >= 0; i -= 1) {
        if (chars[i] && chars[i].node) return { node: chars[i].node, offset: chars[i].off + 1 };
      }
      for (i = at; i < len; i += 1) {
        if (chars[i] && chars[i].node) return { node: chars[i].node, offset: chars[i].off };
      }
      return null;
    }
    for (i = at; i < len; i += 1) {
      if (chars[i] && chars[i].node) return { node: chars[i].node, offset: chars[i].off };
    }
    for (i = len - 1; i >= 0; i -= 1) {
      if (chars[i] && chars[i].node) return { node: chars[i].node, offset: chars[i].off + 1 };
    }
    return null;
  }

  hover.rangeOf = function (map, span) {
    if (!span) return null;
    var a = pointIn(map, span[0], false);
    var b = pointIn(map, span[1], true);
    if (!a || !b) return null;
    try {
      var range = document.createRange();
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      return range;
    } catch (err) {
      return null;
    }
  };

  function offsetIn(map, node, offset) {
    var chars = map && map.chars ? map.chars : [];
    var i;
    for (i = 0; i < chars.length; i += 1) {
      if (chars[i] && chars[i].node === node && chars[i].off === offset) return i;
    }
    // 鼠标落在空白 / <br> 上：取同一节点里不超过 offset 的最近一个字；
    // 都没有就取同一节点的第一个字（不能随便取别的节点，会高亮到别句）
    var best = -1;
    var bestOff = -1;
    for (i = 0; i < chars.length; i += 1) {
      if (!chars[i] || chars[i].node !== node) continue;
      if (chars[i].off <= offset && chars[i].off > bestOff) {
        best = i;
        bestOff = chars[i].off;
      }
      if (best < 0) best = i;
    }
    return best;
  }

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

  // ---------------- 原文 / 译文气泡 ----------------
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

    tip.addEventListener('mouseenter', cancelHide);
    tip.addEventListener('mouseleave', function () {
      if (tipRich) scheduleClear();
    });

    (document.body || document.documentElement).appendChild(tip);
    return tip;
  }

  function scopeLabel(scope) {
    var label = '';
    if (scope === 'paragraph') label = DT.uiText('段落级对应', 'Paragraph-level match');
    else if (scope === 'line') label = DT.uiText('行级对应', 'Line-level match');
    if (!label) return '';
    return label + ' · ' + DT.uiText('原文', 'source');
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

  function tipPreview(text) {
    var full = String(text || '');
    if (full.length <= TIP_PREVIEW_CHARS) return full;
    var cut = TIP_PREVIEW_CHARS;
    var code = full.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    return full.slice(0, cut).replace(/\s+$/, '') + '…';
  }
  hover.tipPreview = tipPreview;

  function insideTip(node) {
    return !!tip && !!node && node.nodeType === 1 && tip.contains(node);
  }

  // 气泡只在页面上看不到原文时出现（仅译文 / Ruby / 原地替换），内容是对应的原文
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
    tipRich = sc === 'paragraph' || sc === 'line' || truncated;
    tip.classList.toggle('is-rich', tipRich);
    tip.classList.toggle('is-plain', !tipRich);
    tip._head.hidden = !tipRich;
    tip._close.hidden = !tipRich;
    tip._actions.hidden = !truncated;
    tip._label.textContent = tipRich ? scopeLabel(sc) : '';
    tip._expand.textContent = DT.uiText('展开全文', 'Show full text');
    tip._close.setAttribute('aria-label', DT.uiText('关闭提示', 'Close'));
    tip._body.textContent = tipPreview(full);
    tip._body.setAttribute('aria-label', DT.uiText('内容，可滚动查看', 'Content, scrollable'));
    tip.hidden = false;
    positionTip(anchor);
    if (tipRich) cancelHide();
  }

  function hideTip(force) {
    cancelHide();
    if (tip) tip.hidden = true;
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

  function markWhole(unit) {
    if (!unit) return;
    if (unit.renderMode === 'replace' || unit.renderMode === 'ruby') {
      var original = unit.map ? unit.map.text : '';
      unit.el.setAttribute('data-dt-hover', 'replaced');
      marked.push(unit.el);
      showTip(unit.el, original, 'paragraph');
      return;
    }
    var target = unit.targetNode;
    if (!target) return;
    unit.el.setAttribute('data-dt-hover', 'src');
    target.setAttribute('data-dt-hover', 'target');
    marked.push(unit.el, target);
  }

  function mapsFor(unit) {
    // 同一个单元、渲染结果没变就复用文本表；替换型单元没有 targetNode，靠 renderedText 判断
    var fresh = cache && cache.unit === unit && cache.rendered === unit.renderedText;
    if (fresh) return cache;
    cache = {
      unit: unit,
      src: unit.renderMode === 'dual' ? unit.map : null,
      tgt: targetMapOf(unit),
      target: unit.targetNode || null,
      rendered: unit.renderedText
    };
    return cache;
  }

  // 鼠标在 (x, y)、落在 node 上：找到那一句并高亮
  hover.updateAt = function (x, y, node) {
    if (tip && tipRich && !tip.hidden && tip.contains(node)) {
      cancelHide();
      return;
    }
    var unit = enabled() ? hover.unitOf(node) : null;
    if (!unit) {
      if (current) {
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
    if (!caret || caret.node.nodeType !== 3) return;
    var maps = mapsFor(unit);
    var tgt = maps.tgt;
    if (!tgt) return;
    var onTarget = !!(unit.targetNode && unit.targetNode.contains(caret.node));
    if (!onTarget && unit.renderMode !== 'dual') {
      // 仅译文模式：页面上的文本节点就是译文节点（写回原来的位置），按目标文本处理
      onTarget = true;
    }

    if (unit.renderMode === 'dual') {
      if (!onTarget && !maps.src) return;
      var from = onTarget ? tgt : maps.src;
      var at = offsetIn(from, caret.node, caret.offset);
      if (at < 0) return;
      var pair = hover.pairDual(unit, tgt.text, onTarget, at);
      if (!pair) return;
      var key = pair.srcSpan.join(':') + '|' + pair.tgtSpan.join(':');
      if (unit === current && key === currentKey) return;
      clear();
      current = unit;
      currentKey = key;
      // 双语：原文和译文都在页面上，只高亮这一组，不弹气泡（气泡会挡住下面的正文）
      paint(SRC_HL, hover.rangeOf(maps.src, pair.srcSpan));
      paint(TGT_HL, hover.rangeOf(tgt, pair.tgtSpan));
      return;
    }

    // 仅译文 / Ruby：高亮鼠标下那句译文，气泡里是原文
    var tat = offsetIn(tgt, caret.node, caret.offset);
    if (tat < 0) return;
    var hit = hover.pairReplaced(unit, tgt.text, tat);
    if (!hit) return;
    var rkey = 'r' + hit.span.join(':');
    if (unit === current && rkey === currentKey) {
      if (tipRich && tip && tip.hidden) showTip(unit.el, hit.sourceText, hit.scope);
      return;
    }
    clear();
    current = unit;
    currentKey = rkey;
    paint(TGT_HL, hover.rangeOf(tgt, hit.span));
    showTip(unit.el, hit.sourceText, hit.scope);
  };

  hover.clear = clear;

  // 鼠标移动每帧最多处理一次：长段落 / 大量 Ruby 页面上，mousemove 可能远高于 60Hz，
  // 每个事件都做 caret + 文本偏移查找会让主线程持续忙。
  var moveRaf = 0;
  var moveArgs = null;
  function flushMove() {
    moveRaf = 0;
    if (!moveArgs) return;
    var args = moveArgs;
    moveArgs = null;
    hover.updateAt(args.x, args.y, args.node);
  }
  // 测试 / 需要立即生效的调用方：把未处理的那一帧鼠标移动立刻执行
  hover.flushMove = function () {
    if (moveRaf) {
      cancelAnimationFrame(moveRaf);
      moveRaf = 0;
    }
    flushMove();
  };
  document.addEventListener(
    'mousemove',
    function (event) {
      moveArgs = { x: event.clientX, y: event.clientY, node: event.target };
      if (!moveRaf) moveRaf = requestAnimationFrame(flushMove);
    },
    { capture: true, passive: true }
  );
  document.addEventListener(
    'mouseout',
    function (event) {
      if (!event.relatedTarget) clear();
    },
    true
  );
  DT.onConfig(function () {
    clear();
  });

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
