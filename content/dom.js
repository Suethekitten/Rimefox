// 内容脚本：DOM 引擎
// 切分策略：容器（无直接文本、有多个子元素）→ 逐个下钻；
//          段落（有直接文本，或是叶子元素）→ 整体作为一个单元。
// 注入策略：双语模式把译文追加到【源元素内部末尾】（跟随原布局盒子，
//          不会跑到别的布局上下文里）；仅译文模式原地替换文本节点。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT) return;

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, TITLE: 1, META: 1, LINK: 1,
    IFRAME: 1, FRAME: 1, CANVAS: 1, SVG: 1, VIDEO: 1, AUDIO: 1, OBJECT: 1, EMBED: 1,
    INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, OPTGROUP: 1, DATALIST: 1,
    CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1, MATH: 1, IMG: 1, BR: 1, HR: 1,
    PROGRESS: 1, METER: 1, MAP: 1, AREA: 1
  };

  var BLOCK_TAGS = {
    ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, BODY: 1, DIV: 1, DL: 1, DT: 1, DD: 1,
    FIELDSET: 1, FIGCAPTION: 1, FIGURE: 1, FOOTER: 1, FORM: 1, H1: 1, H2: 1, H3: 1, H4: 1,
    H5: 1, H6: 1, HEADER: 1, HR: 1, LI: 1, MAIN: 1, NAV: 1, OL: 1, P: 1, PRE: 1,
    SECTION: 1, TABLE: 1, TBODY: 1, TD: 1, TFOOT: 1, TH: 1, THEAD: 1, TR: 1, UL: 1,
    CENTER: 1, LEGEND: 1, DETAILS: 1, SUMMARY: 1, DIALOG: 1
  };

  // 这些标签里的文字不是正文：拼文本、原地替换时都要绕开。
  // 否则 <script> 源码会被当正文发给模型；链接里图标的 <svg><title> 会抢走译文，
  // 仅译文模式下可见文字被清空、译文却写进了看不见的 title 里。
  var NON_TEXT_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, SVG: 1, MATH: 1, CANVAS: 1,
    VIDEO: 1, AUDIO: 1, OBJECT: 1, EMBED: 1, IFRAME: 1, FRAME: 1,
    TEXTAREA: 1, SELECT: 1, OPTION: 1, OPTGROUP: 1, DATALIST: 1
  };

  // 行内代码：自己不单独翻，但属于句子的一部分，拼段落文本时要带上
  var INLINE_CODE_TAGS = { CODE: 1, KBD: 1, SAMP: 1, VAR: 1 };

  // 单轮最多收集多少个待翻单元（只算会真正送翻的，见 DT.collect 的 accept）。
  // 超出的部分由下一轮接着收（main.js 看 DT.lastCollectFull）
  var MAX_UNITS = 3000;
  var collectAccept = null;

  DT.placements = [];
  DT.replaced = [];

  // 我们写进页面文本节点的值：MutationObserver 据此忽略自己造成的变更
  var ownWrites = new WeakMap();

  // SVG / MathML 元素在 HTML 文档里的 tagName 是小写（"svg"），统一转大写再查表
  function tagOf(el) {
    return String(el.tagName || '').toUpperCase();
  }

  function styleOf(el) {
    try {
      return getComputedStyle(el);
    } catch (err) {
      return null;
    }
  }

  function isSkipped(el) {
    if (!el || el.nodeType !== 1) return true;
    if (SKIP_TAGS[tagOf(el)]) return true;
    if (el.hasAttribute('data-dt-target')) return true;
    if (el.hasAttribute('data-dt-src')) return true; // 已翻译过
    if (el.closest && el.closest('[data-dt-ui]')) return true;
    if (el.getAttribute('translate') === 'no') return true;
    // 注意：不要因为 aria-hidden 就跳过！
    // 弹层/灯箱打开时，站点会给背景内容统一加 aria-hidden="true"，
    // 但内容明明还在屏幕上——跳过就会导致"点开一张图，整页译文消失"。
    if (el.getAttribute('contenteditable') === '' || el.getAttribute('contenteditable') === 'true') return true;
    if (el.isContentEditable) return true;
    if (el.hidden) return true;
    var cls = el.className;
    if (typeof cls === 'string' && /(^|\s)(notranslate|no-translate)(\s|$)/.test(cls)) return true;
    var cs = styleOf(el);
    if (cs) {
      // 只跳过真正不参与布局的元素。
      // 注意：很多导航下拉菜单、悬浮卡片是用 opacity:0 / visibility:hidden
      // 藏起来的，它们有布局、悬停就会显示 —— 如果也跳过，菜单展开后
      // 里面就是原文（"GAME 下面没翻译"就是这么来的）。
      if (cs.display === 'none') return true;
    }
    return false;
  }

  // 取元素的"纯净文本"：必须排除我们自己注入的译文节点，
  // 否则增量重扫时会把「原文 + 已注入的译文」当成新文本再翻一次，
  // 表现为同一段译文出现两遍（social__text-wrapper 那种）。
  function textOf(el) {
    var parts = [];
    (function visit(node) {
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i += 1) {
        var kid = kids[i];
        if (kid.nodeType === 3) {
          if (kid.nodeValue) parts.push(kid.nodeValue);
        } else if (kid.nodeType === 1) {
          if (kid.hasAttribute('data-dt-target')) continue;
          if (kid.hasAttribute('data-dt-ui')) continue;
          if (NON_TEXT_TAGS[tagOf(kid)]) continue;
          if (kid.tagName === 'BR') {
            parts.push(' ');
            continue;
          }
          visit(kid);
        }
      }
    })(el);
    return DT.normalizeText(parts.join(''));
  }

  function usableChildren(el) {
    var kids = el.children;
    var usable = 0;
    for (var i = 0; i < kids.length; i += 1) {
      if (!isSkipped(kids[i])) usable += 1;
    }
    return usable;
  }

  // 只属于这个元素自己的文本（不含子元素的内容）
  function directText(el) {
    var buf = '';
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i += 1) {
      if (kids[i].nodeType === 3) buf += kids[i].nodeValue;
    }
    return DT.normalizeText(buf);
  }

  // 子元素全被跳过时，父级要翻的文本。不能只拼直接文本节点：
  // "First<br>Second" 会粘成 "FirstSecond"，"Run <code>npm i</code> first" 会变成 "Run first"。
  // <br> 当空格，行内代码照样拼进句子；已翻译 / 隐藏 / 非正文的子元素只留一个分隔空格，
  // 免得把子级已翻过的内容再翻一遍。
  function ownText(el) {
    var parts = [];
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i += 1) {
      var kid = kids[i];
      if (kid.nodeType === 3) {
        parts.push(kid.nodeValue);
      } else if (kid.nodeType === 1) {
        parts.push(INLINE_CODE_TAGS[tagOf(kid)] ? textOf(kid) : ' ');
      }
    }
    return DT.normalizeText(parts.join(''));
  }

  function isStructural(el) {
    if (!el || el.nodeType !== 1) return false;
    if (BLOCK_TAGS[el.tagName]) return true;
    var cs = styleOf(el);
    if (!cs) return false;
    var d = cs.display;
    return (
      d === 'block' || d === 'flex' || d === 'grid' || d === 'list-item' ||
      d === 'table' || d === 'table-row' || d === 'flow-root'
    );
  }

  function isFlexOrGrid(el) {
    var cs = styleOf(el);
    return !!cs && /flex|grid/.test(cs.display);
  }

  // 该不该继续往下拆：
  // 1) flex/grid 容器 = 一排并列的条目，逐个当单元（导航项、头像+昵称行）
  // 2) 有真正的块级子元素 = 结构容器，继续拆
  // 3) 有三个以上并列子元素 = 一列条目（列表、菜单），继续拆
  // 4) 其余（如 <h1><span>Hello</span> <span>World</span></h1>）当一个整体
  function shouldDescend(el) {
    var kids = el.children;
    if (!kids.length) return false;

    var usable = 0;
    var structural = 0;
    for (var i = 0; i < kids.length; i += 1) {
      if (isSkipped(kids[i])) continue;
      usable += 1;
      if (isStructural(kids[i])) structural += 1;
    }
    if (!usable) return false;

    if (isFlexOrGrid(el)) return true;
    if (structural > 0) return true;
    return usable >= 3;
  }

  function addUnit(out, el, text) {
    var unit = { el: el, text: text };
    if (!collectAccept || collectAccept(unit)) out.push(unit);
  }

  function walk(el, out) {
    if (out.length >= MAX_UNITS) return;
    if (!el || el.nodeType !== 1) return;
    if (isSkipped(el)) return;

    var own = directText(el);

    // 1) 真叶子：直接作为一个单元
    if (!el.children.length) {
      var leafText = textOf(el);
      if (leafText) addUnit(out, el, leafText);
      return;
    }

    // 2) 子元素全被跳过（已翻译 / 不可见）：父级不能再整体当单元。
    //    以前这里会 fallback 成"整块翻译"，把子级已注入的译文一起送进去，
    //    于是同一段内容被翻第二遍 —— 重复译文的直接来源。
    if (!usableChildren(el)) {
      if (own) addUnit(out, el, ownText(el));
      return;
    }

    // 3) 有直接文本（段落），或不该继续拆分 → 整体作为一个单元
    if (own || !shouldDescend(el)) {
      // 兜底防线：如果这棵子树里已经有我们注入的译文，说明这里被翻过，
      // 再整块翻一次就会把内容翻第二遍（截图里同一段重复 4 次就是这种
      // 多层容器连环 fallback）。这时只往下处理"还没翻"的子节点。
      if (!own && el.querySelector && el.querySelector('[data-dt-src]')) {
        var inner = el.children;
        for (var k = 0; k < inner.length; k += 1) {
          walk(inner[k], out);
        }
        return;
      }
      var text = textOf(el);
      if (text) addUnit(out, el, text);
      return;
    }

    // 4) 容器 → 逐个下钻
    var kids = el.children;
    for (var i = 0; i < kids.length; i += 1) {
      walk(kids[i], out);
    }
  }

  // 对外：收集页面上所有待翻译单元。
  // accept(unit) 可选：返回 false 的单元不收、也不占 MAX_UNITS 名额
  // （太短、已是目标语言、退避中的段落不该把真正要翻的挤到下一轮）。
  // 收满了会置 DT.lastCollectFull = true，调用方据此安排下一轮接着收。
  DT.lastCollectFull = false;
  DT.collect = function (root, accept) {
    var out = [];
    var start = root || document.body;
    DT.lastCollectFull = false;
    if (!start) return out;
    collectAccept = accept || null;
    try {
      walk(start, out);
    } catch (err) {
      DT.log('collect error', err);
    } finally {
      collectAccept = null;
    }
    DT.lastCollectFull = out.length >= MAX_UNITS;
    DT.log('collect units:', out.length);
    return out;
  };

  // ---------------- 排版继承 ----------------
  function isTransparentColor(value) {
    if (!value) return true;
    if (value === 'transparent') return true;
    return /^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0\s*\)$/.test(value);
  }

  // 译文插在源元素【内部】，本来就会继承字号/颜色；
  // 这里再显式复制一次，防止站点用通配选择器覆盖。
  function copyTypography(node, cs) {
    if (!cs) return;
    if (!isTransparentColor(cs.color)) node.style.color = cs.color;
    if (cs.fontSize) node.style.fontSize = cs.fontSize;
    if (cs.fontWeight) node.style.fontWeight = cs.fontWeight;
    if (cs.lineHeight) node.style.lineHeight = cs.lineHeight;
    if (cs.letterSpacing && cs.letterSpacing !== 'normal') node.style.letterSpacing = cs.letterSpacing;
    if (cs.textTransform && cs.textTransform !== 'none') node.style.textTransform = cs.textTransform;
  }

  function isInlineLike(el) {
    var cs = styleOf(el);
    if (!cs) return false;
    var d = cs.display;
    return d === 'inline' || d === 'inline-block' || d === 'inline-flex';
  }

  function makeNode(sourceEl, text, lang) {
    var inline = isInlineLike(sourceEl);
    var cs = styleOf(sourceEl);
    // 窄容器（图标菜单、竖排侧栏）里长译文会一个字一行，强制不换行
    var narrow = false;
    if (cs) {
      var w = parseFloat(cs.width);
      if (!isNaN(w) && w > 0 && w < 80) narrow = true;
    }
    var node = document.createElement('span');
    node.setAttribute('data-dt-target', '1');
    node.setAttribute('data-dt-lang', lang || '');
    node.className = 'dt-target ' + (inline ? 'dt-inline' : 'dt-block');
    node.textContent = text;
    node.style.cssText = [
      'position: static',
      'float: none',
      'display: ' + (inline ? 'inline' : 'block'),
      'box-sizing: border-box',
      'width: auto',
      'max-width: 100%',
      // 行内译文必须单独给左边距，否则会和原文粘成 "TUTORIALS教程"
      inline ? 'margin: 0 0 0 0.45em' : 'margin: 0.3em 0 0',
      'transform: none',
      'filter: none',
      'z-index: auto'
    ].join('; ') + ';';
    copyTypography(node, styleOf(sourceEl));
    if (narrow) {
      node.style.whiteSpace = 'nowrap';
      node.style.overflow = 'visible';
    }
    return node;
  }

  function record(where, node, sourceEl, text) {
    try {
      DT.placements.push({
        tag: sourceEl.tagName,
        cls: shortCls(sourceEl.className),
        where: where,
        span: !!node && node.tagName === 'SPAN',
        mode: DT.state.mode,
        text: previewText(text)
      });
      if (DT.placements.length > 300) DT.placements.shift();
    } catch (err) {
      /* 诊断记录失败不影响注入 */
    }
  }

  function collectTextNodes(el) {
    var nodes = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (node.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        if (NON_TEXT_TAGS[tagOf(node)]) return NodeFilter.FILTER_REJECT;
        if (node.hasAttribute('data-dt-target') || node.hasAttribute('data-dt-ui')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_SKIP;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 3 && node.nodeValue && node.nodeValue.trim()) nodes.push(node);
    }
    return nodes;
  }

  // 源文本签名：用于判断 SPA 路由切换后，某些元素的内容是否被站点换掉了
  function sigOf(text) {
    var t = String(text || '');
    return t.length + ':' + t.slice(0, 24);
  }

  // 双语：追加到源元素内部末尾
  function injectDual(sourceEl, text, lang) {
    var sourceText = textOf(sourceEl);
    var node = makeNode(sourceEl, text, lang);
    try {
      sourceEl.appendChild(node);
    } catch (err) {
      DT.log('injectDual failed', err);
      return false;
    }
    sourceEl.setAttribute('data-dt-src', '1');
    sourceEl.setAttribute('data-dt-sig', sigOf(sourceText));
    record('inside', node, sourceEl, text);
    return true;
  }

  // 仅译文：原地替换文本节点（保留图标等子元素）
  // 每个节点记下原值和我们写入的值：站点之后改了它（SPA 重渲染），
  // 我们就不能再当它是"已翻译"，还原时也不能拿旧原文盖掉站点的新内容。
  function injectOnly(sourceEl, text) {
    var nodes = collectTextNodes(sourceEl);
    if (!nodes.length) return false;
    var saved = [];
    for (var i = 0; i < nodes.length; i += 1) {
      var wrote = i === 0 ? text : '';
      saved.push({ node: nodes[i], value: nodes[i].nodeValue, wrote: wrote });
      ownWrites.set(nodes[i], wrote);
      nodes[i].nodeValue = wrote;
    }
    DT.replaced.push({ el: sourceEl, nodes: saved });
    sourceEl.setAttribute('data-dt-src', '1');
    sourceEl.setAttribute('data-dt-replaced', '1');
    record('replace', null, sourceEl, text);
    return true;
  }

  // 这个文本节点的当前值是不是我们写进去的（MutationObserver 用来忽略自己的改动）
  DT.isOwnWrite = function (node) {
    return !!node && ownWrites.has(node) && ownWrites.get(node) === node.nodeValue;
  };

  // 被站点改写过的替换型元素：放回"未翻译"，让下一轮按新内容重翻。
  // 还是我们写的值的节点恢复原文，被站点改过的节点保持站点的新内容。
  DT.releaseReplaced = function () {
    var kept = [];
    var released = 0;
    (DT.replaced || []).forEach(function (item) {
      if (!item.el.isConnected) return; // 整块被站点移除了，记录直接丢掉
      var changed = item.nodes.some(function (saved) {
        return !item.el.contains(saved.node) || saved.node.nodeValue !== saved.wrote;
      });
      if (!changed) {
        kept.push(item);
        return;
      }
      item.nodes.forEach(function (saved) {
        if (saved.node.nodeValue === saved.wrote) saved.node.nodeValue = saved.value;
        ownWrites.delete(saved.node);
      });
      item.el.removeAttribute('data-dt-src');
      item.el.removeAttribute('data-dt-replaced');
      released += 1;
    });
    DT.replaced = kept;
    return released;
  };

  function isPositioned(el) {
    var cs = styleOf(el);
    if (!cs) return false;
    var p = cs.position;
    return p === 'fixed' || p === 'sticky' || p === 'absolute';
  }

  // 元素是否是"横向 flex/grid 里的一个格子"（导航项、卡片横排、按钮组）
  function parentIsFlexRow(el) {
    var parent = el.parentElement;
    if (!parent) return false;
    var cs = styleOf(parent);
    if (!cs) return false;
    if (!/flex|grid/.test(cs.display)) return false;
    return !/column/.test(cs.flexDirection || '');
  }

  // ---- 什么时候"原地替换"，什么时候"追加双语" ----
  // 判据要保守：只有真正的控件、以及页面 chrome（导航/小字号单行标签）
  // 才替换；标题、正文一律追加，否则用户会看到"原文被译文顶掉了"。

  var CONTROL_TAGS = { A: 1, BUTTON: 1, LABEL: 1, SUMMARY: 1, OPTION: 1 };

  function isControlLike(el) {
    if (CONTROL_TAGS[el.tagName]) return true;
    var role = String(el.getAttribute('role') || '').toLowerCase();
    return /button|menuitem|tab|option|link|switch|checkbox|radio/.test(role);
  }

  // 单行 + 小字号：导航项、标签、按钮文字这类
  function isSingleLineSmallText(el) {
    var cs = styleOf(el);
    if (!cs) return false;
    var h = parseFloat(cs.height);
    var lh = parseFloat(cs.lineHeight);
    var fs = parseFloat(cs.fontSize);
    if (!h || !lh || !fs) return false;
    return h <= lh * 1.9 && fs <= 20;
  }

  function insideChrome(el) {
    if (!el.closest) return false;
    return !!el.closest('header,nav,[role="navigation"],[role="banner"],[role="menubar"]');
  }

  // 对外：注入一条译文
  DT.inject = function (sourceEl, text, lang) {
    if (!sourceEl || !sourceEl.isConnected) return false;
    if (sourceEl.hasAttribute('data-dt-src')) return false;
    // 防御：站点可能克隆节点并保留属性，这里再确认一次没插过
    if (sourceEl.querySelector && sourceEl.querySelector(':scope > [data-dt-target]')) return false;
    if (!text) return false;

    var small = text.length <= 60;
    // 用户可以选择"界面也保留原文"：那样连导航/按钮都不替换，全都追加
    var allowChromeReplace = !(DT.state.config && DT.state.config.chromeBilingual);
    var replaceMode =
      // 1) 仅译文模式
      DT.state.mode === 'translation' ||
      // 2) 绝对/固定定位：盒子尺寸写死，追加必溢出
      isPositioned(sourceEl) ||
      // 3) 真控件：链接、按钮、菜单项
      (allowChromeReplace && isControlLike(sourceEl) && text.length <= 80) ||
      // 4) 导航/页头里的小字号单行文字
      (allowChromeReplace && small && insideChrome(sourceEl) && isSingleLineSmallText(sourceEl));

    if (replaceMode) return injectOnly(sourceEl, text);
    return injectDual(sourceEl, text, lang);
  };

  // ---------------- 诊断 ----------------
  function shortCls(value) {
    var s = '';
    if (typeof value === 'string') s = value;
    else if (value && value.baseVal) s = value.baseVal;
    return s ? String(s).slice(0, 60) : '';
  }

  function previewText(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    return t.length > 80 ? t.slice(0, 80) + '…' : t;
  }

  DT.diagnose = function (limit) {
    var max = limit || 120;
    var report = {
      version: DT.VERSION,
      url: location.href,
      target: DT.state.target,
      mode: DT.state.mode,
      units: [],
      skipped: []
    };

    function info(el) {
      var cs = styleOf(el);
      return {
        tag: el.tagName,
        cls: shortCls(el.className),
        display: cs ? cs.display : '',
        position: cs ? cs.position : '',
        directText: previewText(directText(el)),
        descend: shouldDescend(el)
      };
    }

    function reason(el) {
      if (SKIP_TAGS[tagOf(el)]) return 'tag-skip:' + el.tagName;
      if (el.hasAttribute('data-dt-target')) return 'our-node';
      if (el.hasAttribute('data-dt-src')) return 'already-translated';
      if (el.closest && el.closest('[data-dt-ui]')) return 'our-ui';
      if (el.getAttribute('translate') === 'no') return 'translate=no';
      if (el.isContentEditable) return 'contenteditable';
      if (el.hidden) return 'hidden-attr';
      var cs = styleOf(el);
      if (cs) {
        if (cs.display === 'none') return 'display:none';
      }
      return '';
    }

    function walkDiag(el) {
      if (report.units.length + report.skipped.length >= max) return;
      if (!el || el.nodeType !== 1) return;

      var why = reason(el);
      if (why) {
        var bad = info(el);
        bad.reason = why;
        bad.text = previewText(el.textContent);
        report.skipped.push(bad);
        return;
      }

      var own = directText(el);

      if (!el.children.length) {
        var leafText = textOf(el);
        if (!leafText) return;
        var leafUnit = info(el);
        leafUnit.text = previewText(leafText);
        leafUnit.length = leafText.length;
        leafUnit.skipByLength = DT.skipText(leafText);
        leafUnit.alreadyTarget = DT.looksLikeTarget(leafText, DT.state.target);
        report.units.push(leafUnit);
        return;
      }

      var text;
      if (!usableChildren(el)) {
        // 子级全被跳过：父级只翻自己的文本（与 walk 一致），不整体重翻
        if (!own) return;
        text = ownText(el);
      } else if (own || !shouldDescend(el)) {
        text = textOf(el);
      }

      if (text !== undefined) {
        if (!text) return;
        var u = info(el);
        u.text = previewText(text);
        u.length = text.length;
        u.skipByLength = DT.skipText(text);
        u.alreadyTarget = DT.looksLikeTarget(text, DT.state.target);
        report.units.push(u);
        return;
      }

      var kids = el.children;
      for (var i = 0; i < kids.length; i += 1) walkDiag(kids[i]);
    }

    if (document.body) walkDiag(document.body);

    report.summary = {
      units: report.units.length,
      skipped: report.skipped.length,
      wouldSkipByText: report.units.filter(function (u) {
        return u.skipByLength;
      }).length,
      wouldSkipByLang: report.units.filter(function (u) {
        return u.alreadyTarget;
      }).length
    };
    report.placements = (DT.placements || []).slice(-80);
    return report;
  };

  // 对外：SPA 路由切换后的"体检"。
  // 不清空整页译文（那会造成整页闪烁重翻），只撤掉那些源文本确实变了的元素。
  DT.refreshStale = function () {
    var marked = document.querySelectorAll('[data-dt-src][data-dt-sig]');
    var removed = DT.releaseReplaced();
    for (var i = 0; i < marked.length; i += 1) {
      var el = marked[i];
      if (el.hasAttribute('data-dt-replaced')) continue; // 替换型不参与比对

      // 站点重渲染把我们的译文节点删了：清标记，让它重新翻
      if (!el.querySelector('[data-dt-target]')) {
        el.removeAttribute('data-dt-src');
        el.removeAttribute('data-dt-sig');
        removed += 1;
        continue;
      }
      var current = sigOf(textOf(el));
      if (current === el.getAttribute('data-dt-sig')) continue;
      var kids = el.querySelectorAll('[data-dt-target]');
      for (var k = 0; k < kids.length; k += 1) kids[k].remove();
      el.removeAttribute('data-dt-src');
      el.removeAttribute('data-dt-sig');
      removed += 1;
    }
    return removed;
  };

  // 对外：还原原文
  DT.restore = function () {
    // 1) 先还原被原地替换的文本。
    //    只还原仍是我们写入值的节点：站点后来改过的（计数、SPA 重渲染）保持站点的新内容，
    //    否则还原后页面会显示过期的旧文字。
    (DT.replaced || []).forEach(function (item) {
      item.nodes.forEach(function (saved) {
        try {
          if (saved.node.nodeValue === saved.wrote) saved.node.nodeValue = saved.value;
          ownWrites.delete(saved.node);
        } catch (err) {
          /* 节点可能已被站点移除 */
        }
      });
    });
    DT.replaced = [];

    // 2) 再移除追加的译文节点
    var targets = document.querySelectorAll('[data-dt-target]');
    for (var i = 0; i < targets.length; i += 1) {
      if (targets[i].closest && targets[i].closest('[data-dt-ui]')) continue;
      targets[i].remove();
    }

    // 3) 清掉标记
    var sources = document.querySelectorAll('[data-dt-src]');
    for (var j = 0; j < sources.length; j += 1) {
      sources[j].removeAttribute('data-dt-src');
      sources[j].removeAttribute('data-dt-sig');
      sources[j].removeAttribute('data-dt-replaced');
    }

    DT.placements = [];
    DT.state.translated = 0;
    DT.state.failed = 0;
    DT.state.skipped = 0;
    DT.state.total = 0;
  };
})();
