// 内容脚本：DOM 引擎
// 切分策略：容器（无直接文本、有多个子元素）→ 逐个下钻；
//          段落（有直接文本，或是叶子元素）→ 整体作为一个单元；
//          有直接文本但夹着块级 / 控件子元素 → 只收自己的行内文字，那些子元素再下钻。
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
  var renderedByEl = new WeakMap(); // 元素 → 该元素已渲染的记录（兼容 / 调试）
  var renderedByIndex = new WeakMap(); // 元素 → Map(段序号 → 记录)
  var renderedBySig = new WeakMap(); // 元素 → Map(源文本签名 → 记录[])
  var savedRecord = new WeakMap(); // 我们写过的文本节点 → 替换型记录（O(1) 找同段）
  var targetRegistry = new Map(); // data-dt-unit → 真正的译文节点（识别克隆副本）
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

  // 段落单元的屏幕矩形：用第一段原文文本节点算，不能用整个容器（多段落共用容器时
  // 容器有多高，整页段落就会被算成"离屏幕一样近"，懒翻译失效）。
  DT.rectOfUnit = function (unit) {
    if (!unit) return null;
    var node = unit.firstNode;
    if (node && node.isConnected) {
      try {
        // 只量第一个字符：selectNodeContents 在长段落上会横跨所有行，
        // 懒翻译每轮对每个单元都做一次会很贵。
        var range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, Math.min(1, node.nodeValue ? node.nodeValue.length : 1));
        var box = range.getBoundingClientRect();
        if (box && (box.width || box.height)) return box;
      } catch (err) {
        /* 节点被移走 / 老浏览器：退回元素矩形 */
      }
    }
    return unit.el && unit.el.getBoundingClientRect ? unit.el.getBoundingClientRect() : null;
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

  // 一次 collect 内缓存 getComputedStyle：isSkipped / tokensOf / shouldDescend / areaOf
  // 会对同一个元素反复取样式，10k 节点时这是明显的主线程开销。
  var scanStyles = null;
  var renderStyles = null;
  // 一轮同步注入内缓存源元素的 computed style：makeNode / copyTypography / 首字下沉
  // 会对同一个容器反复 getComputedStyle；每次插入译文后再读样式会触发整段重排。
  DT.beginRenderCache = function () {
    renderStyles = new WeakMap();
  };
  DT.endRenderCache = function () {
    renderStyles = null;
  };
  function styleOf(el) {
    var cache = scanStyles || renderStyles;
    if (cache) {
      var hit = cache.get(el);
      if (hit !== undefined) return hit;
    }
    var cs = null;
    try {
      cs = getComputedStyle(el);
    } catch (err) {
      cs = null;
    }
    // 缓存时复制成普通对象：CSSStyleDeclaration 是实时的，读过一次后
    // 页面再插入节点，再读任意属性都可能触发 style recalc（3000 段注入会变成 O(n²)）。
    var snap = cs
      ? {
          display: cs.display,
          whiteSpace: cs.whiteSpace,
          whiteSpaceCollapse: cs.whiteSpaceCollapse,
          position: cs.position,
          float: cs.float,
          width: cs.width,
          fontSize: cs.fontSize,
          lineHeight: cs.lineHeight,
          fontWeight: cs.fontWeight,
          fontStyle: cs.fontStyle,
          letterSpacing: cs.letterSpacing,
          textTransform: cs.textTransform,
          color: cs.color,
          paddingTop: cs.paddingTop,
          paddingBottom: cs.paddingBottom,
          borderTopWidth: cs.borderTopWidth,
          borderBottomWidth: cs.borderBottomWidth
        }
      : null;
    if (cache) cache.set(el, snap);
    return snap;
  }

  // recheck：walk() 自己要重新检查的已翻译元素（有渲染记录、但源文本变了 / 只翻了直接文本），
  // 这时 data-dt-src 不算跳过理由。父级判断子元素时不传：已翻译的子元素仍不能被拼进父级再翻一遍。
  function isSkipped(el, recheck) {
    if (!el || el.nodeType !== 1) return true;
    if (SKIP_TAGS[tagOf(el)]) return true;
    if (el.hasAttribute('data-dt-target')) return true;
    if (!recheck && el.hasAttribute('data-dt-src')) return true; // 已翻译过
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
          var tag = tagOf(kid);
          if (NON_TEXT_TAGS[tag]) continue;
          if (tag === 'BR') {
            // 仅译文模式下因译文行数不够而收起的换行，不算一行
            if (!kid.hasAttribute('data-dt-collapsed')) out.push({ br: kid });
            continue;
          }
          // 隐藏子树（display:none 的对话框 / 展开菜单）不算正文：
          // 以前会把 GitHub 设置页里隐藏的确认对话框文案拼进按钮文本，整行布局被撑坏
          if (kid.hidden) continue;
          // Ruby 的基字/读音是行内结构，几乎不会自己 display:none；父级隐藏已经拦过。
          // 长文里每个 ruby 都 getComputedStyle 一次，在已注入译文的页面上会反复触发样式计算。
          if (tag === 'RUBY' || tag === 'RB') {
            visit(kid, keep);
            continue;
          }
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
        // 块级子元素当的段落边界（flowTokens）不是 <br>：仅译文模式不能「收起」它
        groups.push({ pieces: [], filled: false, keep: false, br: tok.boundary ? null : tok.br, nl: null });
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

  // 交互控件：容器里有这些就不能整块替换（0.7.2，GitHub 设置页按钮被挤成竖排）
  var CONTROL_SELECTOR =
    'button, input, select, textarea, summary, [role="button"], [role="menuitem"], [role="menu"], [role="dialog"], [role="alertdialog"], [role="toolbar"]';

  // 打断父级行内文字流的子元素：可见的块级 / 弹性布局盒子；非正文块里，带交互控件的子元素也算。
  // 已翻过（data-dt-src）/ notranslate 的块级子元素照样算：它们不属于父级这一段，不能被拼进来再翻一遍。
  // 图片、视频这类跳过的标签不算（不影响父级的文字）；<pre> 算，代码块不该被拼进句子。
  function breaksFlow(parent, kid) {
    if (kid.hasAttribute('data-dt-target') || kid.hasAttribute('data-dt-ui')) return false;
    var tag = tagOf(kid);
    if (tag === 'BR' || (SKIP_TAGS[tag] && tag !== 'PRE')) return false;
    if (kid.hidden) return false;
    var cs = styleOf(kid);
    if (cs && cs.display === 'none') return false;
    if (isStructural(kid)) return true;
    if (CONTENT_TAGS[tagOf(parent)]) return false;
    return !!(kid.matches(CONTROL_SELECTOR) || kid.querySelector(CONTROL_SELECTOR));
  }

  // node 所在的、el 的直接子节点（node 不在 el 里时返回 null）
  function topChild(el, node) {
    for (var top = node; top && top.parentNode; top = top.parentNode) {
      if (top.parentNode === el) return top;
    }
    return null;
  }

  // node 落在 el 自己的行内文字里，而不是某个打断文字流的子元素里
  function inFlow(el, node) {
    var top = topChild(el, node);
    return !!top && (top.nodeType !== 1 || !breaksFlow(el, top));
  }

  function flowBreaks(el) {
    var out = [];
    var kids = el.children;
    for (var i = 0; i < kids.length; i += 1) {
      if (breaksFlow(el, kids[i])) out.push(kids[i]);
    }
    return out;
  }

  // 夹着块级子元素的容器自己那段文字：直接文本、<br>、行内代码、没被跳过的行内子元素（链接 / 强调 / ruby）。
  // 块级子元素记成一个空行（段落边界），块前块后各成一段；锚点就是这个子元素，双语译文插在它前面。
  // 0.9.6 实例：Partner Center 的 .container 只有一点直接文本，整个 Dashboard 被当成一段压平，页面白屏
  function flowTokens(el, breaks) {
    var out = [];
    var skip = new Set(breaks);
    var keep = keepsBreaks(styleOf(el));
    var kids = el.childNodes;
    for (var i = 0; i < kids.length; i += 1) {
      var kid = kids[i];
      if (kid.nodeType === 3) {
        if (kid.nodeValue) out.push({ node: kid, keep: keep });
        continue;
      }
      if (kid.nodeType !== 1) continue;
      var tag = tagOf(kid);
      if (skip.has(kid)) {
        out.push({ br: kid, boundary: true }, { br: kid, boundary: true });
      } else if (tag === 'BR') {
        if (!kid.hasAttribute('data-dt-collapsed')) out.push({ br: kid });
      } else if (INLINE_CODE_TAGS[tag]) {
        out = out.concat(tokensOf(kid));
      } else if (!isSkipped(kid)) {
        out = out.concat(tokensOf(kid));
      }
    }
    return out;
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
      if (el.querySelector && el.querySelector(CONTROL_SELECTOR)) return true;
    }
    // 正文块里的 3+ 个行内子元素（OWID 的 <p> 有 8 个：句子 span、脚注、行内链接）
    // 以前会逐个子元素拆，译文插在句子中间；整段翻、追加到段末可读性更好。
    if (CONTENT_TAGS[tagName]) return false;
    return usable >= 3;
  }

  // ---------------- 0.9.2 段落单元收集 ----------------
  // 一个元素里的文本先摊成带 DOM 映射的规范化文本（DT.units.textMap），
  // 再按排版语义（空行 / 单 <br>+源码换行+全角缩进）切段。
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
    // 兜底：整篇文章被识别成一个巨大单元（没有任何全角缩进 / 空行 / 块级边界），
    // 但里面有 8 个以上真实 <br> 行、超过 800 字。宁可按行拆成可诊断的单元，
    // 也不静默把整篇文章 append 成一个单元、在页尾堆一大块译文。
    // 只在分隔都是 <br>（可以安全插入锚点）时启用；pre-* 的 nl 分隔仍交给上层合并。
    if (out.length === 1 && map.text.length > 800) {
      var hard = DT.units.linesOf(map.text);
      if (hard.length >= 8) {
        var lineRanges = [];
        var canSplit = true;
        for (var hi = 0; hi < hard.length; hi += 1) {
          var edge = map.chars[hard[hi][1]];
          if (hi < hard.length - 1 && (!edge || !edge.br)) {
            canSplit = false;
            break;
          }
          lineRanges.push({
            start: hard[hi][0],
            end: hard[hi][1],
            sepStart: hard[hi][1],
            sepEnd: hi < hard.length - 1 ? hard[hi + 1][0] : map.text.length,
            splittable: true
          });
        }
        if (canSplit) {
          lineRanges.fallback = 'line';
          return lineRanges;
        }
      }
    }
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
  function rubyAnnotationsFor(el, chars, bounds, own, assigned) {
    var out = [];
    var seen = new Set();
    function add(node) {
      if (!seen.has(node)) {
        seen.add(node);
        out.push(node);
      }
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
    // assigned：addParagraphs 按 DOM 顺序一次分好的本段 <ruby>（图片基字也能覆盖）。
    // 这条路径是 O(段落数 + ruby 数)，不会每段都对所有 ruby 做 querySelectorAll + Range。
    if (assigned) {
      assigned.forEach(function (ruby) {
        var kids = ruby.querySelectorAll('rt, rp');
        for (var i = 0; i < kids.length; i += 1) add(kids[i]);
      });
      return out;
    }
    // 兼容旧调用（legacyUnit / 外部）：按段落的 DOM 范围再扫一遍 <ruby>。
    if (bounds && !own) {
      try {
        var range = document.createRange();
        if (bounds.startAfter && bounds.startAfter.parentNode) range.setStartAfter(bounds.startAfter);
        else range.setStart(el, 0);
        if (bounds.endBefore && bounds.endBefore.parentNode) range.setEndBefore(bounds.endBefore);
        else range.setEnd(el, el.childNodes.length);
        var rubies = el.querySelectorAll('ruby');
        for (var r = 0; r < rubies.length; r += 1) {
          if (!range.intersectsNode(rubies[r])) continue;
          var inner = rubies[r].querySelectorAll('rt, rp');
          for (var k = 0; k < inner.length; k += 1) add(inner[k]);
        }
      } catch (err) {
        /* DOM 范围不可用（节点被移走 / 老浏览器）：退回字符映射，不阻断翻译 */
      }
    }
    return out;
  }

  function fillSnapshot(unit) {
    var snap = [];
    var seen = new Set();
    (unit.map.chars || []).forEach(function (c) {
      if (!c) return;
      var node = c.node || (c.nl && c.nl.node) || null;
      if (!node || seen.has(node)) return;
      seen.add(node);
      snap.push({ node: node, value: node.nodeValue });
    });
    unit.snapshot = snap;
  }

  // 一个元素的「源文本签名」：正文文本 / <br> / 可见性相关属性，跳过译文节点、RT/RP、UI。
  // 全部段落已渲染且签名没变时，addParagraphs 可以直接返回，不必重跑 textMap / 行分组。
  function sourceSignature(el) {
    var h = 2166136261;
    var chars = 0;
    var brs = 0;
    function mix(code) {
      h ^= code;
      h = (h * 16777619) >>> 0;
    }
    function mixText(value) {
      for (var i = 0; i < value.length; i += 1) mix(value.charCodeAt(i));
    }
    mixText(el.getAttribute('class') || '');
    mixText(el.getAttribute('style') || '');
    mixText(el.getAttribute('aria-hidden') || '');
    mix(el.hidden ? 1 : 0);
    (function visit(node) {
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i += 1) {
        var kid = kids[i];
        if (kid.nodeType === 3) {
          var v = kid.nodeValue || '';
          for (var c = 0; c < v.length; c += 1) mix(v.charCodeAt(c));
          chars += v.length;
          continue;
        }
        if (kid.nodeType !== 1) continue;
        if (kid.hasAttribute('data-dt-target') || kid.hasAttribute('data-dt-ui')) continue;
        var tag = tagOf(kid);
        if (NON_TEXT_TAGS[tag]) continue;
        if (tag === 'BR') {
          mix(10);
          brs += 1;
          continue;
        }
        // 可见性 / 弹出的 class 变化也要进签名：否则隐藏对话框显示出来时
        // 源文本可能一样，整块早退会把它漏掉。只混入属性字符串，不读 computed style。
        var cls = kid.getAttribute('class') || '';
        var sty = kid.getAttribute('style') || '';
        var aria = kid.getAttribute('aria-hidden') || '';
        for (var c2 = 0; c2 < cls.length; c2 += 1) mix(cls.charCodeAt(c2));
        for (var s2 = 0; s2 < sty.length; s2 += 1) mix(sty.charCodeAt(s2));
        for (var a2 = 0; a2 < aria.length; a2 += 1) mix(aria.charCodeAt(a2));
        mix(kid.hidden ? 1 : 0);
        if (kid.hidden) continue;
        visit(kid);
      }
    })(el);
    return chars + ':' + brs + ':' + (h >>> 0);
  }

  function refreshElementSignature(el) {
    if (!el || !el.__dtRanges) return;
    var map = renderedByIndex.get(el);
    if (map && map.size >= el.__dtRanges) el.__dtSourceSig = sourceSignature(el);
  }

  function elementFullyRendered(el) {
    var known = renderedByIndex.get(el);
    if (!known || !el.__dtRanges || known.size < el.__dtRanges) return false;
    if (el.__dtSourceSig !== sourceSignature(el)) return false;
    var all = true;
    known.forEach(function (rec) {
      if (!stillOurs(rec)) all = false;
    });
    return all;
  }

  // 这个元素自己有没有渲染过的段落（双语 / 替换 / Ruby）
  function hasRendered(el) {
    var list = renderedByEl.get(el);
    return !!(list && list.length);
  }

  // 渲染过的段落全是 own 单元：只翻了直接文本（子元素当时都被跳过），不覆盖子元素。
  // 隐藏的子菜单以后显示出来还得下钻，所以 walk() 不能因为它「整块已翻译」就早退。
  function ownOnly(el) {
    var list = renderedByEl.get(el);
    if (!list || !list.length) return false;
    for (var i = 0; i < list.length; i += 1) {
      if (!list[i].unit.own) return false;
    }
    return true;
  }

  // 撤掉这个元素自己的段落记录（which 可选：只撤满足条件的），返回撤掉了几条。
  // 不带 which：它不再按原来的样子成段（变成了容器要下钻，或要并成整段重新收集）
  function releaseRecords(el, which) {
    var list = renderedByEl.get(el);
    if (!list || !list.length) return 0;
    var dropped = 0;
    list.slice().forEach(function (rec) {
      if (which && !which(rec)) return;
      dropRendered(rec);
      dropped += 1;
    });
    return dropped;
  }

  function isDual(rec) {
    return rec.mode === 'dual';
  }

  // 双语段落的原文变了（站点改字 / 换掉文本节点），或译文节点被站点删了
  function isStaleDual(rec) {
    return rec.mode === 'dual' && (!stillOurs(rec) || sourceChangedSnapshot(rec.unit));
  }

  // partial：这些段落只是容器自己的行内文字（flowTokens），不覆盖整个元素 ——
  // 单元不算 whole（不打 data-dt-src，否则 isSkipped 会让整棵子树以后都不再扫描，
  // 懒翻译到不了屏幕外的子段落），译文跟在这段文字后面而不是追加到容器末尾。
  function addParagraphs(out, el, tokens, own, partial) {
    // 全部段落已渲染、源文本签名没变：整块直接跳过，不重跑 textMap / 行分组。
    if (elementFullyRendered(el)) return;
    var map = DT.units.textMap(tokens);
    if (!map.text) return;
    var ranges = paragraphRanges(map);
    // 同一容器里的多个段落共用区域判定：长正文里每段都 areaOf() 会反复量整块布局。
    // 但它是布局读取：全部段落都已渲染时不能白量一次（增量重扫在长文上会强制整页重排）。
    var sharedArea = null;
    var areaComputed = false;
    var changed = false; // 有没有段落要重新收集（新段落 / 撤掉了旧译文）
    var groups = lineGroups(el, tokens);
    // Ruby 一次分配：按文档顺序扫一遍所有 <ruby>，用段落分隔 <br> 当边界。
    // 以前每个段落都 querySelectorAll('ruby') + Range.intersectsNode，长文 + 多 ruby 是 O(n²)。
    // 懒执行：全部段落都已渲染时不需要分配。
    var rubyGroups = null;
    function ensureRubyGroups() {
      if (rubyGroups) return;
      rubyGroups = [];
      if (own || ranges.length <= 1) return;
      var allRubies = el.querySelectorAll('ruby');
      if (!allRubies.length) return;
      var rp = 0;
      for (var ri = 0; ri < allRubies.length; ri += 1) {
        var ruby = allRubies[ri];
        // 局部段落：块级子元素（标题等）里的 ruby 属于那个子元素自己的单元，不能被这里隐藏注音
        if (partial && !inFlow(el, ruby)) continue;
        while (rp < ranges.length - 1) {
          var endMeta = map.chars[ranges[rp].sepStart];
          var endNode = endMeta && endMeta.br;
          if (!endNode) break;
          // ruby 在分隔 <br> 之后 → 不属于当前段
          if (!(endNode.compareDocumentPosition(ruby) & 4)) break;
          rp += 1;
        }
        if (!rubyGroups[rp]) rubyGroups[rp] = [];
        rubyGroups[rp].push(ruby);
      }
    }
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

    el.__dtRanges = ranges.length;
    el.__dtPartial = !!partial;
    ranges.forEach(function (range, index) {
      // MAX_UNITS 必须在单元生成循环里也生效：一个容器可以切出上万个段落，
      // 不能只靠 walk() 入口的检查。
      if (out.length >= MAX_UNITS) return;
      var text = map.text.slice(range.start, range.end);
      if (!text) return;
      // 已翻译的段落：在构建 map / snapshot / ruby 之前就跳过。
      // 否则每次增量重扫 3000 段都要再建一遍单元对象，几百毫秒到秒级。
      var indexMap = renderedByIndex.get(el);
      var early = indexMap ? indexMap.get(index) : null;
      if (early && stillOurs(early)) {
        // Ruby 段落的正文被清空了，字符映射里没有可核对的节点；译文节点在就够了。
        if (early.mode === 'ruby') return;
        if (early.mode === 'dual') {
          if (early.unit.sig === DT.units.signature(text) && !sourceChangedSnapshot(early.unit)) {
            return;
          }
        } else if (early.savedNodes) {
          for (var ec = range.start; ec < range.end; ec += 1) {
            var ecMeta = map.chars[ec];
            if (ecMeta && ecMeta.node && early.savedNodes.has(ecMeta.node)) return;
          }
        }
      }
      var anchor = null;
      if (ranges.length > 1 && range.splittable) {
        var meta = map.chars[range.sepStart];
        if (meta && meta.br && meta.br.parentNode) anchor = { parent: meta.br.parentNode, before: meta.br };
      } else if (ranges.length > 1 && index === ranges.length - 1 && map.trailingBreak && map.trailingBreak.br) {
        // 最后一段：插在尾部空行之前，不能 append 到容器最末尾
        anchor = { parent: map.trailingBreak.br.parentNode, before: map.trailingBreak.br };
      }
      if (partial && !anchor) {
        // 局部段落的最后一段：插在这段文字之后（下一个子块之前），不追加到容器末尾
        var lastNode = null;
        for (var li = range.end - 1; li >= range.start && !lastNode; li -= 1) {
          if (map.chars[li] && map.chars[li].node) lastNode = map.chars[li].node;
        }
        var lastTop = lastNode ? topChild(el, lastNode) : null;
        if (lastTop) anchor = { parent: el, before: lastTop.nextSibling };
      }
      var picked = picks[index] || [];
      var lastFilled = picked.length ? picked[picked.length - 1] : -1;
      var tail = [];
      if (ranges.length === 1) {
        for (var gi = lastFilled + 1; gi < groups.length; gi += 1) tail.push(groups[gi]);
      }
      // Ruby 的 DOM 范围：从上一段分隔 <br> 之后到本段分隔 <br> 之前，
      // 这样基字是 <img> 的 ruby 也能归到本段。
      var rubyBounds = null;
      if (ranges.length > 1) {
        var prevSep = index > 0 ? map.chars[ranges[index - 1].sepStart] : null;
        var endSep = range.splittable ? map.chars[range.sepStart] : null;
        rubyBounds = {
          startAfter: prevSep && prevSep.br ? prevSep.br : null,
          endBefore: endSep && endSep.br ? endSep.br : null
        };
      }
      if (!areaComputed && ranges.length > 1) {
        sharedArea = DT.areaOf(el);
        areaComputed = true;
      }
      if (!rubyGroups) ensureRubyGroups();
      var assignedRuby = rubyGroups ? rubyGroups[index] : null;
      // 局部段落不走「按 DOM 范围扫 ruby」的兜底：两段之间夹着标题等块级子元素，会把它们的注音也算进来
      if (partial && !assignedRuby) assignedRuby = [];
      var firstNode = null;
      for (var ci = 0; ci < map.chars.length; ci += 1) {
        var cm = map.chars[ci];
        if (cm && cm.node) { firstNode = cm.node; break; }
      }
      var unit = {
        id: 'u' + (unitSeq += 1),
        el: el,
        firstNode: firstNode,
        text: text,
        own: !!own,
        whole: ranges.length === 1 && !partial,
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
        area: sharedArea,
        fallback: ranges.fallback || '',
        ruby: rubyAnnotationsFor(el, map.chars.slice(range.start, range.end), rubyBounds, own, assignedRuby)
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
      changed = true;
      if (!collectAccept || collectAccept(unit)) out.push(unit);
    });
    // 签名变了、但每一段都还是原样（只是子元素的 class / style 变了）：记下新签名，
    // 下一轮 walk() 又能整块早退，不用每次都重建 textMap
    if (!changed) refreshElementSignature(el);
  }

  function walk(el, out) {
    if (out.length >= MAX_UNITS) return;
    if (!el || el.nodeType !== 1) return;
    // 整块已翻译且源文本没变：在 isSkipped 的 getComputedStyle 之前返回。
    // 站点插入译文后，容器首次取样式会强制整块重排，长文增量重扫会因此卡住。
    // 局部段落（夹着块级子元素的容器）、只翻了直接文本的元素（own 单元）例外：
    // 自己那段翻完了，子元素还得接着下钻（隐藏的子菜单显示出来也要补收）。
    var ownDone = ownOnly(el);
    if (!el.__dtPartial && !ownDone && elementFullyRendered(el)) return;
    // 走到这里还带着渲染记录的元素：源文本签名变了、译文被站点删了，或只翻了直接文本。
    // 重新检查，不按 data-dt-src 整棵跳过（0.9.6：双语改字后旧译文一直挂着，子菜单显示出来也不翻）。
    // 没有渲染记录的 data-dt-src（站点克隆出来的节点）照旧跳过。
    var known = hasRendered(el);
    if (isSkipped(el, known)) return;
    // 先撤掉原文已经变了的双语译文，再按现在的结构判断：旧译文节点不能被当成子元素
    if (known && releaseRecords(el, isStaleDual)) {
      ownDone = ownOnly(el);
      known = hasRendered(el);
    }

    var own = directText(el);

    // 只翻了直接文本的元素，子元素露出来了（子菜单 display:none → block、行内子元素显示出来）：按现在的结构重新收集。
    // 露出来的是块级子元素：第 3 步把自己那段收成局部段落、子块各自下钻。双语译文原来追加在元素末尾，
    // 现在会掉到子菜单下面，撤掉重插到子块前面；替换型是原地写的，位置不变，留着不闪。
    // 露出来的是行内子元素（句子的一部分）：全部撤掉，并成整段重收
    if (ownDone && el.children.length && usableChildren(el)) {
      releaseRecords(el, own && flowBreaks(el).length ? isDual : null);
    }

    // 1) 真叶子：直接作为（一个或多个）段落单元
    if (!el.children.length) {
      addParagraphs(out, el, tokensOf(el), false);
      return;
    }

    // 2) 子元素全被跳过（已翻译 / 不可见）：父级只翻自己的直接文本。
    //    已翻译的子元素照样交给 walk()：改了字 / 子菜单显示出来时，由它自己重新检查
    if (!usableChildren(el)) {
      if (own) addParagraphs(out, el, ownTokens(el), true);
      else if (known) releaseRecords(el, isDual); // 自己的字没了（站点删了 / 子元素藏起来了）
      var done = el.children;
      for (var d = 0; d < done.length; d += 1) {
        if (done[d].hasAttribute('data-dt-src')) walk(done[d], out);
      }
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
      // 有直接文本、但夹着块级 / 控件子元素：这是容器（SPA 外壳、嵌套列表的 <li>、
      // 正文里夹标题的青空文库），不是段落。只收自己的行内文字，打断文字流的子元素再下钻；
      // 行内子元素已经拼进这段，不再单独收。判据只看结构，不看文字多少：
      // 「See <a>很长的链接</a>.」、「<span>Hello</span> <span>World</span>」仍是一句
      var breaks = own ? flowBreaks(el) : [];
      if (breaks.length) {
        addParagraphs(out, el, flowTokens(el, breaks), false, true);
        for (var bi = 0; bi < breaks.length; bi += 1) walk(breaks[bi], out);
        return;
      }
      addParagraphs(out, el, tokensOf(el), false);
      return;
    }

    // 4) 容器 → 逐个下钻。以前整块翻过、现在要拆开的元素（子菜单显示出来了）：
    //    先撤掉整块的旧译文，否则子元素再各翻一遍就重复了
    if (known) releaseRecords(el);
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
    // 站点规则可能匹配上万个根：不要用 found.some(contains) 做 O(n²) 嵌套过滤。
    var set = new Set(found);
    return found.filter(function (el) {
      for (var parent = el.parentElement; parent; parent = parent.parentElement) {
        if (set.has(parent)) return false;
      }
      return true;
    });
  };

  // 按站点规则的根逐个收集；任何一个根收满了上限都算本轮收满
  DT.collectAll = function (accept) {
    var out = [];
    var full = false;
    var roots = DT.collectRoots();
    for (var i = 0; i < roots.length; i += 1) {
      if (out.length >= MAX_UNITS) {
        full = true;
        break;
      }
      out = out.concat(DT.collect(roots[i], accept));
      if (DT.lastCollectFull) full = true;
    }
    if (out.length >= MAX_UNITS) full = true;
    DT.lastCollectFull = full;
    return out;
  };

  DT.collect = function (root, accept) {
    var out = [];
    var start = root || document.body;
    DT.lastCollectFull = false;
    if (!start) return out;
    collectAccept = accept || null;
    scanStyles = new WeakMap();
    try {
      walk(start, out);
    } catch (err) {
      DT.log('collect error', err);
    } finally {
      collectAccept = null;
      scanStyles = null;
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
    // 局部撤销的 op 会标 done；正常翻译也会不断追加。超过阈值定期压掉已完成的，
    // 避免长时间运行的页面让 DT.tx 只增不减。
    if (tx.length > 4000 && tx.length % 1000 === 0) compactTx();
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
      if (op.done) continue;
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
      op.done = true;
    }
  }

  // 局部撤销（模式切换 / 站点改写 / 节点删除）后，事务里的旧 op 不能再留着：
  // 它们仍引用已经恢复或脱离页面的节点，长时间运行会让 DT.tx 无限增长。
  function compactTx() {
    if (tx.length < 4000) return;
    var kept = [];
    for (var i = 0; i < tx.length; i += 1) {
      if (!tx[i].done) kept.push(tx[i]);
    }
    tx = kept;
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
    // 替换型 / Ruby：我们写过的文本节点 → 记录，O(源节点数)；
    // 同容器里文本相同的两段也不会认错。
    if (unit.snapshot && unit.snapshot.length) {
      for (var s = 0; s < unit.snapshot.length; s += 1) {
        var byNode = savedRecord.get(unit.snapshot[s].node);
        if (byNode && byNode.unit.el === el) return byNode;
      }
    }
    var indexMap = renderedByIndex.get(el);
    var same = indexMap ? indexMap.get(unit.index) : null;
    if (same) {
      // 同序号：双语的源文本签名变了也先返回，交给 addParagraphs 撤销后重收；
      // 替换型没有节点重叠说明站点重建了这一段，先释放旧记录。
      if (same.mode === 'dual' || !unit.snapshot || !same.savedNodes || same.savedNodes.size === 0) return same;
      var overlap = false;
      for (var i = 0; i < unit.snapshot.length; i += 1) {
        if (same.savedNodes.has(unit.snapshot[i].node)) {
          overlap = true;
          break;
        }
      }
      if (overlap) return same;
      dropRendered(same);
      return null;
    }
    // 双语段落重排：同一签名 + 同一分隔 <br> 锚点 → 还是同一段
    if (!unit.anchor) return null;
    var sigMap = renderedBySig.get(el);
    var list = sigMap ? sigMap.get(unit.sig) : null;
    if (list) {
      for (var k = 0; k < list.length; k += 1) {
        var rec = list[k];
        if (rec.mode === 'dual' && rec.unit.anchor && rec.unit.anchor.before === unit.anchor.before) return rec;
      }
    }
    return null;
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

  function registerTarget(node, id) {
    if (node && id) targetRegistry.set(id, node);
  }
  DT.isKnownTarget = function (node) {
    if (!node || node.nodeType !== 1) return false;
    var id = node.getAttribute('data-dt-unit');
    return !!(id && targetRegistry.get(id) === node);
  };
  // 克隆节点带着同一个 data-dt-unit：只有登记过的那一个是原节点。
  DT.removeCloneTarget = function (node) {
    if (!node || node.nodeType !== 1) return false;
    var id = node.getAttribute('data-dt-unit');
    if (!id) return false;
    var original = targetRegistry.get(id);
    return !!(original && original !== node);
  };

  function pushRendered(rec) {
    rendered.push(rec);
    var el = rec.unit.el;
    var list = renderedByEl.get(el);
    if (!list) {
      list = [];
      renderedByEl.set(el, list);
    }
    list.push(rec);

    var indexMap = renderedByIndex.get(el);
    if (!indexMap) {
      indexMap = new Map();
      renderedByIndex.set(el, indexMap);
    }
    indexMap.set(rec.unit.index, rec);

    if (rec.mode === 'dual') {
      var sigMap = renderedBySig.get(el);
      if (!sigMap) {
        sigMap = new Map();
        renderedBySig.set(el, sigMap);
      }
      var arr = sigMap.get(rec.unit.sig);
      if (!arr) {
        arr = [];
        sigMap.set(rec.unit.sig, arr);
      }
      arr.push(rec);
    } else {
      var nodes = new Set();
      (rec.saved || []).forEach(function (one) {
        if (one.node) nodes.add(one.node);
      });
      rec.savedNodes = nodes;
      nodes.forEach(function (node) {
        savedRecord.set(node, rec);
      });
    }
    refreshElementSignature(el);
  }

  function dropRendered(rec) {
    if (!rec) return;
    undoOps(rec.ops);
    compactTx();
    var i = rendered.indexOf(rec);
    if (i >= 0) rendered.splice(i, 1);
    var el = rec.unit.el;
    var elList = renderedByEl.get(el);
    if (elList) {
      var j = elList.indexOf(rec);
      if (j >= 0) elList.splice(j, 1);
    }
    var indexMap = renderedByIndex.get(el);
    if (indexMap && indexMap.get(rec.unit.index) === rec) indexMap.delete(rec.unit.index);
    if (rec.mode === 'dual') {
      var sigMap = renderedBySig.get(el);
      var arr = sigMap ? sigMap.get(rec.unit.sig) : null;
      if (arr) {
        var k = arr.indexOf(rec);
        if (k >= 0) arr.splice(k, 1);
      }
    } else if (rec.savedNodes) {
      rec.savedNodes.forEach(function (node) {
        if (savedRecord.get(node) === rec) savedRecord.delete(node);
      });
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
    if (rec.node && rec.node.getAttribute && targetRegistry.get(rec.node.getAttribute('data-dt-unit')) === rec.node) {
      targetRegistry.delete(rec.node.getAttribute('data-dt-unit'));
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
    registerTarget(node, unit.id);
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
    fillSnapshot(unit); // 快照改成"替换后的源文本"，下次 sourceChangedSnapshot 不会误报
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
    registerTarget(target, unit.id);
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
    var legacyFirst = null;
    for (var li = 0; li < map.chars.length; li += 1) {
      if (map.chars[li] && map.chars[li].node) { legacyFirst = map.chars[li].node; break; }
    }
    var unit = {
      id: 'u' + (unitSeq += 1),
      el: el,
      firstNode: legacyFirst,
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
          anchor: ranges.length > 1 && range.splittable ? 'before-br' : 'inside',
          fallback: ranges.fallback || ''
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
        // 和 walk() 第 3 步同一判据，诊断里的单元才和真实收集一致
        var breaks = own ? flowBreaks(el) : [];
        if (breaks.length) {
          reportRanges(el, flowTokens(el, breaks), false);
          for (var bi = 0; bi < breaks.length; bi += 1) walkDiag(breaks[bi]);
          return;
        }
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

  // 页面把整块内容删掉（无限滚动 / SPA 重建）后，rendered / tx 里仍会持有旧节点。
  // 每次翻译前清一次，避免长时间运行内存只增不减。
  DT.pruneDetached = function () {
    var list = rendered.slice();
    var removed = 0;
    list.forEach(function (rec) {
      // 元素还在、译文也还在：保留。元素 / 译文节点被站点删掉，或替换型源文本
      // 已被站点改写（stillOurs 为 false）：释放记录和事务，避免旧节点长期被持有。
      if (rec.unit && rec.unit.el && rec.unit.el.isConnected && stillOurs(rec)) return;
      dropRendered(rec);
      removed += 1;
    });
    compactTx();
    return removed;
  };

  // 对外：还原原文。逆序回放 RenderTransaction：
  // 只撤销仍是我们写入的值 / 仍是我们的节点；站点已经改过 / 删除的，保留站点的新状态。
  DT.restore = function () {
    for (var i = tx.length - 1; i >= 0; i -= 1) {
      if (!tx[i].done) undoOps([tx[i]]);
    }
    tx = [];
    renderStyles = null;
    rendered = [];
    renderedByEl = new WeakMap();
    renderedByIndex = new WeakMap();
    renderedBySig = new WeakMap();
    savedRecord = new WeakMap();
    targetRegistry = new Map();
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
