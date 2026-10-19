// 内容脚本：DOM 引擎
// 切分策略：容器（无直接文本、有多个子元素）→ 逐个下钻；
//          段落（有直接文本，或是叶子元素）→ 整体作为一个单元。
// 注入策略：双语模式把译文追加到【源元素内部末尾】（跟随原布局盒子，
//          不会跑到别的布局上下文里）；仅译文模式原地替换文本节点。
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT) return;
  // 允许重复注入（见 core.js）：再跑一次会清空 DT.replaced，仅译文模式下「还原」就找不回原文了
  if (DT.__domReady) return;
  DT.__domReady = true;

  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, TITLE: 1, META: 1, LINK: 1,
    IFRAME: 1, FRAME: 1, CANVAS: 1, SVG: 1, VIDEO: 1, AUDIO: 1, OBJECT: 1, EMBED: 1,
    INPUT: 1, TEXTAREA: 1, SELECT: 1, OPTION: 1, OPTGROUP: 1, DATALIST: 1,
    CODE: 1, PRE: 1, KBD: 1, SAMP: 1, VAR: 1, MATH: 1, IMG: 1, BR: 1, HR: 1,
    PROGRESS: 1, METER: 1, MAP: 1, AREA: 1,
    // 振假名：<ruby>漢字<rt>かんじ</rt></ruby> 里的 <rt> 是读音、<rp> 是给不支持 ruby 的浏览器的括号，
    // 都不是正文。以前会被单独收成段落送翻，再叠一行「かんじ」的译文（Pixiv 的注音页最明显）
    RT: 1, RP: 1
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
    TEXTAREA: 1, SELECT: 1, OPTION: 1, OPTGROUP: 1, DATALIST: 1,
    // 读音 / 注音括号：拼段落文本时绕开，只剩汉字本体（ruby 的基字仍算正文）
    RT: 1, RP: 1
  };

  // 行内代码：自己不单独翻，但属于句子的一部分，拼段落文本时要带上
  var INLINE_CODE_TAGS = { CODE: 1, KBD: 1, SAMP: 1, VAR: 1 };

  // 单轮最多收集多少个待翻单元（只算会真正送翻的，见 DT.collect 的 accept）。
  // 超出的部分由下一轮接着收（main.js 看 DT.lastCollectFull）
  var MAX_UNITS = 3000;
  var collectAccept = null;

  DT.placements = [];
  DT.replaced = [];

  // ---------------- 0.9.1 单元模型 ----------------
  // 一个 TranslationUnit = 一个 ParagraphUnit（语义段落），不再等于一个 HTMLElement：
  // 同一个容器里的「段1<br><br>段2」会形成两个单元，各有自己的插入锚点。
  //
  // 真相分三层：
  //   unit      收集阶段的段落（text / map / sentences / anchor / groups）
  //   rendered  已经写进页面的记录（mode / node / ops / saved），去重和还原都读它
  //   tx        RenderTransaction：所有 DOM 修改的操作日志，restore 逆序回放
  // nodeUnit 把原文节点 / <br> / 译文节点映射回所属单元，悬停不再自己解析一套。
  var unitSeq = 0;
  var rendered = [];
  var renderedByEl = new WeakMap(); // 元素 → 该元素已渲染的记录：去重时只看这个元素的几段
  var tx = [];
  var nodeUnit = new WeakMap();
  var elUnits = new WeakMap(); // 共用容器的多个段落：元素 → 单元列表（悬停兜底解析）
  var ownNodes = new WeakSet();
  DT.generation = 1;

  // 作废旧一轮的注入（模式切换、还原、重译、SPA 重建）：带旧代际的 unit 不能再写页面
  DT.bumpGeneration = function () {
    DT.generation += 1;
    return DT.generation;
  };

  // MutationObserver 用：判断一个节点是不是我们自己造成的
  DT.isOwnNode = function (node) {
    if (!node) return false;
    if (node.nodeType === 1) {
      return node.hasAttribute('data-dt-target') || node.hasAttribute('data-dt-ui');
    }
    // 只认我们真正写过的文本节点；不能把 nodeUnit 里的原文节点也算成自己的，
    // 否则站点新增一个文本节点（childList）时观察器会当成本身变化而忽略。
    return ownWrites.has(node) || ownNodes.has(node);
  };

  // 鼠标下的节点属于哪个单元（悬停用）：原文文本节点、<br>、译文节点都在 nodeUnit 里
  DT.unitOfNode = function (node) {
    for (var cur = node; cur; cur = cur.parentNode) {
      var unit = nodeUnit.get(cur);
      if (unit) return unit;
    }
    // 鼠标落在只用来装段落的容器 / 行内包裹元素上：退回该元素的第一个段落单元。
    // 真正的文本节点、<br>、译文节点都在上面精确命中，这里只是兜底。
    if (node && node.nodeType === 1 && elUnits.has(node)) {
      var list = elUnits.get(node);
      if (list && list.length) return list[0];
    }
    return null;
  };

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
    if (siteExclude && el.matches(siteExclude)) return true; // 站点规则：这些区域不翻
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

  function keepsBreaks(cs) {
    return !!cs && DT.keepsLineBreaks(cs.whiteSpace, cs.whiteSpaceCollapse);
  }

  // 按阅读顺序列出元素里的文字：{ node, keep } 是文本节点，{ br } 是换行元素。
  // keep = 所在元素保留换行（white-space: pre / pre-wrap / pre-line），节点里的 \n 是真换行；
  // 否则 \n 只是 HTML 源码里的折行，等同空格。
  // 必须排除我们自己注入的译文节点，否则增量重扫时会把「原文 + 已注入的译文」当成新文本再翻一次，
  // 表现为同一段译文出现两遍（social__text-wrapper 那种）。
  function tokensOf(el) {
    var out = [];
    (function visit(node, keep) {
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i += 1) {
        var kid = kids[i];
        if (kid.nodeType === 3) {
          if (kid.nodeValue) out.push({ node: kid, keep: keep });
        } else if (kid.nodeType === 1) {
          if (kid.hasAttribute('data-dt-target')) continue;
          if (kid.hasAttribute('data-dt-ui')) continue;
          if (NON_TEXT_TAGS[tagOf(kid)]) continue;
          if (tagOf(kid) === 'BR') {
            // 仅译文模式下因译文行数不够而收起的换行，不算一行
            if (!kid.hasAttribute('data-dt-collapsed')) out.push({ br: kid });
            continue;
          }
          // 隐藏子树（display:none 的对话框 / 展开菜单）不算正文：
          // 以前会把 GitHub 设置页里隐藏的确认对话框文案拼进按钮文本，整行布局被撑坏
          if (kid.hidden) continue;
          var cs = styleOf(kid);
          if (cs && cs.display === 'none') continue;
          visit(kid, cs ? keepsBreaks(cs) : keep);
        }
      }
    })(el, keepsBreaks(styleOf(el)));
    return out;
  }

  // 取元素的"纯净文本"，所有空白（含换行）折叠成一个空格：区域判定、签名、长度判断用
  function textOf(el) {
    return DT.normalizeText(
      tokensOf(el)
        .map(function (tok) {
          return tok.br ? ' ' : tok.node.nodeValue;
        })
        .join('')
    );
  }

  // 送翻的文本：和 textOf 一样折叠空白，但 <br> 与保留换行的 \n 记成换行。
  // Pixiv 小说一个 <p> 里是几行对白（span + <br>），以前换行被折成空格，模型只能回一整段
  DT.unitText = function (el) {
    return DT.normalizeLines(
      tokensOf(el)
        .map(function (tok) {
          if (tok.br) return '\n';
          return tok.keep ? tok.node.nodeValue : tok.node.nodeValue.replace(/[\r\n]/g, ' ');
        })
        .join('')
    );
  };

  // own 单元（子元素都已翻过 / 被跳过，只翻自己的直接文本）在页面上对应的文字：
  // 只取 ownText 读过的那些 —— 直接文本、<br>、行内代码。
  // notranslate / translate="no" / 站点规则排除的子元素、已经翻过的子元素都没送去翻译，原地替换时也不能动它们
  function ownTokens(el) {
    var out = [];
    var keep = keepsBreaks(styleOf(el));
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i += 1) {
      var kid = kids[i];
      if (kid.nodeType === 3) {
        if (kid.nodeValue) out.push({ node: kid, keep: keep });
      } else if (kid.nodeType === 1) {
        if (tagOf(kid) === 'BR') {
          if (!kid.hasAttribute('data-dt-collapsed')) out.push({ br: kid });
        } else if (INLINE_CODE_TAGS[tagOf(kid)]) {
          out = out.concat(tokensOf(kid));
        }
      }
    }
    return out;
  }

  // 把元素里的文字按行分组（和 DT.unitText 同一套切法，非空行一一对应）：
  // 每行 { pieces: [{ node, start, end }], filled: 有没有字, keep, br: 行首的 <br>, nl: 行首在文本节点里的 \n }
  // tokens 不传时取整个元素（tokensOf）；own 单元传 ownTokens
  function lineGroups(el, tokens) {
    var groups = [{ pieces: [], filled: false, keep: false, br: null, nl: null }];
    function last() {
      return groups[groups.length - 1];
    }
    function add(node, start, end, keep) {
      var g = last();
      if (!g.pieces.length) g.keep = keep;
      g.pieces.push({ node: node, start: start, end: end });
      if (/\S/.test(node.nodeValue.slice(start, end))) g.filled = true;
    }
    (tokens || tokensOf(el)).forEach(function (tok) {
      if (tok.br) {
        groups.push({ pieces: [], filled: false, keep: false, br: tok.br, nl: null });
        return;
      }
      var value = tok.node.nodeValue;
      if (!tok.keep) {
        add(tok.node, 0, value.length, false);
        return;
      }
      var start = 0;
      for (var i = 0; i <= value.length; i += 1) {
        if (i < value.length && value.charAt(i) !== '\n') continue;
        if (i > start) add(tok.node, start, i, true);
        if (i < value.length) groups.push({ pieces: [], filled: false, keep: true, br: null, nl: { node: tok.node, at: i } });
        start = i + 1;
      }
    });
    return groups;
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
  // <br> 记成换行（和 DT.unitText 一样；「第一段<br><br>第二段」这种只有 <br> 子元素的段落就走这里），
  // 行内代码照样拼进句子；已翻译 / 隐藏 / 非正文的子元素只留一个分隔空格，免得把子级已翻过的内容再翻一遍。
  function ownText(el) {
    var parts = [];
    var keep = keepsBreaks(styleOf(el));
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i += 1) {
      var kid = kids[i];
      if (kid.nodeType === 3) {
        parts.push(keep ? kid.nodeValue : kid.nodeValue.replace(/[\r\n]/g, ' '));
      } else if (kid.nodeType === 1) {
        if (tagOf(kid) === 'BR') parts.push(kid.hasAttribute('data-dt-collapsed') ? '' : '\n');
        else parts.push(INLINE_CODE_TAGS[tagOf(kid)] ? textOf(kid) : ' ');
      }
    }
    return DT.normalizeLines(parts.join(''));
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
  // 3) 正文块（p / h / li / td…）只有行内子元素 → 整段一个单元（句子 span、脚注、行内链接）
  // 4) 其它容器有三个以上并列子元素 = 一列条目（列表、菜单），继续拆
  // 5) 其余（如 <h1><span>Hello</span> <span>World</span></h1>）当一个整体
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
    // 含交互控件的容器（form / action-menu / 下拉菜单 / 对话框）不能整块替换：
    // 会把按钮文字和隐藏的对话框 / 菜单文案拼成一段，按钮被挤成竖排（GitHub 设置页实例）。
    // 自定义元素（action-menu 之类）即使暂时查不到 button 也先下钻。
    var tagName = tagOf(el);
    if (!CONTENT_TAGS[tagName]) {
      if (tagName.indexOf('-') >= 0 && usable >= 2) return true;
      if (
        el.querySelector &&
        el.querySelector(
          'button, input, select, textarea, summary, [role="button"], [role="menuitem"], [role="menu"], [role="dialog"], [role="alertdialog"], [role="toolbar"]'
        )
      ) {
        return true;
      }
    }
    // 正文块里的 3+ 个行内子元素（OWID 的 <p> 有 8 个：句子 span、脚注、行内链接）
    // 以前会逐个子元素拆，译文插在句子中间；整段翻、追加到段末可读性更好。
    if (CONTENT_TAGS[tagName]) return false;
    return usable >= 3;
  }

  // ---------------- 0.9.1 段落单元收集 ----------------
  // 一个元素里的文本先摊成带 DOM 映射的规范化文本（DT.units.textMap），再按空行切段。
  // 只有「空行来自 <br>」时才真正拆成多个单元：分处不同文本节点，插入锚点就是分隔 <br>，
  // 不需要 splitText，也不会打乱后续段落的偏移。
  // pre-wrap 文本节点内部的空行仍然是一个单元（行级结构保留），悬停退回行级对应。
  function paragraphRanges(map) {
    var raw = DT.units.paragraphsOf(map.text);
    var out = [];
    raw.forEach(function (p) {
      var meta = p.sepStart < map.text.length ? map.chars[p.sepStart] : null;
      var split = !!(meta && meta.br);
      var last = out[out.length - 1];
      if (last && !last.splittable) {
        // 上一个分隔不是 <br>：合并成同一个单元，保留内部换行
        last.end = p.end;
        last.sepStart = p.sepStart;
        last.sepEnd = p.sepEnd;
        last.splittable = split;
        return;
      }
      out.push({ start: p.start, end: p.end, sepStart: p.sepStart, sepEnd: p.sepEnd, splittable: split });
    });
    return out;
  }

  // 段落范围覆盖的非空行 → lineGroups 里的下标。对不上返回 null（调用方安全退化）
  function groupsForRange(filled, map, range, before) {
    var count = DT.units.linesOf(map.text, range.start, range.end).length;
    var picked = filled.slice(before, before + count);
    return picked.length === count ? picked : null;
  }

  // 段落里关联的振假名节点：<ruby> 基字落在本段内 → 它的 <rt>/<rp> 属于本段。
  // 仅译文模式只隐藏这些，不全局隐藏页面上的所有 <rt>（未翻译的 Ruby 要原样保留）。
  function rubyAnnotationsFor(el, chars) {
    var out = [];
    function add(node) {
      if (out.indexOf(node) < 0) out.push(node);
    }
    (chars || []).forEach(function (c) {
      if (!c || !c.node) return;
      for (var cur = c.node.parentNode; cur && cur !== el && cur.nodeType === 1; cur = cur.parentNode) {
        var tag = tagOf(cur);
        if (tag === 'RT' || tag === 'RP') return;
        if (tag === 'RUBY') {
          var kids = cur.querySelectorAll('rt, rp');
          for (var i = 0; i < kids.length; i += 1) add(kids[i]);
          return;
        }
      }
    });
    return out;
  }

  function fillSnapshot(unit) {
    var snap = [];
    (unit.map.chars || []).forEach(function (c) {
      if (!c) return;
      var node = c.node || (c.nl && c.nl.node) || null;
      if (!node) return;
      for (var k = 0; k < snap.length; k += 1) if (snap[k].node === node) return;
      snap.push({ node: node, value: node.nodeValue });
    });
    unit.snapshot = snap;
  }

  function addParagraphs(out, el, tokens, own) {
    var map = DT.units.textMap(tokens);
    if (!map.text) return;
    var ranges = paragraphRanges(map);
    var groups = lineGroups(el, tokens);
    var allFilled = [];
    groups.forEach(function (g, gi) {
      if (g.filled) allFilled.push(gi);
    });
    // 段落按顺序遍历：累计非空行数即可，避免每段都从 0 重扫（大量段落时是 O(n²)）
    var picks = [];
    var beforeLines = 0;
    ranges.forEach(function (range) {
      var picked = groupsForRange(allFilled, map, range, beforeLines);
      picks.push(picked);
      beforeLines += DT.units.linesOf(map.text, range.start, range.end).length;
    });
    if (picks.some(function (p) { return !p; })) {
      // 行分组对不上（罕见：行内结构被跳过）：整个元素一个单元，宁可少拆不要漏字
      ranges = [{ start: 0, end: map.text.length, sepStart: map.text.length, sepEnd: map.text.length, splittable: false }];
      picks = [allFilled];
    }

    ranges.forEach(function (range, index) {
      var text = map.text.slice(range.start, range.end);
      if (!text) return;
      var anchor = null;
      if (ranges.length > 1 && range.splittable) {
        var meta = map.chars[range.sepStart];
        if (meta && meta.br && meta.br.parentNode) anchor = { parent: meta.br.parentNode, before: meta.br };
      }
      var picked = picks[index] || [];
      var lastFilled = picked.length ? picked[picked.length - 1] : -1;
      var tail = [];
      if (ranges.length === 1) {
        for (var gi = lastFilled + 1; gi < groups.length; gi += 1) tail.push(groups[gi]);
      }
      var unit = {
        id: 'u' + (unitSeq += 1),
        el: el,
        text: text,
        own: !!own,
        whole: ranges.length === 1,
        index: index,
        total: ranges.length,
        anchor: anchor,
        map: { text: text, chars: map.chars.slice(range.start, range.end) },
        sentences: DT.units.sentencesIn(map.text, range.start, range.end).map(function (s, si) {
          return { index: si, start: s.start - range.start, end: s.end - range.start, text: s.text };
        }),
        groups: {
          filled: picked.map(function (gi) { return groups[gi]; }),
          tail: tail
        },
        snapshot: [],
        sig: DT.units.signature(text),
        gen: DT.generation,
        area: '',
        ruby: rubyAnnotationsFor(el, map.chars.slice(range.start, range.end))
      };
      fillSnapshot(unit);
      // 已经翻过这个段落：原文没变就跳过；站点改过就先撤销旧记录再按新内容收集。
      // 放在 fillSnapshot 之后：替换型靠文本节点身份匹配，不依赖 index。
      var rec = findRenderedFor(el, unit);
      if (rec) {
        // 双语的源文本签名变了（包括站点插入了新文本节点）：先撤掉旧译文，再按新内容收集
        var sourceMoved = rec.mode === 'dual' && rec.unit.sig !== unit.sig;
        var sameSource = rec.mode === 'replace' || rec.mode === 'ruby' ? true : !sourceChangedSnapshot(rec.unit);
        if (!sourceMoved && stillOurs(rec) && sameSource) return;
        dropRendered(rec);
      }
      if (!collectAccept || collectAccept(unit)) out.push(unit);
    });
  }

  function walk(el, out) {
    if (out.length >= MAX_UNITS) return;
    if (!el || el.nodeType !== 1) return;
    if (isSkipped(el)) return;

    var own = directText(el);

    // 1) 真叶子：直接作为（一个或多个）段落单元
    if (!el.children.length) {
      addParagraphs(out, el, tokensOf(el), false);
      return;
    }

    // 2) 子元素全被跳过（已翻译 / 不可见）：父级只翻自己的直接文本
    if (!usableChildren(el)) {
      if (own) addParagraphs(out, el, ownTokens(el), true);
      return;
    }

    // 3) 有直接文本（段落），或不该继续拆分 → 按段落切分
    if (own || !shouldDescend(el)) {
      // 兜底防线：如果这棵子树里已经有我们注入的译文，说明这里被翻过，
      // 再整块翻一次就会把内容翻第二遍。这时只往下处理"还没翻"的子节点。
      if (!own && el.querySelector && el.querySelector('[data-dt-src]')) {
        var inner = el.children;
        for (var k = 0; k < inner.length; k += 1) {
          walk(inner[k], out);
        }
        return;
      }
      addParagraphs(out, el, tokensOf(el), false);
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
  // ---------------- 站点规则 ----------------
  // 后台按网址算好的规则（lib/site-rules.js）：excludeSelectors 不翻、textSelectors 只翻这些区域。
  // 选择器逐个试一遍，写错的单独丢掉，不能让一条坏选择器把整页翻译弄挂
  var siteExclude = '';
  var siteText = '';
  function validSelectors(list) {
    return (list || []).filter(function (sel) {
      try {
        document.createDocumentFragment().querySelector(sel);
        return true;
      } catch (err) {
        DT.log('站点规则里的选择器无效，已忽略：', sel);
        return false;
      }
    });
  }
  DT.setSiteRule = function (rule) {
    siteExclude = rule ? validSelectors(rule.excludeSelectors).join(',') : '';
    siteText = rule ? validSelectors(rule.textSelectors).join(',') : '';
  };

  // 要从哪些根开始收：有 textSelectors 就只收这些区域（嵌套的只留最外层），否则整个 body
  DT.collectRoots = function () {
    var body = document.body;
    if (!siteText || !body) return body ? [body] : [];
    var found = Array.prototype.slice.call(body.querySelectorAll(siteText));
    return found.filter(function (el) {
      return !found.some(function (other) {
        return other !== el && other.contains(el);
      });
    });
  };

  // 按站点规则的根逐个收集；任何一个根收满了上限都算本轮收满
  DT.collectAll = function (accept) {
    var out = [];
    var full = false;
    DT.collectRoots().forEach(function (root) {
      out = out.concat(DT.collect(root, accept));
      if (DT.lastCollectFull) full = true;
    });
    DT.lastCollectFull = full;
    return out;
  };

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

  // 译文插在源元素【内部】，本来就会继承字号/颜色。
  // 这里用 inherit / 相对值，而不是把 computed px 写死：
  // Aeon 这类站点的标题字号随断点变化（72px → 42px），写死 px 会在窗口缩放后
  // 让译文停在翻译那一刻的尺寸，和原文严重不匹配。
  function copyTypography(node, cs) {
    if (!cs) return;
    if (!isTransparentColor(cs.color)) node.style.color = 'inherit';
    node.style.fontSize = 'inherit';
    node.style.fontWeight = 'inherit';
    node.style.fontStyle = 'inherit';
    node.style.lineHeight = 'inherit';
    node.style.letterSpacing = 'inherit';
    node.style.textTransform = 'inherit';
  }

  function isInlineLike(el) {
    var cs = styleOf(el);
    if (!cs) return false;
    var d = cs.display;
    return d === 'inline' || d === 'inline-block' || d === 'inline-flex';
  }

  function makeNode(sourceEl, text, lang, forceBlock) {
    var inline = forceBlock ? false : isInlineLike(sourceEl);
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
    // CJK 大标题与紧行高的局部归一化：只加类名，字号仍用 em 跟原站响应式变化
    var layout = DT.translationLayout(
      text,
      cs ? parseFloat(cs.fontSize) || 0 : 0,
      cs ? parseFloat(cs.lineHeight) || 0 : 0,
      /^H[1-6]$/.test(tagOf(sourceEl)),
      inline
    );
    if (layout.heading) {
      node.classList.add('dt-cjk-heading');
      node.style.fontSize = '0.8em'; // CSS 没加载时也有兜底
    }
    if (layout.tight) {
      node.classList.add('dt-cjk-tight');
      node.style.lineHeight = '1.25';
    }
    if (narrow) {
      node.classList.add('dt-narrow');
      node.style.whiteSpace = 'nowrap';
      node.style.overflow = 'visible';
    }
    // 原文有分行（对白、<br> 分隔的帖子）时译文也分行：只给这种节点加类，不全局改 white-space
    if (String(text).indexOf('\n') >= 0) {
      node.classList.add('dt-lines');
      node.style.whiteSpace = narrow ? 'pre' : 'pre-line';
    }
    return node;
  }

  function record(where, node, sourceEl, text, area) {
    try {
      DT.placements.push({
        tag: sourceEl.tagName,
        cls: shortCls(sourceEl.className),
        where: where,
        area: area || '',
        span: !!node && node.tagName === 'SPAN',
        mode: DT.state.mode,
        text: previewText(text)
      });
      if (DT.placements.length > 300) DT.placements.shift();
    } catch (err) {
      /* 诊断记录失败不影响注入 */
    }
  }

  // 首字下沉节点：Aeon 用 <span class="ld-dropcap">N</span>ewton’s…，
  // 第一个文本节点只有 "N"，但字体被放大成 71.5px 并 float。仅译文模式
  // 不能把整段中文都写进这个节点，否则整段会变成巨型首字。
  function isDropcapNode(node) {
    var el = node && node.parentElement;
    if (!el) return false;
    var value = String(node.nodeValue || '').trim();
    if (!value || value.length > 3) return false;
    var text = String(el.textContent || '').trim();
    if (!text || text.length > 4) return false;
    var cs = styleOf(el);
    if (!cs) return false;
    var named = /drop.?cap|first.?letter/i.test(String(el.className || '') + ' ' + String(el.id || ''));
    // 有 dropcap / first-letter 类名的容器即使没写 float 也认；
    // 没类名的必须是 float 的小节点，避免把普通的行内强调当成首字下沉
    if (cs.float !== 'left' && cs.float !== 'right' && !named) return false;
    var pcs = el.parentElement ? styleOf(el.parentElement) : null;
    var fs = parseFloat(cs.fontSize) || 0;
    var pfs = pcs ? parseFloat(pcs.fontSize) || 0 : 0;
    return named || (fs > 0 && pfs > 0 && fs >= pfs * 1.5);
  }

  // 源文本签名：用于判断 SPA 路由切换后，某些元素的内容是否被站点换掉了
  // ---------------- 0.9.1 渲染事务 ----------------
  // op:
  //   insert  { node, parent, before }     插入译文节点（双语 / Ruby 安全替换）
  //   text    { node, before, after }      改写文本节点（仅译文）
  //   attr    { el, name, before, after }  属性（data-dt-src / 折叠换行 / rt 标记）
  //   style   { el, prop, before, after }  行内样式（rt/rp 的 display）
  function txPush(op, ops) {
    op.gen = DT.generation;
    tx.push(op);
    if (ops) ops.push(op);
    return op;
  }

  function setText(node, value, ops) {
    if (!node || node.nodeValue === value) return false;
    txPush({ op: 'text', node: node, before: node.nodeValue, after: value }, ops);
    ownWrites.set(node, value);
    node.nodeValue = value;
    return true;
  }

  function setAttr(el, name, value, ops) {
    var before = el.getAttribute(name);
    if (before === value) return false;
    txPush({ op: 'attr', el: el, name: name, before: before, after: value }, ops);
    if (value == null) el.removeAttribute(name);
    else el.setAttribute(name, value);
    return true;
  }

  function setStyle(el, prop, value, ops) {
    var before = el.style[prop] || '';
    if (before === value) return false;
    txPush({ op: 'style', el: el, prop: prop, before: before, after: value }, ops);
    el.style[prop] = value;
    return true;
  }

  function insertNode(node, parent, before, ops) {
    txPush({ op: 'insert', node: node, parent: parent, before: before || null }, ops);
    if (before && before.parentNode === parent) parent.insertBefore(node, before);
    else parent.appendChild(node);
  }

  function undoOps(ops) {
    for (var i = (ops || []).length - 1; i >= 0; i -= 1) {
      var op = ops[i];
      try {
        if (op.op === 'insert') {
          if (op.node && op.node.parentNode) op.node.parentNode.removeChild(op.node);
        } else if (op.op === 'text') {
          // 只撤销仍是我们写入的值：站点后来改过的节点保持站点的新内容
          if (op.node && op.node.nodeValue === op.after) {
            op.node.nodeValue = op.before;
            ownWrites.delete(op.node);
          }
        } else if (op.op === 'attr') {
          if (!op.el) continue;
          if (op.el.getAttribute(op.name) !== op.after) continue;
          if (op.before == null) op.el.removeAttribute(op.name);
          else op.el.setAttribute(op.name, op.before);
        } else if (op.op === 'style') {
          if (op.el && (op.el.style[op.prop] || '') === op.after) {
            op.el.style[op.prop] = op.before || '';
            // 原本没有 style 属性时，赋空值会留下 style=""，还原后 innerHTML 对不上
            if (!op.before && op.el.getAttribute('style') === '') op.el.removeAttribute('style');
          }
        }
      } catch (err) {
        /* 节点被站点移除 / 框架重建：放弃这一条，继续还原别的 */
      }
    }
  }

  // ---------------- 渲染记录（去重 / 释放 / 悬停） ----------------
  function linkUnit(unit) {
    (unit.map.chars || []).forEach(function (c) {
      if (!c) return;
      var node = c.node || (c.nl && c.nl.node) || null;
      if (c.br) nodeUnit.set(c.br, unit);
      if (!node) return;
      nodeUnit.set(node, unit);
      // 行内包裹元素（<strong> / <span> / <a>）也要能解析到本单元，否则鼠标停在元素上时找不到
      for (var cur = node.parentNode; cur && cur !== unit.el && cur.nodeType === 1; cur = cur.parentNode) {
        if (!nodeUnit.has(cur)) nodeUnit.set(cur, unit);
      }
    });
    var list = elUnits.get(unit.el);
    if (!list) {
      list = [];
      elUnits.set(unit.el, list);
    }
    if (list.indexOf(unit) < 0) list.push(unit);
    if (unit.whole) nodeUnit.set(unit.el, unit);
  }

  // 找这个段落已经渲染过的记录。
  // 双语的锚点在 DOM 里，段落重排后译文仍跟着原文走 → 按源文本签名匹配，不只看 index；
  // 替换型按「我们写过的文本节点」匹配，站点重排 / 插入段落也不会认错。
  function findRenderedFor(el, unit) {
    var byIndex = null;
    var list = renderedByEl.get(el) || [];
    for (var i = 0; i < list.length; i += 1) {
      var rec = list[i];
      if (rec.mode === 'dual' && rec.unit.sig === unit.sig) return rec;
      if (rec.mode === 'replace' || rec.mode === 'ruby') {
        var saved = rec.saved || [];
        for (var k = 0; k < saved.length; k += 1) {
          for (var s = 0; s < (unit.snapshot || []).length; s += 1) {
            if (unit.snapshot[s].node === saved[k].node) return rec;
          }
        }
      }
      if (rec.unit.index === unit.index && !byIndex) byIndex = rec;
    }
    return byIndex;
  }

  function sourceChangedSnapshot(unit) {
    if (!unit || !unit.el || !unit.el.isConnected) return true;
    var snap = unit.snapshot || [];
    for (var i = 0; i < snap.length; i += 1) {
      if (!snap[i].node.isConnected || snap[i].node.nodeValue !== snap[i].value) return true;
    }
    return false;
  }

  // 这条记录还是不是我们写的样子：替换型看每个文本节点是否仍是写入值；
  // 双语 / Ruby 型看译文节点还在不在
  function stillOurs(rec) {
    if (!rec || !rec.unit || !rec.unit.el.isConnected) return false;
    if (rec.mode === 'dual') return !!rec.node && rec.node.isConnected;
    // Ruby / 替换型：译文节点在，而且我们写过的文本节点都还是写入值
    if (rec.mode === 'ruby' && (!rec.node || !rec.node.isConnected)) return false;
    var saved = rec.saved || [];
    for (var i = 0; i < saved.length; i += 1) {
      if (!saved[i].node.isConnected || saved[i].node.nodeValue !== saved[i].wrote) return false;
    }
    return rec.mode === 'ruby' ? !!rec.node && rec.node.isConnected : true;
  }

  function pushRendered(rec) {
    rendered.push(rec);
    var list = renderedByEl.get(rec.unit.el);
    if (!list) {
      list = [];
      renderedByEl.set(rec.unit.el, list);
    }
    list.push(rec);
  }

  function dropRendered(rec) {
    if (!rec) return;
    undoOps(rec.ops);
    var i = rendered.indexOf(rec);
    if (i >= 0) rendered.splice(i, 1);
    var elList = renderedByEl.get(rec.unit.el);
    if (elList) {
      var j = elList.indexOf(rec);
      if (j >= 0) elList.splice(j, 1);
    }
    var list = rec.unit && rec.unit.el ? elUnits.get(rec.unit.el) : null;
    if (list) {
      var k = list.indexOf(rec.unit);
      if (k >= 0) list.splice(k, 1);
    }
    if (rec.replaced) {
      var ri = (DT.replaced || []).indexOf(rec.replaced);
      if (ri >= 0) DT.replaced.splice(ri, 1);
    }
    if (rec.unit && rec.unit.whole) {
      rec.unit.el.removeAttribute('data-dt-src');
      rec.unit.el.removeAttribute('data-dt-sig');
    }
  }

  // ---------------- 双语：插入段落锚点 ----------------
  // 共用容器的段落插在分隔 <br> 之前（P1 → 译文1 → 空行 → P2 → 译文2），
  // 不再把整个容器的所有译文 append 到末尾。独占元素的段落仍追加到元素内部末尾。
  function injectDual(unit, text, lang, area) {
    var sourceEl = unit.el;
    var node = makeNode(sourceEl, text, lang, !unit.whole);
    node.setAttribute('data-dt-unit', unit.id);
    nodeUnit.set(node, unit);
    unit.renderMode = 'dual';
    unit.targetNode = node;
    var ops = [];
    try {
      insertNode(node, unit.anchor ? unit.anchor.parent : sourceEl, unit.anchor ? unit.anchor.before : null, ops);
    } catch (err) {
      DT.log('injectDual failed', err);
      return false;
    }
    if (unit.whole) {
      setAttr(sourceEl, 'data-dt-src', '1', ops);
      setAttr(sourceEl, 'data-dt-sig', unit.sig, ops);
    }
    unit.renderedText = text;
    pushRendered({ unit: unit, mode: 'dual', node: node, ops: ops, saved: [] });
    linkUnit(unit);
    record(unit.anchor ? 'before' : 'inside', node, sourceEl, text, area);
    return true;
  }

  function pieceText(piece) {
    return piece.node.nodeValue.slice(piece.start, piece.end);
  }

  // 一行译文写进这一行：第一个有字的片段换成「原来的行首缩进 + 译文」，同一行后面的片段清空
  // （行内的 <b> / <a> 和以前一样不保留格式，但只影响这一行）
  function writeLine(group, line, edits, first) {
    var pieces = group.pieces;
    var lead = 0;
    while (lead < pieces.length && !/\S/.test(pieceText(pieces[lead]))) lead += 1;
    if (lead >= pieces.length) return;
    var head = pieces[lead];
    var indent = /^\s*/.exec(pieceText(head))[0];
    var value = indent + line;
    var restAt = -1;
    var rest = '';
    // 首字下沉：首字留在下沉节点，这一行其余的译文写进后面的正文节点
    if (first && isDropcapNode(head.node)) {
      var dropParent = head.node.parentElement;
      for (var j = lead + 1; j < pieces.length; j += 1) {
        if (!dropParent.contains(pieces[j].node)) {
          restAt = j;
          break;
        }
      }
      if (restAt >= 0) {
        var chars = Array.from(line);
        value = indent + chars.shift();
        rest = chars.join('');
      }
    }
    edits.push({ node: head.node, start: head.start, end: head.end, value: value });
    for (var k = lead + 1; k < pieces.length; k += 1) {
      edits.push({ node: pieces[k].node, start: pieces[k].start, end: pieces[k].end, value: k === restAt ? rest : '' });
    }
  }

  // 按文本节点合并改动后写入，所有写入都进事务；返回 [{ node, value: 原值, wrote: 写入值 }]
  function applyEditsTx(edits, ops) {
    var order = [];
    var byNode = new Map();
    edits.forEach(function (edit) {
      if (!byNode.has(edit.node)) {
        byNode.set(edit.node, []);
        order.push(edit.node);
      }
      byNode.get(edit.node).push(edit);
    });
    return order.map(function (node) {
      var value = node.nodeValue;
      var wrote = value;
      byNode
        .get(node)
        .sort(function (a, b) {
          return b.start - a.start;
        })
        .forEach(function (edit) {
          wrote = wrote.slice(0, edit.start) + edit.value + wrote.slice(edit.end);
        });
      setText(node, wrote, ops);
      return { node: node, value: value, wrote: wrote };
    });
  }

  function clearGroup(group, edits, collapsed) {
    (group.pieces || []).forEach(function (p) {
      edits.push({ node: p.node, start: p.start, end: p.end, value: '' });
    });
    if (group.nl) edits.push({ node: group.nl.node, start: group.nl.at, end: group.nl.at + 1, value: '' });
    if (group.br) {
      if (collapsed) collapsed.push(group.br);
    }
  }

  // 有分行的段落：译文按行写回原来那一行，<br>、空行和各行所在的元素都原样保留。
  // 只改本段落自己的行；段落之间的空行是别人的锚点，绝不折叠。
  function injectLines(unit, lines, area) {
    var sel = unit.groups.filled || [];
    var n = sel.length;
    if (!n) return false;
    var assign = lines.slice(0, n);
    if (lines.length > n) assign[n - 1] = lines.slice(n - 1).join(sel[n - 1].keep ? '\n' : ' ');
    var ops = [];
    var collapsed = [];
    var edits = [];
    for (var k = 0; k < n; k += 1) {
      if (k >= assign.length) {
        clearGroup(sel[k], edits, collapsed);
        continue;
      }
      writeLine(sel[k], assign[k], edits, k === 0);
    }
    (unit.groups.tail || []).forEach(function (g) {
      clearGroup(g, edits, collapsed);
    });
    // 同一文本节点上的多行 edit 必须一次性从后往前写：逐行写会让后一行的偏移失效
    if (edits.length) applyEditsTx(edits, ops);
    collapsed.forEach(function (br) {
      setAttr(br, 'data-dt-collapsed', '1', ops);
    });
    var srcLines = DT.splitLines(unit.text);
    var saved = [];
    ops.forEach(function (op) {
      if (op.op === 'text') saved.push({ node: op.node, value: op.before, wrote: op.after });
    });
    var item = {
      el: unit.el,
      nodes: saved,
      collapsed: collapsed,
      src: unit.text,
      lines: srcLines,
      aligned: lines.length === n && srcLines.length === n
    };
    DT.replaced.push(item);
    setAttr(unit.el, 'data-dt-replaced', '1', ops);
    if (unit.whole) {
      setAttr(unit.el, 'data-dt-src', '1', ops);
      setAttr(unit.el, 'data-dt-sig', unit.sig, ops);
    }
    unit.renderMode = 'replace';
    unit.targetNode = null;
    unit.renderedText = lines.join('\n');
    pushRendered({ unit: unit, mode: 'replace', ops: ops, saved: saved, collapsed: collapsed, replaced: item });
    linkUnit(unit);
    record('replace', null, unit.el, lines.join('\n'), area);
    return true;
  }

  function contentNodes(unit) {
    var nodes = [];
    (unit.groups.filled || []).forEach(function (g) {
      (g.pieces || []).forEach(function (p) {
        if (!/\S/.test(p.node.nodeValue.slice(p.start, p.end))) return;
        if (nodes.indexOf(p.node) < 0) nodes.push(p.node);
      });
    });
    return nodes;
  }

  // 仅译文：单行段落整体写进第一个文本节点，其余清空（保留图标等子元素）
  function injectReplace(unit, text, area) {
    var groups = unit.groups.filled || [];
    if (groups.length >= 2) return injectLines(unit, DT.splitLines(text), area);
    var nodes = contentNodes(unit);
    if (!nodes.length) return false;
    var saved = [];
    var ops = [];

    // 首字下沉：首字放进下沉节点，其余放进后面的正文节点。
    // 否则整段中文都会挤进 71.5px 的 "N" 里（Aeon 仅译文模式实例）。
    var drop = nodes.length > 1 && isDropcapNode(nodes[0]) ? nodes[0] : null;
    var head = '';
    var tail = text;
    var restIndex = 0;
    if (drop) {
      var chars = Array.from(String(text || '').replace(/^\s+/, ''));
      head = chars.shift() || '';
      tail = chars.join('');
      restIndex = 1;
      var dropParent = drop.parentElement;
      while (restIndex < nodes.length && dropParent && dropParent.contains(nodes[restIndex])) {
        restIndex += 1;
      }
      if (!head || restIndex >= nodes.length) {
        drop = null;
        head = '';
        tail = text;
        restIndex = 0;
      }
    }

    for (var i = 0; i < nodes.length; i += 1) {
      var wrote;
      if (drop) wrote = i === 0 ? head : i === restIndex ? tail : '';
      else wrote = i === 0 ? /^\s*/.exec(nodes[i].nodeValue)[0] + text : '';
      var before = nodes[i].nodeValue;
      setText(nodes[i], wrote, ops);
      saved.push({ node: nodes[i], value: before, wrote: wrote });
    }

    var srcLines = DT.splitLines(unit.text);
    var item = { el: unit.el, nodes: saved, collapsed: [], src: unit.text, lines: srcLines, aligned: true };
    DT.replaced.push(item);
    setAttr(unit.el, 'data-dt-replaced', '1', ops);
    if (unit.whole) {
      setAttr(unit.el, 'data-dt-src', '1', ops);
      setAttr(unit.el, 'data-dt-sig', unit.sig, ops);
    }
    unit.renderMode = 'replace';
    unit.targetNode = null;
    unit.renderedText = text;
    pushRendered({ unit: unit, mode: 'replace', ops: ops, saved: saved, collapsed: [], replaced: item });
    linkUnit(unit);
    record('replace', null, unit.el, text, area);
    return true;
  }

  // 含振假名的段落（仅译文模式）：不把中文写进 ruby/rb/rt/rp。
  // 做法是保留原始 DOM：清空本段落的正文文本节点、隐藏本段落关联的 rt/rp、
  // 在段落锚点插入独立译文节点。还原时文本、注音显隐、锚点一起恢复。
  function injectRuby(unit, text, lang, area) {
    var ops = [];
    var saved = [];
    var edits = [];
    (unit.groups.filled || []).forEach(function (g) {
      (g.pieces || []).forEach(function (p) {
        edits.push({ node: p.node, start: p.start, end: p.end, value: '' });
      });
    });
    if (edits.length) saved = applyEditsTx(edits, ops);
    (unit.ruby || []).forEach(function (node) {
      setStyle(node, 'display', 'none', ops);
      setAttr(node, 'data-dt-rt-hidden', '1', ops);
    });
    var target = makeNode(unit.el, text, lang, true);
    target.setAttribute('data-dt-unit', unit.id);
    nodeUnit.set(target, unit);
    unit.renderMode = 'ruby';
    unit.targetNode = target;
    insertNode(target, unit.anchor ? unit.anchor.parent : unit.el, unit.anchor ? unit.anchor.before : null, ops);
    setAttr(unit.el, 'data-dt-replaced', '1', ops);
    if (unit.whole) {
      setAttr(unit.el, 'data-dt-src', '1', ops);
      setAttr(unit.el, 'data-dt-sig', unit.sig, ops);
    }
    unit.renderedText = text;
    pushRendered({ unit: unit, mode: 'ruby', node: target, ops: ops, saved: saved, ruby: unit.ruby });
    linkUnit(unit);
    record('replace', target, unit.el, text, area);
    return true;
  }

  // 原地替换单元的记录（兼容 0.9.0 的悬停 / 自检接口；新悬停直接读 unit）
  DT.replacedOf = function (el) {
    var list = DT.replaced || [];
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].el === el) return list[i];
    }
    return null;
  };

  // 等译文回来期间，站点改了这段原文（SPA 重渲染、翻页时复用了同一个元素）：
  // 旧译文不能再写进新内容，调用方放弃这次注入，下一轮按新内容重翻
  DT.sourceChanged = function (unit) {
    if (!unit || !unit.el) return true;
    if (unit.snapshot) return sourceChangedSnapshot(unit);
    var now = unit.own ? ownText(unit.el) : DT.unitText(unit.el);
    return now !== unit.text;
  };

  // 这个文本节点的当前值是不是我们写进去的（MutationObserver 用来忽略自己的改动）
  DT.isOwnWrite = function (node) {
    return !!node && ownWrites.has(node) && ownWrites.get(node) === node.nodeValue;
  };

  // 被站点改写过的替换型段落：放回"未翻译"，让下一轮按新内容重翻。
  // 还是我们写的值的节点恢复原文，被站点改过的节点保持站点的新内容。
  DT.releaseReplaced = function () {
    var released = 0;
    var list = rendered.slice();
    list.forEach(function (rec) {
      if (rec.mode !== 'replace' && rec.mode !== 'ruby') return;
      if (!rec.unit.el.isConnected) {
        dropRendered(rec);
        return;
      }
      if (stillOurs(rec)) return;
      dropRendered(rec);
      released += 1;
    });
    return released;
  };

  function isPositioned(el) {
    var cs = styleOf(el);
    if (!cs) return false;
    var p = cs.position;
    return p === 'fixed' || p === 'sticky' || p === 'absolute';
  }

  // ---------------- 区域模型：这段文字属于页面哪一层 ----------------
  // 'control' 链接 / 按钮 / 菜单项里的文字 → 单语替换（追加会撑破按钮）
  // 'chrome'  导航 / 页头 / 工具栏里的小字号单行文字 → 单语替换（导航条高度固定，追加必溢出）
  // 'content' 其余（标题、正文）→ 双语追加
  // "替换还是追加"只读这一个函数，站点适配问题只改这里。
  // ⚠️ 不要把"文本短"或"元素是 flex"单独当替换条件：
  //    0.3.1 试过"短文本 + 父级是 flex-row 就替换"，整页 flex 的站点标题和正文全被顶掉。

  var CONTROL_TAGS = { A: 1, BUTTON: 1, LABEL: 1, SUMMARY: 1 };
  // 只认完整的 role 名：以前用子串匹配，role="tabpanel"（里面是正文）也会被当成 tab
  var CONTROL_ROLES = /^(button|tab|menuitem|menuitemcheckbox|menuitemradio|option|link|switch|checkbox|radio)$/;
  // 这些标签本身就是正文块，不往上找所属控件（链接里的标题照样双语）
  var CONTENT_TAGS = {
    H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, P: 1, LI: 1, BLOCKQUOTE: 1, DD: 1, DT: 1,
    TD: 1, TH: 1, FIGCAPTION: 1, ARTICLE: 1, SECTION: 1, MAIN: 1, TABLE: 1
  };
  var CONTROL_TEXT_MAX = 80; // 整个控件的文字超过这么长 = 卡片链接，按正文处理
  var CHROME_TEXT_MAX = 80;
  var CONTROL_CLIMB_MAX = 4;
  var CHROME_SELECTOR = 'header,nav,[role="navigation"],[role="banner"],[role="menubar"]';
  // 目录：Wikipedia 的 vector-toc / mw-panel-toc、文档站的 toc / table-of-contents
  var TOC_NAME = /(^|[\s_-])toc([\s_-]|$)|table-?of-?contents/i;

  // 目录里的条目就是正文的小标题，读者要对照着看，按正文双语处理（发版清单："Wikipedia 目录不被替换"）。
  // 目录项本身是导航里的单行链接，不单独排除的话会被判成控件 / 界面文字。
  function inToc(el) {
    for (var node = el; node && node.nodeType === 1 && node !== document.body; node = node.parentElement) {
      if (TOC_NAME.test(node.id || '')) return true;
      if (typeof node.className === 'string' && TOC_NAME.test(node.className)) return true;
    }
    return false;
  }

  function isControl(el) {
    if (CONTROL_TAGS[tagOf(el)]) return true;
    var role = String(el.getAttribute('role') || '').trim().toLowerCase().split(/\s+/)[0];
    return CONTROL_ROLES.test(role);
  }

  function isInlineWrapper(el) {
    var cs = styleOf(el);
    return !!cs && /^(inline|inline-block|inline-flex|inline-grid|contents)$/.test(cs.display);
  }

  // 沿"行内包裹链"找所属控件：<a><svg/><span>Code</span></a> 里的 span 属于这个链接。
  // 中间只能经过行内元素：<a class="card"><div><span>标题</span></div></a> 的 span 不算（隔了块级 div）。
  // 起点本身不要求是行内：flex 控件会把子元素"块化"（computed display 变成 block），但它仍是按钮文字。
  function controlOf(el) {
    if (isControl(el)) return el;
    if (CONTENT_TAGS[tagOf(el)]) return null;
    var node = el;
    for (var depth = 0; depth < CONTROL_CLIMB_MAX; depth += 1) {
      var parent = node.parentElement;
      if (!parent) return null;
      if (isControl(parent)) return parent;
      if (CONTENT_TAGS[tagOf(parent)] || !isInlineWrapper(parent)) return null;
      node = parent;
    }
    return null;
  }

  // 是否只占一行。
  // ⚠️ 不能读 getComputedStyle().height：行内元素的计算值是 "auto"，parseFloat 得 NaN，
  //    判断直接落空 —— GitHub 顶栏中英两行堆叠就是这么来的。
  // 行内元素看它被排成了几个行片段；其它元素看真实盒子的内容高度（扣掉内边距和边框）。
  function isSingleLine(el, cs) {
    if (cs.display === 'inline') return el.getClientRects().length <= 1;
    var fs = parseFloat(cs.fontSize) || 16;
    var lh = parseFloat(cs.lineHeight) || fs * 1.2; // line-height: normal
    var h = el.getBoundingClientRect().height;
    h -= (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    h -= (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    return h <= lh * 1.9;
  }

  // 导航 / 页头里的小字号单行文字
  function isChromeLabel(el) {
    if (!el.closest || !el.closest(CHROME_SELECTOR)) return false;
    var cs = styleOf(el);
    if (!cs) return false;
    var fs = parseFloat(cs.fontSize);
    if (!fs || fs > 20) return false;
    if (textOf(el).length > CHROME_TEXT_MAX) return false;
    return isSingleLine(el, cs);
  }

  // 判定顺序（命中即返回）：
  // 1) 在目录里 → content
  // 2) 自己是控件，或沿行内包裹链能找到所属控件，且整个控件的文字 ≤80 字 → control
  // 3) 在导航 / 页头里，字号 ≤20px，只占一行 → chrome
  // 4) 其余 → content
  DT.areaOf = function (el) {
    if (!el || el.nodeType !== 1) return 'content';
    if (inToc(el)) return 'content';
    var control = controlOf(el);
    if (control && textOf(control).length <= CONTROL_TEXT_MAX) return 'control';
    if (isChromeLabel(el)) return 'chrome';
    return 'content';
  };

  // 从旧签名（元素）临时造一个单元：0.9.0 的自检 / 第三方调用继续可用。
  function legacyUnit(el, own) {
    if (!el || el.nodeType !== 1) return null;
    var tokens = own ? ownTokens(el) : tokensOf(el);
    var map = DT.units.textMap(tokens);
    if (!map.text) return null;
    var groups = lineGroups(el, tokens);
    var filled = [];
    var tail = [];
    groups.forEach(function (g, gi) {
      if (g.filled) filled.push(gi);
    });
    var from = filled.length ? filled[filled.length - 1] + 1 : 0;
    for (var gi = from; gi < groups.length; gi += 1) tail.push(groups[gi]);
    var unit = {
      id: 'u' + (unitSeq += 1),
      el: el,
      text: map.text,
      own: !!own,
      whole: true,
      index: 0,
      total: 1,
      anchor: null,
      map: map,
      sentences: DT.units.sentencesIn(map.text, 0, map.text.length).map(function (s, si) {
        return { index: si, start: s.start, end: s.end, text: s.text };
      }),
      groups: { filled: filled.map(function (i) { return groups[i]; }), tail: tail },
      snapshot: [],
      sig: DT.units.signature(map.text),
      gen: DT.generation,
      area: '',
      ruby: rubyAnnotationsFor(el, map.chars)
    };
    fillSnapshot(unit);
    return unit;
  }

  // 对外：注入一条译文。unit 为段落单元（新调用）或元素（兼容旧调用）
  DT.inject = function (unitOrEl, text, lang, ownOrAlign) {
    var isUnit = !!(unitOrEl && unitOrEl.map && unitOrEl.groups);
    var align = null;
    if (isUnit) {
      align = ownOrAlign && ownOrAlign.parts ? ownOrAlign : null;
    } else if (ownOrAlign && ownOrAlign.parts) {
      align = ownOrAlign;
    }
    var unit = isUnit ? unitOrEl : legacyUnit(unitOrEl, ownOrAlign && ownOrAlign.parts ? false : ownOrAlign);
    if (!unit || !unit.el || !unit.el.isConnected) return false;
    if (!text) return false;
    unit.align = align;
    if (unit.gen !== DT.generation) return false; // 旧代际（还原 / 模式切换后晚到的结果）
    var rec = findRenderedFor(unit.el, unit);
    if (rec && stillOurs(rec)) return false; // 防重复注入
    if (unit.whole && unit.el.hasAttribute('data-dt-src')) return false;
    // 防御：站点可能克隆节点并保留属性，这里再确认一次没插过
    if (unit.whole && unit.el.querySelector && unit.el.querySelector(':scope > [data-dt-target]')) return false;

    var area = unit.area || (unit.area = DT.areaOf(unit.el));
    // 用户可以选择"界面也保留原文"：那样连导航/按钮都不替换，全都追加
    var allowChromeReplace = !(DT.state.config && DT.state.config.chromeBilingual);
    var replaceMode =
      // 1) 仅译文模式
      DT.state.mode === 'translation' ||
      // 2) 绝对/固定定位：盒子尺寸写死，追加必溢出
      isPositioned(unit.el) ||
      // 3) 控件 / 导航里的界面文字
      (allowChromeReplace && area !== 'content');

    if (replaceMode) {
      if (unit.ruby && unit.ruby.length) return injectRuby(unit, text, lang, area);
      return injectReplace(unit, text, area);
    }
    return injectDual(unit, text, lang, area);
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
    var cfg = DT.state.config || {};
    var cur = cfg.currentProvider || '';
    var slot = (cfg.providerConfig || {})[cur] || {};
    var report = {
      version: DT.VERSION,
      url: location.href,
      target: DT.state.target,
      mode: DT.state.mode,
      // 报 bug 时能直接看出用的哪家、哪个模型、思考模式（不含 Key）
      provider: cur,
      engine: slot.engine || '',
      model: slot.model || '',
      thinkingMode: cfg.thinkingMode || '',
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
        area: DT.areaOf(el),
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

    function reportRanges(el, tokens, own) {
      var map = DT.units.textMap(tokens);
      if (!map.text) return;
      var ranges = paragraphRanges(map);
      ranges.forEach(function (range, index) {
        if (report.units.length >= max) return;
        var text = map.text.slice(range.start, range.end);
        if (!text) return;
        var u = info(el);
        u.text = previewText(text);
        u.length = text.length;
        u.lines = DT.splitLines(text).length;
        u.paragraph = {
          index: index,
          total: ranges.length,
          anchor: ranges.length > 1 && range.splittable ? 'before-br' : 'inside'
        };
        u.skipByLength = DT.skipText(text);
        u.alreadyTarget = DT.looksLikeTarget(text, DT.state.target);
        report.units.push(u);
      });
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
        reportRanges(el, tokensOf(el), false);
        return;
      }

      if (!usableChildren(el)) {
        if (own) reportRanges(el, ownTokens(el), true);
        return;
      }

      if (own || !shouldDescend(el)) {
        reportRanges(el, tokensOf(el), false);
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
  // 不清空整页译文（那会造成整页闪烁重翻），只撤掉那些源文本确实变了的段落。
  DT.refreshStale = function () {
    var removed = DT.releaseReplaced();
    var list = rendered.slice();
    list.forEach(function (rec) {
      if (rec.mode !== 'dual') return;
      if (!rec.unit.el.isConnected) {
        dropRendered(rec);
        return;
      }
      if (rec.node && !rec.node.isConnected) {
        dropRendered(rec);
        removed += 1;
        return;
      }
      if (sourceChangedSnapshot(rec.unit)) {
        dropRendered(rec);
        removed += 1;
      }
    });
    return removed;
  };

  // 对外：还原原文。逆序回放 RenderTransaction：
  // 只撤销仍是我们写入的值 / 仍是我们的节点；站点已经改过 / 删除的，保留站点的新状态。
  DT.restore = function () {
    for (var i = tx.length - 1; i >= 0; i -= 1) undoOps([tx[i]]);
    tx = [];
    rendered = [];
    renderedByEl = new WeakMap();
    nodeUnit = new WeakMap();
    elUnits = new WeakMap();
    ownNodes = new WeakSet();
    DT.replaced = [];
    DT.bumpGeneration();

    // 兜底：记录丢了（站点克隆过节点 / 扩展重复注入）也不能留下收起的换行、隐藏的注音
    var folded = document.querySelectorAll('[data-dt-collapsed]');
    for (var f = 0; f < folded.length; f += 1) folded[f].removeAttribute('data-dt-collapsed');
    var hidden = document.querySelectorAll('[data-dt-rt-hidden]');
    for (var h = 0; h < hidden.length; h += 1) {
      hidden[h].removeAttribute('data-dt-rt-hidden');
      if (hidden[h].style && hidden[h].style.display === 'none') hidden[h].style.display = '';
    }

    // 移除追加的译文节点
    var targets = document.querySelectorAll('[data-dt-target]');
    for (var t = 0; t < targets.length; t += 1) {
      if (targets[t].closest && targets[t].closest('[data-dt-ui]')) continue;
      targets[t].remove();
    }

    // 清掉标记
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
