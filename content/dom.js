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
  var renderFrames = 0;
  var compactPending = false;
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
      return (
        node.hasAttribute('data-dt-target') ||
        node.hasAttribute('data-dt-ui') ||
        node.hasAttribute('data-dt-dir') ||
        node.hasAttribute('data-dt-font') ||
        node.hasAttribute('data-dt-format') ||
        node.hasAttribute('data-dt-shadow-style')
      );
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
  // 一轮 collect 内已经走过的节点。Shadow DOM 的 slot 分发 / 多层 root 可能把
  // 同一个 light DOM 节点送到两条路径，靠它保证不重复收集、不重复送翻。
  var walkSeen = null;
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
          fontFamily: cs.fontFamily,
          verticalAlign: cs.verticalAlign,
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
    if (el.hasAttribute('data-dt-dir') || el.hasAttribute('data-dt-format')) return true;
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
          if (kid.nodeValue && !(ownNodes.has(kid) && DT.isOwnWrite(kid))) out.push({ node: kid, keep: keep });
        } else if (kid.nodeType === 1) {
          if (kid.hasAttribute('data-dt-target')) continue;
          if (kid.hasAttribute('data-dt-ui') || kid.hasAttribute('data-dt-dir') || kid.hasAttribute('data-dt-format')) continue;
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
  // 只取 ownText 读过的那些 —— 直接文本、<br>、行内代码、看得见的行内保留子元素（keptChild）。
  // 保留子元素的文字拼进句子当上下文，由 attachKeep 认成保留区，原地替换时不动它；
  // 已经翻过的子元素没送去翻译，原地替换时也不能动它们
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
        } else if (INLINE_CODE_TAGS[tagOf(kid)] || keptChild(el, kid)) {
          out = out.concat(tokensOf(kid));
        }
      }
    }
    return out;
  }

  // ---------------- 保留区：段落里的 notranslate ----------------
  // 整段单元（tokensOf）会把 notranslate / translate="no" / 站点规则排除的行内子元素一起拼进句子。
  // 这些文字照样送翻当上下文（units.keepWrap 用 <k1>…</k1> 包住，提示词要求原样照抄），
  // 但它们的文本节点永远不写、不清空：仅译文时按标记把译文切开，分别写进保留元素前后的文本节点；
  // 切不开（模型漏了标记 / 换了顺序 / 那一侧没有文本节点）就整句写进其它节点、把保留元素隐藏（进事务，还原时恢复）。
  // 判定与 isSkipped 里的三条相同：那里决定「不单独收集」，这里决定「在别人的句子里不能动」。
  var KEEP_SELECTOR = '.notranslate,.no-translate,[translate="no"]';
  function isProtectedEl(el) {
    if (el.getAttribute('translate') === 'no') return true;
    if (siteExclude && el.matches(siteExclude)) return true;
    var cls = el.className;
    return typeof cls === 'string' && /(^|\s)(notranslate|no-translate)(\s|$)/.test(cls);
  }

  // ---------------- 文献引用：上标里指向参考文献的链接 ----------------
  // Nature / Springer：<sup><a data-test="citation-ref" href="…#ref-CR1">1</a>,<a …>2</a></sup>（每个编号一个链接，
  // 逗号是上标里的文本节点，完整书目只在 title 属性里）。以前它们和正文一起拼进句子：「…diseases1,2.」原样送翻，
  // 仅译文把译文整句写进第一个文本节点、清空链接里的数字，上标和跳转都没了；双语译文里只剩普通数字。
  // 现在把它当保留区：编号随句子送翻、标记原样回来，页面上的上标链接本身永远不写；双语译文里放它的副本。
  // 只认「<sup> + 可见文字只有编号和分隔符 + 编号都在链接里 + 每个链接都指向文献锚点」：
  // 数学指数 x<sup>2</sup>、10<sup>−6</sup>、化学式 H<sub>2</sub>O、序数 1<sup>st</sup>、普通链接都不满足
  // 阿拉伯语维基用 [ا] / [ب] 这类字母作为脚注标记；数字仍用 ASCII / 阿拉伯-印度数字。
  var CITE_TEXT = /^[\s[(]*[0-9\u0660-\u0669\u06f0-\u06f9]{1,4}(?:\s*[,，;；/–—−-]\s*[0-9\u0660-\u0669\u06f0-\u06f9]{1,4})*[\s\])]*$/;
  // 链接自己说明是引用：DPUB-ARIA 角色，或 data-test / data-track-action / aria-label / class 里的字样。
  // 用词边界避免 preference 里的 reference 误命中；reference anchor / citation-ref 这类带连字符的照样命中。
  var CITE_HINT = /(?:^|[\s_-])(citations?|references?|footnotes?|biblio(?:graphy|ref)?|noteref|cite|xref|fn-?ref)(?:[\s_-]|$)/i;
  var citeMemo = null; // 一次 collect 内缓存（同一个上标里每个文本节点都会问一遍）

  // 用户名提及：链接文字本身就是 @handle。它不是正文里可翻译的普通链接，
  // 而是实体身份；当保留区处理，避免译文把整个 @user 链接范围吞掉。
  function isMentionEl(el) {
    if (!el || el.nodeType !== 1 || tagOf(el) !== 'A') return false;
    var href = el.getAttribute('href') || '';
    if (!href || /^(mailto|tel|javascript):/i.test(href)) return false;
    var text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    return /^@[^\s@]{1,64}$/.test(text);
  }

  // 弱证据链接（没有 role / citation 字样）要确认目标真的像参考文献，而不是章节 / 图表 / 普通页面锚点。
  function looksLikeReferenceTarget(target) {
    if (!target || target.nodeType !== 1) return false;
    var role = String(target.getAttribute('role') || '').toLowerCase();
    if (role === 'doc-biblioentry' || role === 'doc-endnote' || role === 'doc-footnote') return true;
    var id = String(target.id || '');
    var parent = target.parentElement;
    // 有些出版社的参考文献项只有 `<li id="B1">`，没有 role / class；用「列表项 + 年份」弱证据补上，普通目录项不误判。
    if (tagOf(target) === 'LI' && parent && /^(OL|UL)$/.test(parent.tagName) && /(?:19|20)\d{2}/.test(target.textContent || '')) return true;
    if (/(^|[-_])(ref|bib|cite|note|fn|reference|biblio)(\d|[-_]|$)/i.test(id)) return true;
    if (/^core-r\d/i.test(id)) return true;
    var cls = typeof target.className === 'string' ? target.className : '';
    if (CITE_HINT.test(cls)) return true;
    if (parent) {
      var pc = typeof parent.className === 'string' ? parent.className : '';
      if (CITE_HINT.test(pc)) return true;
    }
    return false;
  }

  function citeLink(a, sup) {
    var href = a.getAttribute('href') || '';
    var hash = href.indexOf('#');
    if (hash < 0 || hash === href.length - 1) return false;
    var role = String(a.getAttribute('role') || '').toLowerCase();
    if (role === 'doc-biblioref' || role === 'doc-noteref') return true;
    var said = [
      a.getAttribute('data-test'),
      a.getAttribute('data-track-action'),
      a.getAttribute('aria-label'),
      typeof a.className === 'string' ? a.className : '',
      typeof sup.className === 'string' ? sup.className : ''
    ].join(' ');
    if (CITE_HINT.test(said)) return true;
    // 没有字样：必须指向本页（同一路径）里真实存在的锚点（Wikipedia 的 #cite_note-3、Markdown 脚注的 #fn1）
    if (hash > 0) {
      var url = null;
      try {
        url = new URL(href, document.baseURI);
      } catch (err) {
        return false;
      }
      if (url.origin !== location.origin || url.pathname !== location.pathname) return false;
    }
    var id = href.slice(hash + 1);
    try {
      id = decodeURIComponent(id);
    } catch (err) {
      /* 不是合法的转义：按原样找 */
    }
    return looksLikeReferenceTarget(document.getElementById(id));
  }

  var CITE_TAGS = { SUP: 1, SUB: 1, A: 1, SPAN: 1, CITE: 1, SMALL: 1, B: 1, I: 1, EM: 1, STRONG: 1 };

  // 出版社可能在编号后加 display:none / hidden 的辅助标签。它们不是可见编号，
  // 但必须连同原始包装原样保留；只在原始 textContent 不像编号时补做这一遍。
  function visibleCitationNodes(el) {
    var out = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (node.nodeType === 3) return NodeFilter.FILTER_ACCEPT;
        var style = getComputedStyle(node);
        return node.hidden || style.display === 'none' || style.visibility === 'hidden' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
    });
    for (var node = walker.nextNode(); node; node = walker.nextNode()) out.push(node);
    return out;
  }

  // 文献引用不再是「必须是 sup」：Science 用 <a role="doc-biblioref"><i>1</i></a> 直接夹在正文里，
  // 其他出版社用 span / cite / 单链接。判据是组合证据：
  //   数字编号格式 + 链接指向文献目标（或 role / 明确的 citation 字样）+ 数字都在链接里。
  // 单个普通链接、数学 sup、图表锚点、站外链接不满足；没有链接的 sup / citation span 必须同时有强提示。
  function isCitationEl(el) {
    if (!el || el.nodeType !== 1 || !CITE_TAGS[tagOf(el)]) return false;
    if (citeMemo && citeMemo.has(el)) return citeMemo.get(el);
    var text = String(el.textContent || '');
    var tag = tagOf(el);
    var yes = false;
    var visible = null;
    var visibleSet = null;
    var said = [
      el.getAttribute('role'),
      el.getAttribute('aria-label'),
      el.getAttribute('data-test'),
      typeof el.className === 'string' ? el.className : ''
    ].join(' ');
    if (!CITE_TEXT.test(text) && (tag === 'A' || el.getElementsByTagName('a').length)) {
      visible = visibleCitationNodes(el);
      visibleSet = new Set(visible);
      text = visible.map(function (node) { return node.nodeValue; }).join('');
    }
    var hinted = CITE_HINT.test(said);
    // 非数字脚注只接受真正的上标 / cite 容器：短字母编号 [ا] / [ب]，
    // 或带内部链接的 citation-needed 上标；[الإنجليزية] 这类无链接语言标注不算。
    var shortMarker = /^[\s\[(]*[\u0621-\u064a]{1,2}[\s\])]*$/.test(text);
    var hasInnerLink = el.getElementsByTagName('a').length > 0;
    var allowHint = hinted && (tag === 'SUP' || tag === 'CITE') && (shortMarker || hasInnerLink);
    if (CITE_TEXT.test(text) || allowHint) {
      if (tag === 'A') {
        yes = citeLink(el, el);
      } else {
        var links = el.getElementsByTagName('a');
        if (links.length) {
          yes = true;
          // 编号都在链接里：上标里夹着链接之外的数字（「see 3」）不算
          var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (var t = walker.nextNode(); t && yes; t = walker.nextNode()) {
            if (visibleSet && !visibleSet.has(t)) continue;
            if (/\d/.test(t.nodeValue) && !(t.parentNode && t.parentNode.closest && t.parentNode.closest('a'))) yes = false;
          }
          // 强 citation 字样 + 内部链接：有些模板链接到维基项目页 / 外部说明页，
          // 不是文章内锚点，但它仍然是脚注原子，不能当普通链接而让整段不安全。
          for (var i = 0; yes && i < links.length; i += 1) {
            if (!citeLink(links[i], el) && !hinted) yes = false;
          }
        } else {
          // 没有可点的链接时只接受强提示 + 上标 / citation 容器，避免把 <span>2</span> 当引用
          yes = (tag === 'SUP' || tag === 'CITE' || tag === 'SPAN') && CITE_HINT.test(said);
        }
      }
    }
    if (citeMemo) citeMemo.set(el, yes);
    return yes;
  }

  // ---------------- 图表 / 表格 / 公式的交叉引用链接 ----------------
  // Science：(<a href="#F1" data-xml-rid="F1">Fig. 1</a>)。它是正文里的结构，不是可翻译的普通链接：
  // 以前它被当成「普通行内链接」，和文献引用混在一段里时整段引用重建被拒（hasUnsafeInlineLink），段落一直是英文；
  // 只有它没有引用时仅译文又退回双语。现在当保留区：链接节点原样保留、可点击，可见标签在有可靠对应时写成「图 1」。
  // 只认「指向本页锚点 + 可见文字是图表标签」：Fig. 1 / Figs. 2 and 3 / Table S1 / Eq. 4 / Movie S2 / Supplementary Fig. 3。
  // 裸数字（See figure <a>2</a>）、站外链接、普通文字链接都不算
  var XREF_HEAD = /^(?:(?:supplementary|suppl\.?|extended\s+data)\s+)?(?:fig(?:ure)?s?\.?|tables?|tab\.?|eqs?\.?|equations?|movies?|videos?|schemes?|box(?:es)?|data\s+file|notes?)\s*\(?[A-Z]?S?\d+[A-Za-z]?\)?/i;
  var XREF_TAIL = /^(?:[\s,–—\-&;()]|and|to|[A-Z](?![a-z])|S?\d+[A-Za-z]?)*$/;

  function isXrefEl(el) {
    if (!el || el.nodeType !== 1 || tagOf(el) !== 'A') return false;
    var href = el.getAttribute('href') || '';
    var hash = href.indexOf('#');
    if (hash < 0 || hash === href.length - 1) return false;
    var text = DT.normalizeText(el.textContent || '');
    if (!text || text.length > 48) return false;
    var head = XREF_HEAD.exec(text);
    if (!head || !XREF_TAIL.test(text.slice(head[0].length))) return false;
    if (isCitationEl(el)) return false;
    if (hash > 0) {
      var url = null;
      try {
        url = new URL(href, document.baseURI);
      } catch (err) {
        return false;
      }
      if (url.origin !== location.origin || url.pathname !== location.pathname) return false;
    }
    return true;
  }

  // 图表标签的可靠对应（只对中文目标、只对「标签 + 单个编号」）：Fig. 1 → 图 1、Table S2 → 表 S2、Eq. 3 → 式 3。
  // 「Fig. 1, A and B」这类带分图说明的、日文等其他目标都原样保留
  var XREF_ZH = [
    [/^fig(?:ure)?s?\.?$/i, '图', '圖'],
    [/^(?:tables?|tab\.?)$/i, '表', '表'],
    [/^(?:eqs?\.?|equations?)$/i, '式', '式']
  ];
  function xrefLabel(text, target) {
    var t = String(target || '');
    if (t.indexOf('zh') !== 0) return '';
    var m = /^(.*?)\s*(S?\d+[A-Za-z]?)$/.exec(DT.normalizeText(text || ''));
    if (!m) return '';
    var hant = /^zh-(tw|hk|mo|hant)/i.test(t);
    for (var i = 0; i < XREF_ZH.length; i += 1) {
      if (XREF_ZH[i][0].test(m[1])) return (hant ? XREF_ZH[i][2] : XREF_ZH[i][1]) + ' ' + m[2];
    }
    return '';
  }

  // 混合段落里的普通链接：段落里已经有文献引用 / 图表链接时，普通链接也当原子保留（文字原样、仍可点击），
  // 译文写在它外面 —— 中文正文不会落进 <a>、也不会让链接扩到整句
  function isPlainLinkEl(el) {
    if (!el || el.nodeType !== 1 || tagOf(el) !== 'A' || !el.hasAttribute('href')) return false;
    var text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    // 上标 / 下标里的链接通常是引注、脚注或数学标记；本地锚点的 [8] / 8 也当原子，
    // 但站外数字链接仍交给 citation 反例路径，不当普通正文链接。
    var href = el.getAttribute('href') || '';
    var numeric = /^[\[［(（]?\s*\d{1,4}\s*[\]］)）]?$/.test(text);
    if (numeric) {
      // 普通 "See section 1" 的数字锚点不是引用；只有方括号编号、上标、或指向参考文献目标才当原子。
      if (el.closest && el.closest('sup,sub')) {
        if (href.charAt(0) !== '#') return false;
        return true;
      }
      if (/[\[［(（]/.test(text)) return true;
      var target = null;
      try {
        target = href.charAt(0) === '#' ? document.getElementById(href.slice(1)) : null;
      } catch (err) {
        target = null;
      }
      return !!(looksLikeReferenceTarget(target) || /(ref|bib|cite|fn|note|reference)/i.test(href));
    }
    if (el.closest && el.closest('sup,sub')) return false;
    // 链接里嵌 notranslate 时由 notranslate 保护，不能再把整条链接当普通原子。
    if (el.querySelector && el.querySelector(KEEP_SELECTOR)) return false;
    return true;
  }

  // node 在 root 里所属的最外层保留元素（root 自己不算：它被保护的话根本不会收集）。
  // 文献引用 / 图表链接也是保留区：编号和链接不翻、页面上的节点不写。withLinks：混合段落，普通链接也算
  function keepElOf(node, root, withLinks, withRuby) {
    var found = null;
    for (var cur = node.parentNode; cur && cur !== root && cur.nodeType === 1; cur = cur.parentNode) {
      if (isProtectedEl(cur) || isCitationEl(cur) || isMentionEl(cur) || isXrefEl(cur) || (withLinks && isPlainLinkEl(cur)) || (withRuby && tagOf(cur) === 'RUBY')) {
        found = cur;
      } else if (isControlTextEl(cur) && !found) {
        // 控件标签本身也是原子；但 label/summary 里已有引用 / notranslate 时，
        // 内层更具体的保留区优先，不能把引用编号吞进控件原子。
        found = cur;
      }
    }
    return found;
  }

  // 控件文字单独成原子：按钮 / label / summary 的可见标签不能被段落译文清空。
  // <a> 仍走链接逻辑，避免把普通链接当控件重复保护。
  function isControlTextEl(el) {
    var tag = tagOf(el);
    return tag === 'BUTTON' || tag === 'LABEL' || tag === 'SUMMARY';
  }

  // 保留区的种类：protect（notranslate）/ cite / mention / xref（图表链接）/ link（混合段落里的普通链接）/ control（控件标签）
  function keepKind(el) {
    if (isProtectedEl(el)) return 'protect';
    if (isCitationEl(el)) return 'cite';
    if (isMentionEl(el)) return 'mention';
    if (isXrefEl(el)) return 'xref';
    if (isControlTextEl(el)) return 'control';
    if (tagOf(el) === 'RUBY') return 'ruby';
    return 'link';
  }

  // 结构性原子：引用 / 图表链接 / 混合段落里的普通链接。带这些的单元走混合行内渲染（injectCited）
  function isStructKeep(k) {
    return !!k && (k.kind === 'cite' || k.kind === 'xref' || k.kind === 'link');
  }

  function isRubyKeep(k) {
    return !!k && k.kind === 'ruby';
  }

  function hasCitationInside(el) {
    if (!el.querySelectorAll) return false;
    var nodes = el.querySelectorAll('sup,a,[role="doc-biblioref"],[role="doc-noteref"],.citation,.reference');
    for (var i = 0; i < nodes.length; i += 1) {
      if (isCitationEl(nodes[i])) return true;
    }
    return false;
  }

  function hasMentionInside(el) {
    if (!el.querySelectorAll) return false;
    var links = el.querySelectorAll('a');
    for (var i = 0; i < links.length; i += 1) {
      if (isMentionEl(links[i])) return true;
    }
    return false;
  }

  function hasXrefInside(el) {
    if (!el.querySelectorAll) return false;
    var links = el.querySelectorAll('a[href*="#"]');
    for (var i = 0; i < links.length; i += 1) {
      if (isXrefEl(links[i])) return true;
    }
    return false;
  }

  // 普通正文里「文字 + 行内链接」的混合段落：链接也当原子保护。
  // 整段就是一个链接（导航 / 按钮 / 纯链接卡片）不在这里处理；控件 / 导航交给 areaOf。
  function hasMixedPlainLinkInside(el) {
    if (!el || !el.querySelectorAll || !el.querySelector('a[href]')) return false;
    if (DT.areaOf(el) !== 'content') return false;
    // 有块级子元素的容器走 flowTokens / 分段收集，不能把里面的链接提前当整段原子。
    if (el.querySelector(BLOCK_SELECTOR)) return false;
    var links = el.querySelectorAll('a[href]');
    var got = false;
    var i;
    for (i = 0; i < links.length; i += 1) {
      var a = links[i];
      if (!isPlainLinkEl(a)) continue;
      if (isProtectedEl(a) || isCitationEl(a) || isXrefEl(a) || isMentionEl(a)) continue;
      got = true;
      break;
    }
    if (!got) return false;
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (var t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!/\S/.test(t.nodeValue || '')) continue;
      var parent = t.parentElement;
      if (!(parent && parent.closest && parent.closest('a'))) return true;
    }
    return false;
  }

  function hasRubyInside(el) {
    return !!(el.querySelector && el.querySelector('ruby'));
  }

  function hasControlInside(el) {
    if (!el || !el.querySelector) return false;
    return !!el.querySelector('button,label,summary');
  }

  function hasKeepInside(el) {
    // 普通链接混合段落要先于 notranslate / mention / cite 判断，避免同一段还有别的保留区时漏掉普通链接。
    if (hasMixedPlainLinkInside(el)) return 'links';
    if (hasControlInside(el)) return 'controls';
    if (el.querySelector && el.querySelector(siteExclude ? KEEP_SELECTOR + ',' + siteExclude : KEEP_SELECTOR)) return true;
    return hasMentionInside(el) || hasCitationInside(el) || hasXrefInside(el);
  }

  // 有文献引用 / 图表链接 / 混合段落普通链接：走混合行内渲染（injectCited），不走 keepPlan
  function hasStructAtom(unit) {
    return (unit.keep || []).some(isStructKeep);
  }

  // 译文整体写回第一个文本节点时，如果第一个节点在普通 <a> 里，整段译文会继承链接。
  // 这里只在真正有风险时返回 true：有可翻译的普通链接，且不是「整段就是一个链接」；
  // 用户名提及 / 文献引用已经在 unit.keep 里，会被跳过。
  function hasUnsafeInlineLink(unit) {
    var nodes = contentNodes(unit);
    var links = new Set();
    var generic = new Set();
    var nonLink = false;
    var ancestor = false;
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var a = node.parentElement && node.parentElement.closest ? node.parentElement.closest('a') : null;
      if (!a) {
        nonLink = true;
        continue;
      }
      links.add(a);
      if (keepIndexOf(unit, a) >= 0) continue; // 提及 / 引用 / notranslate 链接不在这里处理
      if (a !== unit.el && a.contains(unit.el)) {
        ancestor = true;
        continue;
      }
      generic.add(a);
    }
    if (!generic.size) return false;
    if (ancestor) return true;
    if (nonLink) return true;
    return links.size > 1;
  }

  // own 单元 / 局部段落（ownTokens / flowTokens）里，只因「保留」才被 isSkipped 跳过的直接子元素：
  // 「Install <span class="notranslate">Rimefox</span> today.」以前只送「Install today.」，仅译文时整句写在 span 前面。
  // 看得见的行内保留元素照样拼进句子（attachKeep 把它认成保留区）；因为别的原因跳过的不算 ——
  // 已翻过、译文 / 界面节点、跳过类标签（PRE / IMG…）、可编辑、隐藏、块级或打断文字流的
  function keptChild(parent, kid) {
    if (!isProtectedEl(kid)) return false;
    if (SKIP_TAGS[tagOf(kid)]) return false;
    if (kid.hasAttribute('data-dt-src') || kid.hasAttribute('data-dt-target') || kid.hasAttribute('data-dt-ui')) return false;
    if (kid.getAttribute('contenteditable') === '' || kid.getAttribute('contenteditable') === 'true') return false;
    if (kid.isContentEditable || kid.hidden) return false;
    var cs = styleOf(kid);
    if (cs && cs.display === 'none') return false;
    return !breaksFlow(parent, kid);
  }

  // 段落文本里属于保留元素的字符范围：[{ start, end, text, el, kind, cite }]，按出现顺序；换行处断开。
  // 第一遍不含普通链接；段落里出现了文献引用 / 图表链接（混合段落），再按「普通链接也算」收一遍
  function keepRangesOf(el, chars, text, links) {
    var out = keepScan(el, chars, text, false, false);
    var withLinks = !!links || out.some(function (k) { return k.kind === 'cite' || k.kind === 'xref'; });
    var withRuby = withLinks && hasRubyInside(el);
    if (withLinks) out = keepScan(el, chars, text, true, withRuby);
    return out;
  }

  function keepScan(el, chars, text, withLinks, withRuby) {
    var out = [];
    var cur = null;
    var owner = new Map();
    for (var i = 0; i < chars.length; i += 1) {
      var c = chars[i];
      if (!c) continue; // 合成空格：不打断，也不单独开头
      if (!c.node) {
        cur = null; // 换行
        continue;
      }
      if (!owner.has(c.node)) owner.set(c.node, keepElOf(c.node, el, withLinks, withRuby));
      var keepEl = owner.get(c.node);
      if (!keepEl) {
        cur = null;
      } else if (cur && cur.el === keepEl) {
        cur.end = i + 1;
      } else {
        cur = { start: i, end: i + 1, el: keepEl };
        out.push(cur);
      }
    }
    out.forEach(function (k) {
      k.text = text.slice(k.start, k.end);
      k.kind = keepKind(k.el);
      k.cite = k.kind === 'cite';
    });
    return out;
  }

  function keepIndexOf(unit, node) {
    var keep = unit.keep || [];
    for (var i = 0; i < keep.length; i += 1) {
      if (keep[i].el.contains(node)) return i;
    }
    return -1;
  }

  // 给单元挂上保留区；整段只剩保留内容（没有可翻的字）返回 false。
  // inside：hasKeepInside(el) 的结果，同一容器的各段共用（每段都 querySelector 一遍，长容器会变成 O(n²)）
  function attachKeep(unit, el, inside) {
    unit.keep = inside ? keepRangesOf(el, unit.map.chars, unit.text, inside === 'links') : [];
    if (!unit.keep.length) {
      attachInline(unit);
      return true;
    }
    var rest = '';
    var at = 0;
    unit.keep.forEach(function (k) {
      rest += unit.text.slice(at, k.start);
      at = k.end;
    });
    if (!/\S/.test(rest + unit.text.slice(at))) return false;
    unit.wire = DT.units.keepWrap(unit.text, unit.keep);
    attachInline(unit);
    return true;
  }

  // 只复制有限的语义差异。原网页属性、类名、字体族和 HTML 不进入模型或新格式壳。
  var FORMAT_TAGS = { STRONG: 1, B: 1, EM: 1, I: 1, SPAN: 1, SMALL: 1, SUP: 1, SUB: 1, CODE: 1 };
  function formatStyle(el) {
    var tag = tagOf(el);
    if (!FORMAT_TAGS[tag]) return null;
    var parent = el.parentElement;
    var cs = styleOf(el);
    var base = parent && styleOf(parent);
    if (!cs || !base) return null;
    var out = {};
    if (cs.fontWeight !== base.fontWeight) out.weight = cs.fontWeight;
    if (cs.fontStyle !== base.fontStyle) out.fontStyle = cs.fontStyle;
    var size = parseFloat(cs.fontSize);
    var baseSize = parseFloat(base.fontSize);
    var ratio = baseSize > 0 ? size / baseSize : 1;
    if (ratio >= 0.5 && ratio <= 1.5 && Math.abs(ratio - 1) > 0.01) out.size = String(ratio) + 'em';
    if (cs.verticalAlign !== base.verticalAlign && /^(super|sub)$/.test(cs.verticalAlign)) out.vertical = cs.verticalAlign;
    if (tag === 'SMALL' && !out.size) out.size = '0.833333em';
    if (tag === 'SUP' || tag === 'SUB') {
      out.size = '0.833333em';
      out.vertical = tag === 'SUP' ? 'super' : 'sub';
    }
    if (tag === 'CODE') out.code = true;
    // 某些局部加粗仅由专有字体名表达；传递语义，不传递不兼容字体。
    if (!out.weight && cs.fontFamily !== base.fontFamily && /bold|black|heavy|semibold|demi/i.test(cs.fontFamily)) out.weight = '700';
    return Object.keys(out).length ? out : null;
  }

  function attachInline(unit) {
    if (/[<＜]\s*\/?\s*[kf]\s*\d/i.test(unit.text)) {
      unit.formats = [];
      if ((unit.keep || []).some(function (k) { return k.kind === 'protect'; })) {
        // A literal source marker cannot safely share the reserved namespace. Never
        // fall back to the old wire, which would expose protected text to the API.
        unit.inlineIssue = 'reserved-marker-source';
        unit.wire = '';
      } else unit.formatMode = 'source-marker-opt-out';
      return;
    }
    var formats = [];
    var candidates = new Map();
    var keep = unit.keep || [];
    var nodeMemo = new Map();
    var chars = unit.map.chars || [];
    chars.forEach(function (c, index) {
      if (!c || !c.node) return;
      if (!nodeMemo.has(c.node)) {
        var list = [];
        for (var p = c.node.parentElement; p && p !== unit.el; p = p.parentElement) {
          if (keepIndexOf(unit, p) >= 0 || (p.closest && p.closest('ruby,rt,rp'))) continue;
          if (FORMAT_TAGS[tagOf(p)] && !isDropcapNode(c.node)) list.push(p);
        }
        nodeMemo.set(c.node, list);
      }
      nodeMemo.get(c.node).forEach(function (el) {
        var range = candidates.get(el);
        if (!range) { range = { start: index, end: index + 1, el: el }; candidates.set(el, range); }
        else range.end = index + 1;
      });
    });
    candidates.forEach(function (range) {
      if (range.start === 0 && range.end === unit.text.length) return;
      if (range.end - range.start > 600 || unit.text.slice(range.start, range.end).indexOf('\n') >= 0) return;
      // 一个格式壳若包含不可改原子，保留原子机制优先，不能把错误范围贴到原子上。
      if (keep.some(function (k) { return k.start < range.end && k.end > range.start; })) return;
      var style = formatStyle(range.el);
      if (!style) return;
      range.kind = 'format';
      range.tag = tagOf(range.el).toLowerCase();
      range.style = style;
      range.parent = range.el.parentNode;
      range.next = sourceSibling(range.el, 'nextSibling');
      range.semantic = JSON.stringify(style);
      range.stamp = range.el.getAttribute('style') + '|' + range.el.getAttribute('class');
      formats.push(range);
    });
    keep.forEach(function (k, index) {
      // 普通链接可能用 <span>/<sup> 包住标签（维基的 [الإنجليزية] 等），
      // 不能因为不是单个文本节点就放弃翻译；格式范围覆盖整个可见标签。
      if (k.kind !== 'link' || !k.text || k.text.indexOf('\n') >= 0 || k.text.length > 600 || isProtectedEl(k.el)) return;
      formats.push({ start: k.start, end: k.end, el: k.el, kind: 'link', tag: 'a', style: {}, linkIndex: index,
        parent: k.el.parentNode, next: sourceSibling(k.el, 'nextSibling'), stamp: k.el.getAttribute('style') + '|' + k.el.getAttribute('class') });
    });
    formats.sort(function (a, b) {
      if (a.start !== b.start) return a.start - b.start;
      if (a.end !== b.end) return b.end - a.end;
      if (a.el.contains(b.el)) return -1;
      if (b.el.contains(a.el)) return 1;
      return 0;
    });
    if (formats.length > 120) formats = [];
    formats.forEach(function (f, i) { f.id = i + 1; });
    unit.formats = formats;
    if (formats.length || keep.some(function (k) { return k.kind === 'protect'; })) {
      var topology = new Set();
      unit.inlineSourceTopology = [];
      chars.forEach(function (c) {
        if (!c || !c.node || topology.has(c.node)) return;
        topology.add(c.node);
        unit.inlineSourceTopology.push({ node: c.node, parent: c.node.parentNode,
          next: sourceSibling(c.node, 'nextSibling'), previous: sourceSibling(c.node, 'previousSibling') });
      });
      unit.inlineProtocol = 'v1';
      unit.wire = DT.units.inlineWrap(unit.text, keep, formats);
    }
  }

  function inlineProtocol() {
    return typeof globalThis !== 'undefined' && globalThis.__RimefoxInline;
  }

  function inspectInline(unit, raw) {
    var protocol = inlineProtocol();
    if (!protocol || !protocol.inspect) return { ok: false, reason: 'protocol-unavailable' };
    return protocol.inspect(unit.wire, String(raw || ''));
  }

  function inlineLabel(unit, result, index) {
    var original = unit.keep[index];
    var format = (unit.formats || []).filter(function (f) { return f.linkIndex === index; })[0];
    if (!format || result.formatMissing) return original.text;
    // 普通链接标签在 <fN> 里，译文在 result.stripped 的对应范围；atom.text 仍是原文，
    // 不能拿它当标签，否则双语副本永远保留阿拉伯语 / 英文原文。
    var range = (result.ranges || []).filter(function (f) { return f.id === format.id; })[0];
    if (range) {
      var label = result.stripped.slice(range.start, range.end).trim();
      if (label) return label;
    }
    var atom = result.atoms.filter(function (a) { return a.id === index + 1; })[0];
    return atom ? atom.text : original.text;
  }

  // 把原子（链接 / 图表）的可见标签写进它自己的 DOM，不改变链接节点身份。
  // 维基的 [الإنجليزية] 会嵌套 <sup>，所以不能只处理“唯一文本节点”。
  function writeVisibleLabel(el, label, ops, saved) {
    var texts = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (var t = walker.nextNode(); t; t = walker.nextNode()) {
      if (/\S/.test(t.nodeValue)) texts.push(t);
    }
    if (!texts.length) return false;
    var first = texts[0];
    var before = first.nodeValue;
    var wrote = /^\s*/.exec(before)[0] + label + /\s*$/.exec(before)[0];
    if (ops) {
      setText(first, wrote, ops);
      saved.push({ node: first, value: before, wrote: wrote });
      for (var i = 1; i < texts.length; i += 1) {
        var extra = texts[i];
        var old = extra.nodeValue;
        setText(extra, '', ops);
        saved.push({ node: extra, value: old, wrote: '' });
      }
    } else {
      first.nodeValue = wrote;
      for (var j = 1; j < texts.length; j += 1) texts[j].nodeValue = '';
    }
    return true;
  }

  // 主调度、对齐和去重使用页面最终会显示的文字；保护区在本地恢复，不来自模型。
  DT.inlineText = function (unit, raw) {
    if (!unit || unit.inlineProtocol !== 'v1') return raw;
    var result = inspectInline(unit, raw);
    if (!result.ok) return '';
    var out = '';
    var pos = 0;
    result.atoms.forEach(function (atom) {
      out += result.stripped.slice(pos, atom.at);
      var index = atom.id - 1;
      var k = unit.keep[index];
      if (k) out += k.kind === 'link' ? inlineLabel(unit, result, index) : k.text;
      pos = atom.at;
    });
    return out + result.stripped.slice(pos);
  };

  function inlineMetadataChanged(unit) {
    if ((unit.inlineSourceTopology || []).some(function (snap) {
      return snap.node.parentNode !== snap.parent || sourceSibling(snap.node, 'nextSibling') !== snap.next ||
        sourceSibling(snap.node, 'previousSibling') !== snap.previous;
    })) return true;
    return (unit.formats || []).some(function (f) {
      return !f.el.isConnected || f.el.parentNode !== f.parent || sourceSibling(f.el, 'nextSibling') !== f.next || !unit.el.contains(f.el) ||
        (f.kind !== 'link' && f.semantic !== JSON.stringify(formatStyle(f.el))) ||
        f.stamp !== f.el.getAttribute('style') + '|' + f.el.getAttribute('class');
    });
  }

  // 藏起来会让页面少东西的保留元素：图标、图片、链接、按钮。兜底时宁可留着（文字重复一次）
  var KEEP_SOLID =
    'a[href],button,input,select,textarea,img,svg,picture,video,audio,canvas,iframe,object,embed,[role="button"],[role="link"]';

  // 隐藏保留元素（兜底：它的原文已经随整句译文写进别的节点）。except：这些不隐藏。
  // 写完再量一次：页面更强的规则（动画、用户样式）还是让它显示着，就撤回这一条、不打「已隐藏」标记
  // （悬停映射信这个标记，标错了会把看得见的字从对照里拿掉）
  function hideKept(unit, ops, except) {
    var seen = new Set();
    (unit.keep || []).forEach(function (k) {
      if (seen.has(k.el) || (except && except.has(k.el))) return;
      seen.add(k.el);
      // 控件标签不能隐藏：keepPlan 失败时译文写在控件外，按钮仍要保留可读标签 / 事件。
      if (k.kind === 'control' || isControlTextEl(k.el)) return;
      if (k.el.matches(KEEP_SOLID) || k.el.querySelector(KEEP_SOLID)) return;
      var op = setStyle(k.el, 'display', 'none', ops);
      var cs = null;
      try {
        cs = getComputedStyle(k.el);
      } catch (err) {
        cs = null;
      }
      if (cs && cs.display !== 'none') {
        if (op) undoOps([op]);
        return;
      }
      setAttr(k.el, 'data-dt-keep-hidden', '1', ops);
    });
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
  // 行内代码、看得见的行内保留子元素照样拼进句子（与 ownTokens 一致）；
  // 已翻译 / 隐藏 / 非正文的子元素只留一个分隔空格，免得把子级已翻过的内容再翻一遍。
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
        else parts.push(INLINE_CODE_TAGS[tagOf(kid)] || keptChild(el, kid) ? textOf(kid) : ' ');
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

  // 行内语义的标签：flex / grid 父级会把子项「块化」（computed display 一律变成 block），
  // 正文里给 <span> 写 display:flex 也多半只是为了对齐图标。它们仍是句子的一部分：
  // 「See <a>documentation</a>.」在 flex 行里以前被拆成 "See" / "." / "documentation" 三段
  var PHRASING_TAGS = {
    A: 1, ABBR: 1, B: 1, BDI: 1, BDO: 1, BIG: 1, CITE: 1, DATA: 1, DEL: 1, DFN: 1, EM: 1, FONT: 1,
    I: 1, INS: 1, LABEL: 1, MARK: 1, NOBR: 1, Q: 1, S: 1, SMALL: 1, SPAN: 1, STRIKE: 1, STRONG: 1,
    SUB: 1, SUP: 1, TIME: 1, TT: 1, U: 1
  };
  var BLOCK_SELECTOR = Object.keys(BLOCK_TAGS).join(',').toLowerCase();

  // 打断父级行内文字流的子元素：可见的块级 / 弹性布局盒子；非正文块里，带交互控件的子元素也算。
  // 行内语义标签（链接、span、强调）就算算出来是块级，也只有里面套着真正的块级元素时才算打断。
  // 已翻过（data-dt-src）/ notranslate 的块级子元素照样算：它们不属于父级这一段，不能被拼进来再翻一遍。
  // 图片、视频这类跳过的标签不算（不影响父级的文字）；<pre> 算，代码块不该被拼进句子。
  function breaksFlow(parent, kid) {
    if (kid.hasAttribute('data-dt-target') || kid.hasAttribute('data-dt-ui')) return false;
    var tag = tagOf(kid);
    if (tag === 'BR' || (SKIP_TAGS[tag] && tag !== 'PRE')) return false;
    if (kid.hidden) return false;
    var cs = styleOf(kid);
    if (cs && cs.display === 'none') return false;
    if (isStructural(kid) && (!PHRASING_TAGS[tag] || kid.querySelector(BLOCK_SELECTOR))) return true;
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

  // 夹着块级子元素的容器自己那段文字：直接文本、<br>、行内代码、没被跳过的行内子元素（链接 / 强调 / ruby），
  // 以及看得见的行内保留子元素（keptChild，当保留区送翻、原地不动）。
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
      } else if (!isSkipped(kid) || keptChild(el, kid)) {
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

  // Ignore generated pieces when recording source topology. A website may add or
  // move nodes without changing the values of any previously collected Text node.
  function sourceSibling(node, side) {
    var next = node && node[side];
    while (next) {
      var generated = next.nodeType === 3 ? ownNodes.has(next) : next.nodeType === 1 &&
        (next.hasAttribute('data-dt-target') || next.hasAttribute('data-dt-format') || next.hasAttribute('data-dt-dir') || next.hasAttribute('data-dt-font'));
      if (!generated) return next;
      next = next[side];
    }
    return null;
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
  // el.__dtScope（settleForm）里的直接子元素只混入属性、不往里看
  function sourceSignature(el) {
    var h = 2166136261;
    var chars = 0;
    var brs = 0;
    var scope = el.__dtScope || null;
    function mix(code) {
      h ^= code;
      h = (h * 16777619) >>> 0;
    }
    function mixText(value) {
      for (var i = 0; i < value.length; i += 1) mix(value.charCodeAt(i));
    }
    mixText(el.getAttribute('class') || '');
    mixText(el.getAttribute('style') || '');
    mixText(el.getAttribute('dir') || '');
    mixText(el.getAttribute('aria-hidden') || '');
    mix(el.hidden ? 1 : 0);
    (function visit(node) {
      var kids = node.childNodes;
      for (var i = 0; i < kids.length; i += 1) {
        var kid = kids[i];
        if (kid.nodeType === 3) {
          if (ownNodes.has(kid) && DT.isOwnWrite(kid)) continue;
          var v = kid.nodeValue || '';
          for (var c = 0; c < v.length; c += 1) mix(v.charCodeAt(c));
          chars += v.length;
          continue;
        }
        if (kid.nodeType !== 1) continue;
        if (kid.hasAttribute('data-dt-target') || kid.hasAttribute('data-dt-ui') || kid.hasAttribute('data-dt-dir') || kid.hasAttribute('data-dt-format')) continue;
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
        if (scope && node === el && scope.has(kid)) {
          mix(30);
          continue;
        }
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

  // 元素这一轮按哪种形态成段：whole（整段 tokensOf）/ own（只翻直接文本）/ partial（局部段落 flowTokens）。
  // 形态变了（子块藏起来 / 显示出来、子元素被删）：旧双语段落的锚点和 whole 标记都对不上新结构，先撤掉再按新结构收；
  // 留着的话新单元会因为旧译文节点注入失败，每轮重收、重发同一段。替换型按文本节点身份认领，留着不闪。
  // scope：签名不往里看的子元素（局部段落的子块、own 单元跳过的子元素），它们各自 walk、各自有签名，
  // 子元素被翻译 / 改字不该让父级以为自己那段变了；只混入它们的属性（显示 / 隐藏仍能察觉）
  function settleForm(el, form, scope) {
    if (el.__dtForm && el.__dtForm !== form && hasRendered(el)) releaseRecords(el, isDual);
    el.__dtForm = form;
    el.__dtScope = scope;
  }

  // own 单元没拼进句子的子元素（ownTokens 之外的）
  function ownExcluded(el) {
    var out = new Set();
    var kids = el.children;
    for (var i = 0; i < kids.length; i += 1) {
      var tag = tagOf(kids[i]);
      if (tag !== 'BR' && !INLINE_CODE_TAGS[tag] && !keptChild(el, kids[i])) out.add(kids[i]);
    }
    return out;
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
    var keepInside = null; // 有没有 notranslate 等保留元素：懒算一次，全部段落已渲染时不查
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
      // 本段的第一个文本节点（懒翻译量位置用）：从本段开头找，不能取整个容器的第一个
      var firstNode = null;
      for (var ci = range.start; ci < range.end; ci += 1) {
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
      if (keepInside === null) keepInside = hasKeepInside(el);
      if (!attachKeep(unit, el, keepInside)) return; // 这段只有 notranslate 的内容
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
    if (walkSeen) {
      if (walkSeen.has(el)) return;
      walkSeen.add(el);
    }
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
    // 有直接文本、但夹着块级 / 控件子元素：这是容器（SPA 外壳、嵌套列表的 <li>、
    // 正文里夹标题的青空文库），不是段落。判据只看结构，不看文字多少：
    // 「See <a>很长的链接</a>.」、「<span>Hello</span> <span>World</span>」仍是一句
    var breaks = own && el.children.length ? flowBreaks(el) : [];

    // 开放 Shadow DOM：宿主自己的 light DOM 不再当正文扫，改走 shadow root；
    // slot 只走 assignedNodes，避免 light DOM 与分发后的内容被翻译两次。
    // closed root 没有 shadowRoot，按普通元素处理（安全跳过）。
    if (DT.shadow && DT.shadow.active()) {
      if (DT.shadow.skip(el)) return;
      var shadowRoot = DT.shadow.enter(el);
      if (shadowRoot) {
        var shadowKids = shadowRoot.children;
        for (var si = 0; si < shadowKids.length; si += 1) walk(shadowKids[si], out);
        return;
      }
      if (DT.shadow.isSlot(el)) {
        var assigned = DT.shadow.assigned(el);
        for (var ai = 0; ai < assigned.length; ai += 1) {
          if (assigned[ai] && assigned[ai].nodeType === 1) walk(assigned[ai], out);
        }
        return;
      }
    }

    // 只翻了直接文本的元素，子元素露出来了（子菜单 display:none → block、行内子元素显示出来）：按现在的结构重新收集。
    // 露出来的是块级子元素：自己那段收成局部段落、子块各自下钻。双语译文原来追加在元素末尾，
    // 现在会掉到子菜单下面，撤掉重插到子块前面；替换型是原地写的，位置不变，留着不闪。
    // 露出来的是行内子元素（句子的一部分）：全部撤掉，并成整段重收
    if (ownDone && el.children.length && usableChildren(el)) {
      releaseRecords(el, breaks.length ? isDual : null);
    }

    // 1) 真叶子：直接作为（一个或多个）段落单元
    if (!el.children.length) {
      settleForm(el, 'whole', null);
      addParagraphs(out, el, tokensOf(el), false);
      return;
    }

    // 2) 局部段落：只收自己的行内文字（flowTokens），打断文字流的子元素再下钻；
    //    行内子元素已经拼进这段，不再单独收。
    //    放在「子元素全被跳过」之前：块级子元素翻完（打了 data-dt-src）以后照样是打断文字流的子块，
    //    不能下一轮变成 own 单元 —— 那样会撤掉第一段译文、新单元又因为旧译文节点注入失败，每轮重发同一段
    if (breaks.length) {
      settleForm(el, 'partial', new Set(breaks));
      addParagraphs(out, el, flowTokens(el, breaks), false, true);
      var kids2 = el.children;
      for (var bi = 0; bi < kids2.length; bi += 1) {
        // 打断文字流的子块各自下钻；已翻过的行内子元素（以前单独成段）由它自己重新检查
        if (breaks.indexOf(kids2[bi]) >= 0 || kids2[bi].hasAttribute('data-dt-src')) walk(kids2[bi], out);
      }
      return;
    }

    // 3) 子元素全被跳过（已翻译 / 不可见 / notranslate）：父级只翻自己的直接文本，
    //    看得见的行内保留子元素当保留区拼进句子（ownTokens）。
    //    已翻译的子元素照样交给 walk()：改了字 / 子菜单显示出来时，由它自己重新检查
    if (!usableChildren(el)) {
      if (own) {
        settleForm(el, 'own', ownExcluded(el));
        addParagraphs(out, el, ownTokens(el), true);
      } else if (known) releaseRecords(el, isDual); // 自己的字没了（站点删了 / 子元素藏起来了）
      var done = el.children;
      for (var d = 0; d < done.length; d += 1) {
        if (done[d].hasAttribute('data-dt-src')) walk(done[d], out);
      }
      return;
    }

    // 4) 有直接文本（段落），或不该继续拆分 → 整段按段落切分
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
      settleForm(el, 'whole', null);
      addParagraphs(out, el, tokensOf(el), false);
      return;
    }

    // 5) 容器 → 逐个下钻。以前整块翻过、现在要拆开的元素（子菜单显示出来了）：
    //    先撤掉整块的旧译文，否则子元素再各翻一遍就重复了
    if (known) releaseRecords(el);
    el.__dtForm = '';
    el.__dtScope = null;
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
    if (DT.shadow && DT.shadow.prune) DT.shadow.prune();
    var roots = DT.collectRoots();
    // 适配器指定的 Shadow DOM 内容根（Bilibili 只收评论正文，不扫整个组件树）。
    // 普通网站 / 未启用 Shadow DOM 时这里是空数组，不增加开销。
    if (DT.shadow && DT.shadow.active && DT.shadow.active()) {
      var extra = DT.shadow.collectTargets ? DT.shadow.collectTargets() : [];
      if (extra && extra.length) roots = roots.concat(extra);
    }
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
    citeMemo = new WeakMap();
    walkSeen = new WeakSet();
    try {
      if (start.nodeType === 11) {
        // ShadowRoot 是 DocumentFragment，不能直接交给只认 Element 的 walk。
        var fragKids = start.children || [];
        for (var fi = 0; fi < fragKids.length; fi += 1) walk(fragKids[fi], out);
      } else {
        walk(start, out);
      }
    } catch (err) {
      DT.log('collect error', err);
    } finally {
      collectAccept = null;
      scanStyles = null;
      citeMemo = null;
      walkSeen = null;
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

  // ---------------- 目标语言字体适配 ----------------
  // 韩文/日文字体没有完整的中文字形时，浏览器会逐字回退到不同的中文字体：
  // computed font-weight 仍是 400，笔画却深浅不一。只在“源字体明确属于另一种文字系统、
  // 且没有目标文字系统字体”时，给译文单独加目标语言字体；不碰源元素本身的字体。
  // 字体族按脚本注册，新增文字系统只需 register；不绑定任何站点。
  DT.fonts = (function () {
    var profiles = {
      'zh-cn': {
        compatible: /pingfang\s*sc|pingfangsc|microsoft\s*yahei|msyh|simsun|simhei|songti\s*sc|stson|noto\s+(sans|serif)\s+cjk\s+sc|noto\s+(sans|serif)\s+sc|notosanssc|notoserifsc|source\s+han\s+(sans|serif)\s+(sc|cn)|sourcehansc|dengxian|fangsong|kaiti|heiti/i,
        foreign: /myeongjo|myungjo|batang|malgun|nanum|gulim|dotum|apple\s*sd\s*gothic|noto\s+(sans|serif)\s+cjk\s+kr|noto\s+(sans|serif)\s+kr|notosanskr|notoserifkr|source\s+han\s+(sans|serif)\s+kr|sourcehanskr|hiragino|yu\s*(gothic|mincho)|meiryo|ms\s*(pgothic|mincho)|noto\s+(sans|serif)\s+cjk\s+jp|noto\s+(sans|serif)\s+jp|notosansjp|notoserifjp|source\s+han\s+(sans|serif)\s+jp|sourcehansjp/i,
        stack: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
        serif: '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", serif'
      },
      'zh-tw': {
        compatible: /pingfang\s*tc|pingfangtc|microsoft\s*jhenghei|jhenghei|pmingliu|mingliu|songti\s*tc|noto\s+(sans|serif)\s+cjk\s+tc|noto\s+(sans|serif)\s+tc|notosanstc|notoseriftc|source\s+han\s+(sans|serif)\s+(tc|tw)|sourcehanstc/i,
        foreign: /myeongjo|myungjo|batang|malgun|nanum|gulim|dotum|apple\s*sd\s*gothic|noto\s+(sans|serif)\s+cjk\s+kr|noto\s+(sans|serif)\s+kr|notosanskr|notoserifkr|source\s+han\s+(sans|serif)\s+kr|sourcehanskr|hiragino|yu\s*(gothic|mincho)|meiryo|ms\s*(pgothic|mincho)|noto\s+(sans|serif)\s+cjk\s+jp|noto\s+(sans|serif)\s+jp|notosansjp|notoserifjp|source\s+han\s+(sans|serif)\s+jp|sourcehansjp/i,
        stack: '"PingFang TC", "Microsoft JhengHei", "Noto Sans CJK TC", sans-serif',
        serif: '"Songti TC", "STSong", "PMingLiU", "Noto Serif CJK TC", serif'
      },
      ja: {
        compatible: /hiragino|yu\s*(gothic|mincho)|meiryo|ms\s*(pgothic|mincho)|noto\s+(sans|serif)\s+cjk\s+jp|noto\s+(sans|serif)\s+jp|source\s+han\s+(sans|serif)\s+jp|takao|ipafont|ipaex/i,
        foreign: /pingfang|microsoft\s*(yahei|jhenghei)|msyh|jhenghei|simsun|simhei|songti|noto\s+(sans|serif)\s+cjk\s+(sc|tc)|source\s+han\s+(sans|serif)\s+(sc|tc)|myeongjo|myungjo|batang|malgun|nanum|gulim|dotum|apple\s*sd\s*gothic|noto\s+(sans|serif)\s+cjk\s+kr|noto\s+(sans|serif)\s+kr|source\s+han\s+(sans|serif)\s+kr/i,
        stack: '"Hiragino Sans", "Yu Gothic", "Meiryo", "Noto Sans CJK JP", sans-serif',
        serif: '"Hiragino Mincho ProN", "Yu Mincho", "Noto Serif CJK JP", serif'
      },
      ko: {
        compatible: /apple\s*sd\s*gothic|malgun|gulim|dotum|batang|nanum|noto\s+(sans|serif)\s+cjk\s+kr|noto\s+(sans|serif)\s+kr|source\s+han\s+(sans|serif)\s+kr|myeongjo|myungjo|gothic/i,
        foreign: /pingfang|microsoft\s*(yahei|jhenghei)|msyh|jhenghei|simsun|simhei|songti|noto\s+(sans|serif)\s+cjk\s+(sc|tc)|source\s+han\s+(sans|serif)\s+(sc|tc)|hiragino|yu\s*(gothic|mincho)|meiryo|ms\s*(pgothic|mincho)|noto\s+(sans|serif)\s+cjk\s+jp|source\s+han\s+(sans|serif)\s+jp/i,
        stack: '"Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans CJK KR", sans-serif',
        serif: '"AppleMyungjo", "Batang", "Noto Serif CJK KR", serif'
      }
    };

    function keyFor(lang) {
      var s = String(lang || DT.state.targetCode || DT.state.target || '').toLowerCase().replace(/_/g, '-');
      var base = s.split('-')[0];
      var chineseFamily = /^(zh|yue|lzh|cmn|wuu|nan|hak)$/.test(base);
      if (/^zh-(tw|hk|mo|hant)/.test(s)) return 'zh-tw';
      if (/^zh/.test(s)) return 'zh-cn';
      // 自定义中文变体（yue-Hant-HK / zh-Hant / lzh 等）：按 script 子标签选繁 / 简字体档案。
      // 只有中文系语言才吃地区 / script 启发式：en-HK、ko-CN、ja-SG 不能被误配成中文字体。
      if (chineseFamily && /(^|-)(hant|tw|hk|mo)(-|$)/.test(s)) return 'zh-tw';
      if (chineseFamily && /(^|-)(hans|cn|sg)(-|$)/.test(s)) return 'zh-cn';
      if (/^ja/.test(s)) return 'ja';
      if (/^ko/.test(s)) return 'ko';
      // 未来文字系统：优先完整 key，再退化到主语言标签（th-TH -> th）。
      if (profiles[s]) return s;
      var tag = s.split('-')[0];
      return profiles[tag] ? tag : '';
    }

    function familyOf(el) {
      if (!el || el.nodeType !== 1) return '';
      var cs = styleOf(el);
      if (cs && cs.fontFamily) return String(cs.fontFamily);
      try {
        return String(getComputedStyle(el).fontFamily || '');
      } catch (err) {
        return '';
      }
    }

    function needs(lang, family) {
      var key = keyFor(lang);
      var p = key && profiles[key];
      if (!p || !family) return false;
      if (p.compatible.test(family)) return false;
      return p.foreign.test(family);
    }

    function stackFor(lang, family) {
      var key = keyFor(lang);
      var p = key && profiles[key];
      if (!p || !needs(key, family)) return '';
      // 目标字体已按用户实测的跨文字系统字体栈落地；保留原字重/字号/行高/颜色，
      // 不复制韩文字体的 serif 外观（很多韩文衬线字体没有完整中文字形，回退正是抖动来源）。
      return p.stack;
    }

    function policy(opts) {
      var args = opts || {};
      var mode = args.mode || DT.state.mode || 'translation';
      var lang = args.target || args.lang || DT.state.targetCode || DT.state.target;
      var source = args.sourceElement || null;
      var family = source ? familyOf(source) : (args.fontFamily || '');
      var key = keyFor(lang);
      if (mode !== 'translation') {
        return { adapt: false, mode: mode, target: key, reason: 'dual-preserve-source' };
      }
      if (!key) return { adapt: false, mode: mode, target: '', reason: 'no-profile' };
      if (!family) return { adapt: false, mode: mode, target: key, reason: 'no-family' };
      if (!needs(lang, family)) {
        return { adapt: false, mode: mode, target: key, reason: 'font-compatible' };
      }
      return { adapt: true, mode: mode, target: key, stack: profiles[key].stack, reason: 'target-font-needed' };
    }

    function protectedEl(el) {
      if (!el || el.nodeType !== 1) return false;
      var tag = tagOf(el);
      if (/^(H[1-6]|CODE|PRE|KBD|SAMP|VAR|MATH|SCRIPT|STYLE|TEXTAREA|INPUT|SELECT|BUTTON)$/.test(tag)) return true;
      return !!(el.closest && el.closest('h1,h2,h3,h4,h5,h6,code,pre,kbd,samp,var,math,[role="math"],.katex,.MathJax,.mjx-container'));
    }

    function apply(node, lang, sourceEl) {
      if (!node || !sourceEl || !String(node.textContent || '').trim()) return false;
      var decision = policy({ mode: DT.state.mode, target: lang, sourceElement: sourceEl });
      if (!decision.adapt) return false;
      if (protectedEl(sourceEl)) return false;
      if (DT.areaOf && DT.areaOf(sourceEl) !== 'content') return false;
      var family = familyOf(sourceEl);
      var stack = decision.stack || stackFor(lang, family);
      if (!stack) return false;
      var key = keyFor(lang);
      node.setAttribute('data-dt-font', key);
      node.classList.add('dt-font');
      try {
        node.style.setProperty('font-family', stack, 'important');
      } catch (err) {
        node.style.fontFamily = stack;
      }
      return true;
    }

    // 仅译文里已写入的原文本节点：包一层只改字体族的 inline 壳；节点身份、字号、字重都继承。
    function wrapText(node, unit, ops) {
      if (!node || node.nodeType !== 3 || !/\S/.test(node.nodeValue || '')) return null;
      var parent = node.parentNode;
      if (!parent || parent.nodeType !== 1 || !parent.parentNode) return null;
      if (DT.state.mode === 'dual') return null;
      if (parent.closest && parent.closest('a, [data-dt-font], [data-dt-ui]')) return null;
      if (protectedEl(parent) || (unit && unit.el && protectedEl(unit.el))) return null;
      // 导航 / 按钮 / 输入框等控件的 direct text node 不要加 inline 壳，避免 flex 布局多一项。
      if (DT.areaOf && DT.areaOf(parent) !== 'content') return null;
      var family = familyOf(parent);
      var stack = stackFor(unit && unit.lang ? unit.lang : (DT.state.targetCode || DT.state.target), family);
      if (!stack) return null;
      var span = document.createElement('span');
      span.className = 'dt-font';
      span.setAttribute('data-dt-font', keyFor(unit && unit.lang ? unit.lang : (DT.state.targetCode || DT.state.target)));
      try {
        span.style.setProperty('font-family', stack, 'important');
        // 只承载字体族，不生成额外盒模型；包裹后不改变原行内 / 行布局。
        span.style.setProperty('display', 'contents', 'important');
      } catch (err) {
        span.style.fontFamily = stack;
        span.style.display = 'inline';
      }
      insertNode(span, parent, node, ops);
      moveNode(node, span, null, ops);
      ownNodes.add(span);
      return span;
    }

    return {
      profiles: profiles,
      register: function (key, profile) {
        if (!key || !profile || !profile.compatible || !profile.foreign || !profile.stack) return false;
        profiles[String(key).toLowerCase()] = profile;
        return true;
      },
      keyFor: keyFor,
      needs: needs,
      stackFor: stackFor,
      policy: policy,
      apply: apply,
      wrapText: wrapText
    };
  })();

  function makeNode(sourceEl, text, lang, forceBlock, renderMode) {
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
    // 没有标准代码的虚构语言不写空属性，避免 QA 看到 data-dt-lang="" 误以为语言标签存在。
    if (lang) node.setAttribute('data-dt-lang', lang);
    node.className = 'dt-target ' + (inline ? 'dt-inline' : 'dt-block');
    node.textContent = text;
    node.style.cssText = [
      'position: static',
      'float: none',
      'display: ' + (inline ? 'inline' : 'block'),
      'box-sizing: border-box',
      'width: auto',
      'max-width: 100%',
      // 行内译文用逻辑边距：RTL 目标语言下与开始侧（右侧）留出间隔
      inline ? 'margin: 0; margin-inline-start: 0.45em' : 'margin: 0.3em 0 0',
      'transform: none',
      'filter: none',
      'z-index: auto'
    ].join('; ') + ';';
    copyTypography(node, styleOf(sourceEl));
    // 目标语言字体适配只作用于仅译文的独立译文节点；双语走 4c2784d 的
    // copyTypography + .dt-target { font: inherit } 原路径，不进入字体策略。
    if (DT.fonts && (renderMode || DT.state.mode) === 'translation') DT.fonts.apply(node, lang, sourceEl);
    // 目标语言方向独立于原网页；inline 译文不强行改对齐，块级译文用 target 方向的 start，
    // 源段落居中 / 两端对齐时保留（applyTargetNode 会写 inline !important）。
    if (DT.direction) DT.direction.applyTargetNode(node, sourceEl, lang, inline);
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


  // 仅译文：完整正文块可以整体改方向；部分 / 共享容器只包住我们写入的文本节点。
  function directionMeta(unit) {
    return DT.direction && unit ? DT.direction.targetMeta(unit) : null;
  }

  function applyBlockDirection(unit, meta, ops) {
    if (!meta || !meta.mismatch || !unit || !unit.el || !ops) return;
    setAttr(unit.el, 'dir', meta.target, ops);
    setStyle(unit.el, 'direction', meta.target, ops);
    setStyle(unit.el, 'text-align', meta.align, ops);
  }

  // 局部方向隔离：把一个已写入译文的文本节点移进 inline 隔离壳。
  // 只移动文本节点本身（身份不变），壳和移动都进 RenderTransaction；不在链接内部创建。
  function isolateTextNode(node, meta, ops) {
    if (!node || !meta || !meta.mismatch || !node.parentNode || !/\S/.test(node.nodeValue || '')) return null;
    var parent = node.parentNode;
    if (parent.closest && parent.closest('a, [data-dt-dir]')) return null;
    var span = document.createElement('span');
    span.className = 'dt-dir';
    span.setAttribute('data-dt-dir', 'wrap');
    span.setAttribute('dir', meta.target);
    // 只写 BCP 47 形态的 code；内部 id（cl_…）绝不能进 lang 属性。
    if (meta.lang && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(meta.lang)) span.setAttribute('lang', meta.lang);
    try {
      span.style.setProperty('direction', meta.target, 'important');
      span.style.setProperty('unicode-bidi', 'isolate', 'important');
      span.style.setProperty('display', 'inline');
    } catch (err) {
      /* style API 不可用时仍靠 dir 属性 */
    }
    insertNode(span, parent, node, ops);
    moveNode(node, span, null, ops);
    ownNodes.add(node);
    return span;
  }

  // cite：带文献引用的段落用了哪种落点（exact / sentence / failed-only / dropped；双语的 fallback-dual 仅用于非正文定位，见 injectCited）
  function record(where, node, sourceEl, text, area, cite) {
    try {
      var entry = {
        tag: sourceEl.tagName,
        cls: shortCls(sourceEl.className),
        where: where,
        area: area || '',
        span: !!node && node.tagName === 'SPAN',
        mode: DT.state.mode,
        text: previewText(text)
      };
      if (cite) entry.cite = cite;
      DT.placements.push(entry);
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

  // 行内样式按 !important 写：页面样式表里的 display: … !important 压不过它（保留元素 / 注音照样藏得住）。
  // 记下原来的 style 属性原文：还原时没人动过就逐字放回（CSSOM 回放会把 "display:inline-block" 改写成
  // "display: inline-block;"、丢掉行内 !important）；站点改过别的样式就只按属性撤销我们这一条
  function setStyle(el, prop, value, ops) {
    var css = prop.replace(/[A-Z]/g, function (c) {
      return '-' + c.toLowerCase();
    });
    var before = el.style.getPropertyValue(css);
    var priority = el.style.getPropertyPriority(css);
    if (before === value && priority === 'important') return null;
    var attr = el.getAttribute('style');
    el.style.setProperty(css, value, 'important');
    return txPush(
      { op: 'style', el: el, prop: css, before: before, priority: priority, after: value, attr: attr, attrAfter: el.getAttribute('style') },
      ops
    );
  }

  function insertNode(node, parent, before, ops) {
    txPush({ op: 'insert', node: node, parent: parent, before: before || null }, ops);
    if (before && before.parentNode === parent) parent.insertBefore(node, before);
    else parent.appendChild(node);
  }

  function moveNode(node, parent, before, ops) {
    var fromParent = node.parentNode;
    var fromBefore = node.nextSibling;
    txPush({ op: 'move', node: node, fromParent: fromParent, fromBefore: fromBefore, toParent: parent, toBefore: before || null }, ops);
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
        } else if (op.op === 'move') {
          if (op.node && op.node.parentNode === op.toParent && op.fromParent) {
            if (op.fromBefore && op.fromBefore.parentNode === op.fromParent) op.fromParent.insertBefore(op.node, op.fromBefore);
            else op.fromParent.appendChild(op.node);
          }
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
          if (!op.el) continue;
          if (op.el.getAttribute('style') === op.attrAfter) {
            // 写完之后没人动过：style 属性逐字放回
            if (op.attr == null) op.el.removeAttribute('style');
            else op.el.setAttribute('style', op.attr);
          } else if (op.el.style.getPropertyValue(op.prop) === op.after) {
            if (op.before) op.el.style.setProperty(op.prop, op.before, op.priority || '');
            else op.el.style.removeProperty(op.prop);
            // 原本没有 style 属性时，删完会留下 style=""，还原后 innerHTML 对不上
            if (op.attr == null && op.el.getAttribute('style') === '') op.el.removeAttribute('style');
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
    if (renderFrames) { if (tx.length >= 4000) compactPending = true; return; }
    compactPending = false;
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
    // 开放 Shadow DOM 的事件会 retarget 到宿主。只把单元最近的宿主映射到本单元：
    // 整条评论 / 整个评论区外壳覆盖多条评论，绝不能拿第一条评论冒充整块区域的 hover 单元。
    if (DT.shadow && DT.shadow.active && DT.shadow.active()) {
      var hostRoot = unit.el.getRootNode ? unit.el.getRootNode() : null;
      if (hostRoot && hostRoot.host && !nodeUnit.has(hostRoot.host)) {
        nodeUnit.set(hostRoot.host, unit);
      }
    }
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
    if (rec.unit && rec.unit.targetValues) {
      for (var tv = 0; tv < rec.unit.targetValues.length; tv += 1) {
        var targetValue = rec.unit.targetValues[tv];
        if (!targetValue.node.isConnected || targetValue.node.nodeValue !== targetValue.value) return false;
      }
    }
    if (rec.mode === 'cited' && rec.unit && rec.unit.citedInserted) {
      for (var c = 0; c < rec.unit.citedInserted.length; c += 1) {
        if (!rec.unit.citedInserted[c].isConnected) return false;
      }
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
  // cited（可选）：带文献引用的段落（injectCited），译文里放回引用副本
  function injectDual(unit, text, lang, area, cited) {
    if (DT.debugStats) DT.debugStats.injectDualCount += 1;
    var sourceEl = unit.el;
    var node = makeNode(sourceEl, text, lang, !unit.whole, 'dual');
    if (cited) text = fillCited(node, unit, cited);
    else if (unit.inlineResult) {
      node.textContent = '';
      appendInlineRange(node, unit, unit.inlineResult.stripped, 0, unit.inlineResult.stripped.length);
      text = node.textContent;
    }
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
    record(unit.anchor ? 'before' : 'inside', node, sourceEl, text, area, unit.citeMode);
    return true;
  }

  function pieceText(piece) {
    return piece.node.nodeValue.slice(piece.start, piece.end);
  }

  function lineHeadPiece(group, kept) {
    var pieces = kept
      ? group.pieces.filter(function (p) { return !kept(p.node); })
      : group.pieces;
    for (var i = 0; i < pieces.length; i += 1) {
      if (/\S/.test(pieceText(pieces[i]))) return pieces[i];
    }
    return null;
  }

  // 一行译文写进这一行：第一个有字的片段换成「原来的行首缩进 + 译文」，同一行后面的片段清空
  // （行内的 <b> / <a> 和以前一样不保留格式，但只影响这一行）
  // kept(node)：保留区的文本节点，不写也不清空。这一行没有可写的片段时返回 false
  function writeLine(group, line, edits, first, kept) {
    var pieces = kept
      ? group.pieces.filter(function (p) {
          return !kept(p.node);
        })
      : group.pieces;
    var lead = 0;
    while (lead < pieces.length && !/\S/.test(pieceText(pieces[lead]))) lead += 1;
    if (lead >= pieces.length) return false;
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
    return true;
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

  function clearGroup(group, edits, collapsed, kept) {
    (group.pieces || []).forEach(function (p) {
      if (kept && kept(p.node)) return;
      edits.push({ node: p.node, start: p.start, end: p.end, value: '' });
    });
    if (group.nl && !(kept && kept(group.nl.node))) {
      edits.push({ node: group.nl.node, start: group.nl.at, end: group.nl.at + 1, value: '' });
    }
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
    // 分行段落里的保留区不按标记切分：每行整句写进本行其它节点，保留元素隐藏；
    // 只有保留内容、没有可写节点的那一行原样留着（它的译文本来就是这段保留内容）
    var kept = unit.keep && unit.keep.length
      ? function (node) {
          return keepIndexOf(unit, node) >= 0;
        }
      : null;
    var shown = new Set();
    var written = assign.join('\n');
    // 记录每行首节点；若它只被这一行使用且落在局部强调壳里，写完后再把行文本挪到壳外。
    var lineHeads = new Map();
    for (var lh = 0; lh < n && lh < assign.length; lh += 1) {
      var hp = lineHeadPiece(sel[lh], kept);
      if (!hp || isDropcapNode(hp.node)) continue;
      captureUnitStyleBefore(unit, hp.node);
      lineHeads.set(hp.node, (lineHeads.get(hp.node) || 0) + 1);
    }
    // 这一行上的保留元素留着不藏。written：保留内容已经原样出现在写进去的译文里的，照样藏（免得重复）
    function showKept(group, written) {
      group.pieces.forEach(function (p) {
        var ki = keepIndexOf(unit, p.node);
        if (ki >= 0 && !(written && written.indexOf(unit.keep[ki].text) >= 0)) shown.add(unit.keep[ki].el);
      });
    }
    for (var k = 0; k < n; k += 1) {
      if (k >= assign.length) {
        clearGroup(sel[k], edits, collapsed, kept);
        // 模型少回了几行：这一行没有译文，上面的保留元素再藏起来，这段内容就从页面上消失了
        if (kept) showKept(sel[k], written);
        continue;
      }
      if (!writeLine(sel[k], assign[k], edits, k === 0, kept) && kept) showKept(sel[k], null);
    }
    (unit.groups.tail || []).forEach(function (g) {
      clearGroup(g, edits, collapsed, kept);
    });
    // 同一文本节点上的多行 edit 必须一次性从后往前写：逐行写会让后一行的偏移失效
    if (edits.length) applyEditsTx(edits, ops);
    // 多行段落同样不能把整行译文留在 <strong> / 粗体 span 里。
    // 只处理只被一行使用的首节点；共享节点（pre-wrap 里多行同一 TextNode）保持原逻辑，避免搬走别行。
    for (var lm = 0; lm < n && lm < assign.length; lm += 1) {
      var headPiece = lineHeadPiece(sel[lm], kept);
      if (!headPiece || lineHeads.get(headPiece.node) !== 1 || isDropcapNode(headPiece.node)) continue;
      var boundary = styleBoundaryFor(headPiece.node, unit);
      if (!boundary || styleBoundaryIsWhole(unit, boundary) || !boundary.parentNode) continue;
      var lineValue = headPiece.node.nodeValue;
      if (!/\S/.test(lineValue || '')) continue;
      var safeLine = document.createTextNode(lineValue);
      insertNode(safeLine, boundary.parentNode, boundary, ops);
      ownNodes.add(safeLine);
      nodeUnit.set(safeLine, unit);
      if (DT.fonts) DT.fonts.wrapText(safeLine, unit, ops);
      setText(headPiece.node, '', ops);
    }
    collapsed.forEach(function (br) {
      setAttr(br, 'data-dt-collapsed', '1', ops);
    });
    if (kept) hideKept(unit, ops, shown);
    var srcLines = DT.splitLines(unit.text);
    var saved = [];
    ops.forEach(function (op) {
      if (op.op === 'text') saved.push({ node: op.node, value: op.before, wrote: op.after });
    });
    var dmeta = directionMeta(unit);
    if (unit.whole) applyBlockDirection(unit, dmeta, ops);
    else if (dmeta && dmeta.mismatch) {
      saved.forEach(function (one) {
        if (one && /\S/.test(one.wrote || '')) isolateTextNode(one.node, dmeta, ops);
      });
    }
    saved.forEach(function (one) {
      if (one && /\S/.test(one.wrote || '')) DT.fonts.wrapText(one.node, unit, ops);
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

  // 单行保留区原地写回的计划：模型按原顺序留下了 N 个保留区 → N+1 段译文，
  // 第 g 段写进第 g 个保留元素之前（g = N 时是最后一个之后）的文本节点。
  // 返回 [{ nodes, text }]；有一段非空译文那一侧没有文本节点可写，返回 null（走兜底）
  // v1 用本地语义壳重建译文后，原 strong / code / sup 的文字会被清空，但站点给的
  // background / border / padding 仍会画出一个空药丸。事务内隐藏已经无字的原格式元素；
  // restore 会恢复原样。链接标签 / 控件 / 含图标或子结构的元素不碰。
  function hideEmptyFormatShells(unit, ops) {
    (unit.formats || []).forEach(function (format) {
      var el = format && format.el;
      if (!el || el.nodeType !== 1 || !el.isConnected) return;
      if (format.kind === 'link') return;
      if (keepIndexOf(unit, el) >= 0) return;
      if (el.children && el.children.length) return;
      if (String(el.textContent || '').replace(/\s+/g, '')) return;
      setStyle(el, 'display', 'none', ops);
    });
  }

  function keepPlan(unit, segs) {
    var keep = unit.keep;
    var group = (unit.groups.filled || [])[0];
    if (!group || !segs || segs.length !== keep.length + 1) return null;
    var gaps = segs.map(function (seg) {
      return { nodes: [], spare: [], text: seg };
    });
    var gap = 0;
    var seen = new Set();
    group.pieces.forEach(function (p) {
      if (seen.has(p.node)) return;
      seen.add(p.node);
      var ki = keepIndexOf(unit, p.node);
      if (ki >= 0) {
        gap = ki + 1;
        return;
      }
      (/\S/.test(pieceText(p)) ? gaps[gap].nodes : gaps[gap].spare).push(p.node);
    });
    for (var g = 0; g < gaps.length; g += 1) {
      if (gaps[g].nodes.length || !/\S/.test(gaps[g].text)) continue;
      // 两个保留元素之间只有一个空格节点（<code>a</code> <code>b</code>）：译文的「和」写进这个空格
      if (!gaps[g].spare.length) return null;
      gaps[g].nodes = gaps[g].spare.slice(0, 1);
    }
    return gaps;
  }

  // 仅译文：单行段落整体写进第一个文本节点，其余清空（保留图标等子元素）。
  // 有保留区时按 keepPlan 分段写；分不了就整句写进非保留节点，保留元素隐藏
  function injectReplace(unit, text, area, segs) {
    var groups = unit.groups.filled || [];
    if (groups.length >= 2) return injectLines(unit, DT.splitLines(text), area);
    var saved = [];
    var ops = [];
    var hasKeep = !!(unit.keep && unit.keep.length);
    var plan = hasKeep ? keepPlan(unit, segs) : null;
    if (plan) {
      plan.forEach(function (gap, g) {
        writeNodes(unit, gap.nodes, gap.text, g === 0, ops, saved);
      });
    } else {
      var nodes = contentNodes(unit).filter(function (node) {
        return !hasKeep || keepIndexOf(unit, node) < 0;
      });
      if (!nodes.length) return false;
      writeNodes(unit, nodes, text, true, ops, saved);
      if (hasKeep) hideKept(unit, ops);
    }

    var dmeta = directionMeta(unit);
    if (unit.whole) applyBlockDirection(unit, dmeta, ops);
    else if (dmeta && dmeta.mismatch) {
      saved.forEach(function (one) {
        if (one && /\S/.test(one.wrote || '')) isolateTextNode(one.node, dmeta, ops);
      });
    }
    // 方向壳之后再加目标语言字体壳，避免 isolateTextNode 把字体壳留在原地。
    saved.forEach(function (one) {
      if (one && /\S/.test(one.wrote || '')) DT.fonts.wrapText(one.node, unit, ops);
    });
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
    record('replace', null, unit.el, text, area, unit.citeMode);
    return true;
  }

  DT.styleBoundaryAware = 1;

  // 行内样式边界：只把 font-weight / font-style 的变化当成强调边界。
  // 字号变化（首字下沉、CSS 上标）不在这里处理，避免把正常 dropcap 当成粗体污染。
  function inlineStyleSignature(el) {
    var cs = styleOf(el);
    if (!cs) return null;
    return { weight: String(cs.fontWeight || ''), style: String(cs.fontStyle || ''), family: String(cs.fontFamily || '') };
  }

  function styleDiffers(el, base) {
    if (!base) return false;
    var sig = inlineStyleSignature(el);
    if (!sig) return false;
    if (sig.weight !== base.weight || sig.style !== base.style) return true;
    // 有些站点的“粗体”是字体族本身（NotoSansKR-Bold / Arial Black），computed font-weight 仍是 400。
    // 只把明确 bold/black/heavy 的局部字体族当强调边界，普通 serif/sans 切换不处理。
    return sig.family !== base.family && /bold|black|heavy|semibold|demi/i.test(sig.family);
  }

  // 从文本节点往上找 unit.el 以下最外层的局部强调壳（strong / b / em / 粗体 span）。
  // 不把 unit.el 自己的基准样式算成污染：整段加粗的标题 / 公告仍应继承。
  function styleBoundaryFor(node, unit) {
    var base = inlineStyleSignature(unit.el);
    if (!base) return null;
    var boundary = null;
    var cur = node && node.parentNode;
    while (cur && cur !== unit.el && cur.nodeType === 1) {
      if (styleDiffers(cur, base)) boundary = cur;
      cur = cur.parentNode;
    }
    return boundary;
  }

  // 局部强调壳是否只覆盖了正文的一部分。全部覆盖时视为整段强调，保留样式。
  function styleBoundaryIsWhole(unit, boundary) {
    if (!boundary) return false;
    var all = contentNodes(unit);
    if (!all.length) return true;
    return all.every(function (node) { return boundary.contains(node); });
  }

  // 仅译文：把译文放到正文排版上下文，而不是复用局部 <strong> / 粗体 span 里的第一个文本节点。
  // 返回 { parent, before }；不需要逃出时返回原 slot。
  function styleSafeSlot(unit, slot) {
    if (!slot || !slot.parent) return slot;
    if (slot.parent === unit.el) return slot;
    var base = inlineStyleSignature(unit.el);
    var boundary = null;
    var cur = slot.parent;
    while (cur && cur !== unit.el && cur.nodeType === 1) {
      if (styleDiffers(cur, base) || (unit.formats || []).some(function (f) { return f.kind !== 'link' && f.el === cur; })) boundary = cur;
      cur = cur.parentNode;
    }
    if (!boundary || styleBoundaryIsWhole(unit, boundary) || !boundary.parentNode) return slot;
    return { parent: boundary.parentNode, before: boundary };
  }

  // 可选诊断：记录译文写入前的局部样式、祖先链和 DOM 结构；不参与渲染。
  function diagnosticStyle(el) {
    if (!el || el.nodeType !== 1) return null;
    var cs;
    try { cs = getComputedStyle(el); } catch (err) { cs = null; }
    if (!cs) return { tag: el.tagName, id: el.id || '', cls: String(el.className || ''), style: el.getAttribute('style') || '' };
    return {
      tag: el.tagName,
      id: el.id || '',
      cls: String(el.className || ''),
      style: el.getAttribute('style') || '',
      fontWeight: cs.fontWeight,
      fontStyle: cs.fontStyle,
      fontSize: cs.fontSize,
      fontFamily: cs.fontFamily,
      lineHeight: cs.lineHeight,
      color: cs.color,
      dataDt: el.getAttribute('data-dt-src') ? 'src' : el.getAttribute('data-dt-replaced') ? 'replaced' : el.getAttribute('data-dt-dir') ? 'dir' : ''
    };
  }

  function diagnosticChain(node, max) {
    var out = [];
    var cur = node && node.parentNode;
    while (cur && out.length < (max || 18)) {
      out.push(diagnosticStyle(cur));
      if (cur === document.body || cur === document.documentElement) break;
      cur = cur.parentNode;
    }
    return out;
  }

  function captureUnitStyleBefore(unit, node) {
    if (!unit || unit.styleEvidence || !node) return;
    unit.styleEvidence = {
      sourceText: previewText(unit.text),
      sourceHtml: unit.el && unit.el.outerHTML ? unit.el.outerHTML.slice(0, 5000) : '',
      firstText: previewText(node.nodeValue),
      chain: diagnosticChain(node, 18),
      capturedAt: Date.now()
    };
  }

  // 一段译文写进一串文本节点：优先写进正文上下文；局部强调壳不承载整段译文。
  function writeNodes(unit, nodes, text, first, ops, saved) {
    if (!nodes.length) return;
    captureUnitStyleBefore(unit, nodes[0]);
    // 首字下沉：首字放进下沉节点，其余放进后面的正文节点。
    // 否则整段中文都会挤进 71.5px 的 "N" 里（Aeon 仅译文模式实例）。
    var drop = first && nodes.length > 1 && isDropcapNode(nodes[0]) ? nodes[0] : null;
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

    // 整段译文不能因为第一个文本节点碰巧在 <strong> / 粗体 span 里而全部加粗。
    // 局部强调壳只覆盖正文的一部分时，在壳外创建一个安全文本节点承载完整译文；
    // 整段都在同一个强调壳里（公告 / 强调段落）时保留原行为。
    var styleBoundary = drop ? null : styleBoundaryFor(nodes[0], unit);
    var safeText = null;
    if (styleBoundary && !styleBoundaryIsWhole(unit, styleBoundary) && styleBoundary.parentNode) {
      safeText = document.createTextNode('');
      insertNode(safeText, styleBoundary.parentNode, styleBoundary, ops);
      ownNodes.add(safeText);
      nodeUnit.set(safeText, unit);
    }
    if (safeText) {
      var lead = first ? /^\s*/.exec(nodes[0].nodeValue)[0] : '';
      var wroteSafe = lead + (drop ? text : text);
      safeText.nodeValue = wroteSafe;
      if (DT.fonts) DT.fonts.wrapText(safeText, unit, ops);
      for (var s = 0; s < nodes.length; s += 1) {
        var beforeSafe = nodes[s].nodeValue;
        setText(nodes[s], '', ops);
        saved.push({ node: nodes[s], value: beforeSafe, wrote: '' });
      }
      return;
    }
    for (var i = 0; i < nodes.length; i += 1) {
      var wrote;
      if (drop) wrote = i === 0 ? head : i === restIndex ? tail : '';
      // 保留元素后面的那段：模型给的空白就是这里的空白，不再叠原来的行首空格
      else wrote = i === 0 ? (first ? /^\s*/.exec(nodes[i].nodeValue)[0] : '') + text : '';
      var before = nodes[i].nodeValue;
      setText(nodes[i], wrote, ops);
      saved.push({ node: nodes[i], value: before, wrote: wrote });
    }
  }

  // ---------------- 混合行内内容：正文里夹着引用 / 图表链接 / 普通链接 / 提及 / notranslate ----------------
  // 仅译文（injectMixed）：DOM 结构和可翻译文字分开处理 ——
  //   原子（unit.keep 里的元素：文献引用、图表链接、混合段落里的普通链接、@提及、notranslate）原样留在原位，
  //   节点身份、href / id / 事件都不动；原子之外的文字节点全部清空；译文按原子的落点切成 N+1 段，
  //   作为新文本节点插在原子之间（永远不进单元内部的链接），<br> 分行时逐行对齐。不移动原有节点，所有改动走 RenderTransaction。
  //   落点：模型留下的标记位置（词级）→ 换了先后就挪到各自那一句的句末 → 标记丢了按原文所在句对到译文句末；
  //   图表链接的标记丢了时按它的标签（Fig. 1 / 图 1）在译文里唯一定位。定不下来就失败（保持原文、报原因），绝不退回双语。
  // 双语（含绝对定位 / 界面区域导致的 replaceMode）：保持 keepPlan / 副本逻辑
  function injectCited(unit, marks, plain, lang, area, replaceMode) {
    if (replaceMode && (DT.state.mode === 'translation' || unit.inlineResult)) return injectMixed(unit, marks, area);
    if (replaceMode) {
      var single = (unit.groups.filled || []).length < 2 && !(unit.ruby && unit.ruby.length);
      var place = single ? DT.units.keepPlacement(marks.stripped, marks.at) : null;
      var segs = place ? citeSegs(unit, marks.stripped, place.at) : null;
      if (segs && keepPlan(unit, segs)) {
        unit.citeMode = place.snapped ? 'sentence' : 'exact';
        return injectReplace(unit, citeRendered(unit, segs), area, segs);
      }
      unit.citeMode = 'fallback-dual';
    }
    return injectDual(unit, plain, lang, area, marks);
  }

  // 两个引用在原文里隔着别的字、译文里却紧挨着：中间补一个逗号，免得「¹,²」和「³」读成「1,23」
  function citeSeparator(unit, a, b) {
    var ka = unit.keep[a];
    var kb = unit.keep[b];
    if (!ka || !kb || !ka.cite || !kb.cite) return '';
    var lo = Math.min(ka.end, kb.end);
    var hi = Math.max(ka.start, kb.start);
    return /\S/.test(unit.text.slice(lo, hi)) ? ',' : '';
  }

  // 落点 → keepPlan 要的 N+1 段译文（按页面顺序）
  function citeSegs(unit, stripped, at) {
    var segs = [];
    var from = 0;
    for (var i = 0; i < at.length; i += 1) {
      var seg = stripped.slice(from, at[i]);
      if (i > 0 && !/\S/.test(seg)) seg += citeSeparator(unit, i - 1, i);
      segs.push(seg);
      from = at[i];
    }
    segs.push(stripped.slice(from));
    return segs;
  }

  // 页面上实际显示的译文（各段 + 原地的引用编号）：悬停对照和 renderedText 都按它算
  function citeRendered(unit, segs) {
    var out = segs[0] || '';
    for (var i = 0; i < unit.keep.length; i += 1) out += unit.keep[i].text + (segs[i + 1] || '');
    return out;
  }


  // 注入失败的原因（unit.injectResult）：main.js 据此区分「结构不支持」和「已处理」，不把失败当成跳过
  function failInject(unit, code, reason) {
    unit.citeMode = 'failed-only';
    unit.injectResult = { code: code, reason: reason };
    return false;
  }

  // 图表链接的标记丢了：按它的标签（原文 Fig. 1 或对应的「图 1」）在译文里找，只出现一次才算；找到就把这串字
  // 从译文里拿掉（页面上由链接本身显示）。文献引用只是几个数字，不这样找（译文里本来就可能有同样的数字）
  function recoverXrefMarks(unit, marks) {
    var keep = unit.keep || [];
    var stripped = marks.stripped;
    var at = marks.at.slice();
    keep.forEach(function (k, i) {
      if (at[i] >= 0 || k.kind !== 'xref') return;
      var labels = [k.text, xrefLabel(k.text, DT.state.targetCode || DT.state.target)].filter(Boolean);
      for (var j = 0; j < labels.length; j += 1) {
        var hit = stripped.indexOf(labels[j]);
        if (hit < 0 || stripped.indexOf(labels[j], hit + 1) >= 0) continue;
        var len = labels[j].length;
        stripped = stripped.slice(0, hit) + stripped.slice(hit + len);
        at = at.map(function (p) {
          return p > hit ? p - len : p;
        });
        at[i] = hit;
        return;
      }
    });
    return { stripped: stripped, at: at };
  }

  // 一行里各原子的落点（行内偏移，按页面顺序单调不减）。items：[{ start: 原文行内偏移, at: 译文行内偏移或 -1 }]。
  // 标记都在 → keepPlacement（词级，换序时挪句末）；有标记丢了 / 仍对不上 → 按原文所在句对到译文句末（只保证不跨句）
  function atomPlacement(srcLine, dstLine, items) {
    if (!items.length) return { at: [], mode: 'exact' };
    var at = items.map(function (it) {
      return it.at;
    });
    if (at.every(function (p) { return p >= 0; })) {
      var placed = DT.units.keepPlacement(dstLine, at);
      if (placed) return { at: placed.at, mode: placed.snapped ? 'sentence' : 'exact' };
    }
    var dst = DT.units.sentencesOf(dstLine);
    if (!dst.length) {
      return /\S/.test(dstLine) ? null : { at: items.map(function () { return 0; }), mode: 'sentence' };
    }
    var src = DT.units.sentencesOf(srcLine);
    var out = [];
    var prev = 0;
    items.forEach(function (it) {
      var si = 0;
      while (si + 1 < src.length && it.start >= src[si + 1][0]) si += 1;
      var di = Math.min(si, dst.length - 1);
      var end = DT.units.sentenceEndAt(dstLine, dst[di][0]);
      if (end < prev) end = prev;
      out.push(end);
      prev = end;
    });
    return { at: out, mode: 'sentence' };
  }

  // CSS 上标没有统一标签。只有「已经确认是引用的原子」才看排版证据；字号小本身不是引用证据。
  // 普通 small / 普通链接仍留在原本的局部排版上下文。
  function raisedCitationShell(el) {
    var style = getComputedStyle(el);
    if (style.verticalAlign === 'super' || style.verticalAlign === 'sub') return true;
    if ((style.position === 'relative' || style.position === 'absolute') &&
        (parseFloat(style.top) < 0 || parseFloat(style.bottom) > 0)) return true;
    return style.transform && style.transform !== 'none';
  }

  // 引用原子的安全边界是整条特殊排版包装链，不能只跨出 A 后停在 SUP / CSS 上标里。
  // 必须在清空原文前计算：isCitationEl 依赖原始数字 / 分隔符，写入后再判断会丢掉包装语义。
  function safeSlot(unit, node, after, citation, memo) {
    if (!node || !node.parentNode) return null;
    var cur = node;
    for (var p = cur.parentNode; p && p !== unit.el && p.nodeType === 1; p = p.parentNode) {
      var tag = tagOf(p);
      var special = false;
      if (citation) {
        if (memo && memo.has(p)) special = memo.get(p);
        else {
          special = isCitationEl(p) || raisedCitationShell(p);
          if (memo) memo.set(p, special);
        }
      }
      if (tag === 'A' || tag === 'SUP' || tag === 'SUB' ||
          special) cur = p;
    }
    return { parent: cur.parentNode, before: after ? cur.nextSibling : cur };
  }

  // 普通链接里可以可靠本地化的「补充材料」类标签；其余链接文字（身份 / 专名 / 任意正文）保持原样。
  // 只对中文目标、只写唯一可见文本节点，href / 事件 / 节点身份都不动。
  var LINK_ZH_LABEL = [
    [/^(?:supplementary|supplement)\s+(\d+)$/i, '补充材料 $1'],
    [/^(?:supplementary|supplement)\s+material$/i, '补充材料'],
    [/^(?:supplementary|supplement)\s+data$/i, '补充数据'],
    [/^(?:supplementary|supplement)\s+information$/i, '补充信息'],
    [/^data\s+(S?\d+[A-Za-z]?)$/i, '数据 $1']
  ];
  function linkLabel(text, target) {
    var t = String(target || '');
    if (t.indexOf('zh') !== 0) return '';
    var s = DT.normalizeText(text || '');
    for (var i = 0; i < LINK_ZH_LABEL.length; i += 1) {
      var m = LINK_ZH_LABEL[i][0].exec(s);
      if (m) return LINK_ZH_LABEL[i][1].replace('$1', m[1] || '');
    }
    return '';
  }

  // 图表链接 / 补充材料普通链接的可见标签本地化：写进原子自己的 DOM，进事务，还原时放回原文
  function relabelAtom(k, ops, saved) {
    var label = k.kind === 'xref' ? xrefLabel(k.text, DT.state.targetCode || DT.state.target) : k.kind === 'link' ? linkLabel(k.text, DT.state.targetCode || DT.state.target) : '';
    if (!label || label === k.text) return k.text;
    return writeVisibleLabel(k.el, label, ops, saved) ? label : k.text;
  }


  // 页面上实际显示的文字（单元里所有文本节点按阅读顺序）：和悬停的 mapFromNode(unit.el) 一致
  function shownTextOf(el) {
    var out = '';
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (var t = walker.nextNode(); t; t = walker.nextNode()) out += t.nodeValue;
    return out;
  }

  function injectMixed(unit, marks, area) {
    var keep = unit.keep || [];
    if (!keep.length && !(unit.formats && unit.formats.length)) return failInject(unit, 'unsafe-structure', 'no-atoms');
    if (unit.ruby && unit.ruby.length && !keep.some(isRubyKeep)) return failInject(unit, 'unsafe-structure', 'ruby');
    var groups = (unit.groups && unit.groups.filled) || [];
    var multi = groups.length > 1;
    // 分行段落：第 2 行起要有 <br>，或行首是文本节点里的真实 \n（pre-wrap）。
    for (var g = 1; g < groups.length; g += 1) {
      if (!groups[g].br && !groups[g].nl) return failInject(unit, 'unsafe-structure', 'line-boundary');
    }
    var fixed = recoverXrefMarks(unit, marks);
    var stripped = fixed.stripped;
    var srcOff = [];
    var dstOff = [];
    function filledLines(value, offsets) {
      var lines = [];
      var off = 0;
      value.split('\n').forEach(function (line) {
        if (line.trim()) { lines.push(line); offsets.push(off); }
        off += line.length + 1;
      });
      return lines;
    }
    var srcLines = multi ? filledLines(unit.text, srcOff) : [unit.text];
    // 空行不生成独立翻译单元，但仍留在真实文本偏移及原始换行结构中。
    var dstLines = multi ? filledLines(stripped, dstOff) : [stripped.replace(/\n/g, ' ')];
    if (!multi) { stripped = dstLines[0]; srcOff = [0]; dstOff = [0]; }
    if (multi && (srcLines.length !== groups.length || dstLines.length !== groups.length)) {
      return failInject(unit, 'invalid-placement', 'line-count');
    }
    var l;
    // 每个原子属于原文的哪一行；模型把标记放到别的行里就当丢了，在它自己那一行里恢复
    var lineOf = keep.map(function (k) {
      var li = 0;
      while (li + 1 < srcOff.length && k.start >= srcOff[li + 1]) li += 1;
      return li;
    });
    var at = new Array(keep.length);
    var mode = 'exact';
    for (l = 0; l < srcLines.length; l += 1) {
      var idx = [];
      var items = [];
      keep.forEach(function (k, i) {
        if (lineOf[i] !== l) return;
        var p = fixed.at[i];
        var inLine = p >= dstOff[l] && p <= dstOff[l] + dstLines[l].length;
        idx.push(i);
        items.push({ start: k.start - srcOff[l], at: inLine ? p - dstOff[l] : -1 });
      });
      var placed = atomPlacement(srcLines[l], dstLines[l], items);
      if (!placed) return failInject(unit, 'invalid-placement', 'no-sentence');
      if (placed.mode !== 'exact') mode = 'sentence';
      idx.forEach(function (i, n) {
        at[i] = dstOff[l] + placed.at[n];
      });
    }

    // 页面顺序的落点序列：第 l 行开头的 <br>，再是这一行的原子
    var seq = [];
    for (l = 0; l < groups.length || l < 1; l += 1) {
      if (l > 0) {
        var boundary = groups[l].br
          ? { node: groups[l].br, pos: dstOff[l] - 1, br: true }
          : { node: document.createTextNode('\n'), nl: true, pos: dstOff[l] - 1 };
        seq.push(boundary);
      }
      keep.forEach(function (k, i) {
        if (lineOf[i] === l) seq.push({ node: k.el, pos: at[i], keep: i, cite: k.kind === 'cite' });
      });
    }
    var texts = [];
    var textStarts = [];
    var textEnds = [];
    var from = 0;
    seq.forEach(function (item, n) {
      var seg = stripped.slice(from, Math.max(from, item.pos));
      var prev = n > 0 ? seq[n - 1] : null;
      if (prev && prev.keep != null && item.keep != null && !/\S/.test(seg)) seg += citeSeparator(unit, prev.keep, item.keep);
      texts.push(seg);
      textStarts.push(from);
      textEnds.push(Math.max(from, item.pos));
      from = Math.max(from, item.br || item.nl ? item.pos + 1 : item.pos);
    });
    texts.push(stripped.slice(from));
    textStarts.push(from);
    textEnds.push(stripped.length);

    // 先计划、再写入。多个原子共享同一包装时，固定的 before 让外移后的文字仍按页面顺序追加。
    var slotMemo = new Map();
    var firstConnected = null;
    var previousConnected = null;
    for (var si = 0; si < seq.length; si += 1) {
      if (seq[si].node.parentNode) { firstConnected = seq[si]; break; }
    }
    seq.forEach(function (item) {
      if (!item.nl) {
        item.beforeSlot = styleSafeSlot(unit, safeSlot(unit, item.node, false, item.cite, slotMemo));
        item.afterSlot = styleSafeSlot(unit, safeSlot(unit, item.node, true, item.cite, slotMemo));
        previousConnected = item;
        return;
      }
      var anchor = previousConnected || firstConnected;
      if (anchor) item.newlineSlot = safeSlot(unit, anchor.node, !!previousConnected, anchor.cite, slotMemo);
      if (!item.newlineSlot) item.newlineSlot = { parent: unit.el, before: null };
    });

    var emptySlot = null;
    if (!seq.length) {
      var firstSource = unit.firstNode || (unit.map.chars.filter(function (c) { return c && c.node; })[0] || {}).node;
      emptySlot = styleSafeSlot(unit, safeSlot(unit, firstSource, false, false));
      if (!emptySlot) return failInject(unit, 'unsafe-structure', 'no-text-slot');
    }
    var ops = [];
    var saved = [];
    var seen = new Set();
    // 混合段落同样记录写入前样式，供诊断区分源站强调 / 注入污染。
    var firstMixed = null;
    groups.forEach(function (group) {
      if (firstMixed) return;
      (group.pieces || []).forEach(function (piece) {
        if (!firstMixed && /\S/.test(pieceText(piece))) firstMixed = piece.node;
      });
    });
    captureUnitStyleBefore(unit, firstMixed);
    // 原子之外的文字节点全部清空（含空白节点：中文译文里不该夹着原来的空格）
    groups.concat((unit.groups && unit.groups.tail) || []).forEach(function (group) {
      (group.pieces || []).forEach(function (piece) {
        var node = piece.node;
        if (seen.has(node)) return;
        seen.add(node);
        if (keepIndexOf(unit, node) >= 0 || node.nodeValue === '') return;
        var before = node.nodeValue;
        setText(node, '', ops);
        saved.push({ node: node, value: before, wrote: '' });
      });
    });

    var dmeta = directionMeta(unit);
    var isolate = !!(dmeta && dmeta.mismatch);
    // 完整独占段落可改整块方向；部分 / 共享容器只包住新文本，不动父级。
    if (unit.whole) applyBlockDirection(unit, dmeta, ops);
    var inserted = [];
    // pre-wrap 的边界是文本节点里的 \n，没有现成的 <br> 可当锚点：先放一个只含换行的文本节点。
    // 它进事务、参与还原；之后的译文段插在它前后，硬换行和缩进都保留。
    seq.forEach(function (item, n) {
      if (!item.nl) return;
      var slot = item.newlineSlot;
      insertNode(item.node, slot.parent, slot.before, ops);
      // 前一原子的后段必须在新换行之前；不能继续用原来包装之后的尾锚点。
      if (n > 0) seq[n - 1].afterSlot = { parent: slot.parent, before: item.node };
      item.beforeSlot = safeSlot(unit, item.node, false, false);
      item.afterSlot = safeSlot(unit, item.node, true, false);
      nodeUnit.set(item.node, unit);
      ownNodes.add(item.node);
      inserted.push(item.node);
    });
    var targetNodes = [];
    function put(text, slot, start, end) {
      if (!text || !slot || !slot.parent) return;
      slot = styleSafeSlot(unit, slot);
      var fragment = document.createDocumentFragment();
      var leaves;
      if (unit.inlineResult) {
        leaves = appendInlineRange(fragment, unit, stripped, start, end);
        if (text.length > end - start) {
          var suffix = document.createTextNode(text.slice(end - start));
          fragment.appendChild(suffix); leaves.push(suffix);
        }
      }
      else { var plain = document.createTextNode(text); fragment.appendChild(plain); leaves = [plain]; }
      var roots = Array.prototype.slice.call(fragment.childNodes);
      if (isolate) {
        var span = document.createElement('span');
        span.className = 'dt-dir';
        DT.direction.applyTargetNode(span, unit.el, dmeta.lang, true);
        span.setAttribute('data-dt-dir', 'wrap');
        span.appendChild(fragment);
        roots = [span];
      }
      roots.forEach(function (node) {
        insertNode(node, slot.parent, slot.before, ops);
        inserted.push(node);
      });
      leaves.forEach(function (node) { nodeUnit.set(node, unit); ownNodes.add(node); ownWrites.set(node, node.nodeValue); targetNodes.push(node); });
    }
    // 第 0 段在序列第一个之前；无原子的格式段仍复用同一个 gap 插入路径。
    put(texts[0], seq.length ? seq[0].beforeSlot : emptySlot, textStarts[0], textEnds[0]);
    for (var n = 1; n < texts.length; n += 1) put(texts[n], seq[n - 1].afterSlot, textStarts[n], textEnds[n]);
    keep.forEach(function (k, index) {
      if (unit.inlineResult && k.kind === 'link') {
        var label = inlineLabel(unit, unit.inlineResult, index);
        if (label !== k.text && writeVisibleLabel(k.el, label, ops, saved)) {
          // 已写入模型返回的链接标签（可能嵌在 <span>/<sup> 里）。
        } else relabelAtom(k, ops, saved);
      } else if (k.kind === 'xref' || k.kind === 'link') relabelAtom(k, ops, saved);
      tokensOf(k.el).forEach(function (token) { if (token.node) targetNodes.push(token.node); });
    });
    hideEmptyFormatShells(unit, ops);
    seq.forEach(function (item) {
      if (item.nl || item.br) targetNodes.push(item.node);
    });
    rememberTargetNodes(unit, targetNodes);
    // 只给新插入的译文段加目标语言字体壳；原子链接 / 引用标签不动。
    inserted.forEach(function (node) {
      if (!node || !node.parentNode) return;
      if (node.nodeType === 3) {
        DT.fonts.wrapText(node, unit, ops);
        return;
      }
      if (node.nodeType !== 1) return;
      var walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      var list = [];
      for (var tn = walker.nextNode(); tn; tn = walker.nextNode()) {
        if (/\S/.test(tn.nodeValue || '')) list.push(tn);
      }
      list.forEach(function (one) {
        DT.fonts.wrapText(one, unit, ops);
      });
    });

    var targetMap = DT.targetMapOf(unit);
    var rendered = targetMap ? targetMap.text : shownTextOf(unit.el);
    var item = { el: unit.el, nodes: saved, collapsed: [], src: unit.text, lines: DT.splitLines(unit.text), aligned: true };
    DT.replaced.push(item);
    setAttr(unit.el, 'data-dt-replaced', '1', ops);
    if (unit.whole) {
      setAttr(unit.el, 'data-dt-src', '1', ops);
      setAttr(unit.el, 'data-dt-sig', unit.sig, ops);
    }
    unit.citeMode = mode;
    unit.renderMode = 'cited';
    unit.targetNode = null;
    unit.renderedText = rendered;
    unit.citedInserted = inserted;
    fillSnapshot(unit);
    pushRendered({ unit: unit, mode: 'cited', ops: ops, saved: saved, replaced: item });
    linkUnit(unit);
    record('replace', null, unit.el, rendered, area, unit.citeMode);
    return true;
  }

  // 在既有 gap 渲染中加入有限格式；目标范围完全来自严格协议，不按文字长度猜对应。
  function appendInlineRange(parent, unit, text, start, end) {
    var result = unit.inlineResult;
    var formats = unit.formats || [];
    var ranges = result && !result.formatMissing ? result.ranges.filter(function (r) {
      var f = formats[r.id - 1];
      return f && f.kind !== 'link' && r.end > start && r.start < end;
    }) : [];
    var boundaries = [start, end];
    ranges.forEach(function (r) {
      boundaries.push(Math.max(start, r.start));
      boundaries.push(Math.min(end, r.end));
    });
    boundaries.sort(function (a, b) { return a - b; });
    var seen = [];
    boundaries.forEach(function (p) { if (!seen.length || p !== seen[seen.length - 1]) seen.push(p); });
    var nodes = [];
    for (var i = 1; i < seen.length; i += 1) {
      var a = seen[i - 1];
      var b = seen[i];
      if (b <= a) continue;
      var active = ranges.filter(function (r) { return r.start <= a && r.end >= b; });
      active.sort(function (x, y) {
        if (x.start !== y.start) return x.start - y.start;
        if (x.end !== y.end) return y.end - x.end;
        // 同范围时根据模型协议的父关系维持源嵌套。
        if (y.parent === 'f' + x.id) return -1;
        if (x.parent === 'f' + y.id) return 1;
        return x.id - y.id;
      });
      var target = parent;
      active.forEach(function (r) {
        var f = formats[r.id - 1];
        var tag = /^(strong|b|em|i|small|sup|sub|code)$/.test(f.tag) ? f.tag : 'span';
        var span = document.createElement(tag);
        span.setAttribute('data-dt-format', unit.id);
        var st = f.style || {};
        span.style.setProperty('display', 'inline', 'important');
        if (st.weight) span.style.setProperty('font-weight', st.weight, 'important');
        if (st.fontStyle) span.style.setProperty('font-style', st.fontStyle, 'important');
        if (st.size) span.style.setProperty('font-size', st.size, 'important');
        if (st.vertical) span.style.setProperty('vertical-align', st.vertical, 'important');
        if (st.code) span.style.setProperty('font-family', 'monospace', 'important');
        target.appendChild(span);
        nodeUnit.set(span, unit);
        target = span;
      });
      var node = document.createTextNode(text.slice(a, b));
      target.appendChild(node);
      ownNodes.add(node);
      ownWrites.set(node, node.nodeValue);
      nodeUnit.set(node, unit);
      nodes.push(node);
    }
    return nodes;
  }

  function rememberTargetNodes(unit, nodes) {
    var seen = new Set();
    unit.targetNodes = nodes.filter(function (node) {
      if (!node || seen.has(node)) return false;
      seen.add(node);
      return true;
    }).sort(function (a, b) {
      if (a === b) return 0;
      return a.compareDocumentPosition(b) & 4 ? -1 : 1;
    });
    unit.targetValues = unit.targetNodes.filter(function (node) { return node.nodeType === 3; }).map(function (node) { return { node: node, value: node.nodeValue }; });
  }

  DT.targetMapOf = function (unit) {
    if (!unit || !unit.targetNodes) return null;
    var text = '';
    var chars = [];
    unit.targetNodes.forEach(function (node) {
      if (!node.isConnected) return;
      if (node.nodeType === 1 && tagOf(node) === 'BR') { text += '\n'; chars.push({ br: node }); return; }
      var value = String(node.nodeValue || '');
      for (var i = 0; i < value.length; i += 1) chars.push({ node: node, off: i });
      text += value;
    });
    return { text: text, chars: chars };
  };

  // 上标引用的副本：href / 上标样式 / aria-label / title 照旧，点了照样跳到参考文献；
  // 去掉 id（页面上不能有重复 id，参考文献里的返回链接仍指向原上标）
  function citeClone(el) {
    var copy = el.cloneNode(true);
    var all = [copy].concat(Array.prototype.slice.call(copy.querySelectorAll('*')));
    all.forEach(function (node) {
      node.removeAttribute('id');
      Array.prototype.slice.call(node.attributes).forEach(function (attr) {
        if (/^data-dt-/.test(attr.name)) node.removeAttribute(attr.name);
      });
    });
    copy.setAttribute('data-dt-cite', '1');
    return copy;
  }

  // 原子的副本：图表链接的标签按 xrefLabel 换成「图 1」（只有一个文本节点时）
  function atomClone(k, unit, index) {
    var copy = citeClone(k.el);
    var labelTarget = DT.state.targetCode || DT.state.target;
    var label = k.kind === 'xref' ? xrefLabel(k.text, labelTarget) : k.kind === 'link' ? linkLabel(k.text, labelTarget) : '';
    if (unit && unit.inlineResult && k.kind === 'link') label = inlineLabel(unit, unit.inlineResult, index);
    if (label) writeVisibleLabel(copy, label, null, null);
    return copy;
  }

  // 双语译文节点里按标记位置放回引用副本，notranslate 的保留区照旧放原文文字。
  // 有引用的标记丢了：一个副本都不放（原段落里的引用完好，不在译文里猜位置），译文只留文字
  function fillCited(node, unit, rawMarks) {
    var keep = unit.keep;
    var marks = recoverXrefMarks(unit, rawMarks);
    marks.at = marks.at.slice();
    // 结构性原子（引用 / 图表链接 / 混合段落里的普通链接）在双语译文里放可点击的副本；
    // 其中有标记丢了就一个副本都不放（原段落里的都完好），notranslate / 提及照旧放原文文字
    var citesOk = keep.every(function (k, i) {
      return !isStructKeep(k) || marks.at[i] >= 0;
    });
    var items = [];
    keep.forEach(function (k, i) {
      if (marks.at[i] < 0 || (isStructKeep(k) && !citesOk)) return;
      items.push({ at: marks.at[i], k: k, i: i });
    });
    items.sort(function (a, b) {
      return a.at - b.at || a.i - b.i;
    });
    node.textContent = '';
    var pos = 0;
    var prev = -1;
    items.forEach(function (item) {
      var seg = marks.stripped.slice(pos, item.at);
      if (prev >= 0 && !/\S/.test(seg)) seg += citeSeparator(unit, prev, item.i);
      if (seg) {
        if (unit.inlineResult) appendInlineRange(node, unit, marks.stripped, pos, item.at);
        else node.appendChild(document.createTextNode(seg));
      }
      node.appendChild(isStructKeep(item.k) ? atomClone(item.k, unit, item.i) : document.createTextNode(item.k.text));
      pos = item.at;
      prev = item.i;
    });
    var tail = marks.stripped.slice(pos);
    if (tail) {
      if (unit.inlineResult) appendInlineRange(node, unit, marks.stripped, pos, marks.stripped.length);
      else node.appendChild(document.createTextNode(tail));
    }
    if (!unit.citeMode) unit.citeMode = citesOk ? 'exact' : 'dropped';
    return node.textContent;
  }

  // 含振假名的段落（仅译文模式）：不把中文写进 ruby/rb/rt/rp。
  // 做法是保留原始 DOM：清空本段落的正文文本节点、隐藏本段落关联的 rt/rp、
  // 在段落锚点插入独立译文节点。还原时文本、注音显隐、锚点一起恢复。
  function injectRuby(unit, text, lang, area) {
    var ops = [];
    var saved = [];
    var edits = [];
    var hasKeep = !!(unit.keep && unit.keep.length);
    (unit.groups.filled || []).forEach(function (g) {
      (g.pieces || []).forEach(function (p) {
        if (hasKeep && keepIndexOf(unit, p.node) >= 0) return;
        edits.push({ node: p.node, start: p.start, end: p.end, value: '' });
      });
    });
    if (edits.length) saved = applyEditsTx(edits, ops);
    if (hasKeep) hideKept(unit, ops);
    (unit.ruby || []).forEach(function (node) {
      setStyle(node, 'display', 'none', ops);
      setAttr(node, 'data-dt-rt-hidden', '1', ops);
    });
    var target = makeNode(unit.el, text, lang, true, 'translation');
    if (unit.inlineResult && !(unit.keep && unit.keep.length)) {
      target.textContent = '';
      appendInlineRange(target, unit, unit.inlineResult.stripped, 0, unit.inlineResult.stripped.length);
    }
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
    fillSnapshot(unit);
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
    if (unit.inlineProtocol === 'v1' && inlineMetadataChanged(unit)) return true;
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
      // cited：混合行内渲染（引用 / 图表链接原地保留、译文是新文本节点）同样是原地改写，站点改了也要放回
      if (rec.mode !== 'replace' && rec.mode !== 'ruby' && rec.mode !== 'cited') return;
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
    if (!attachKeep(unit, el, hasKeepInside(el))) return null;
    fillSnapshot(unit);
    return unit;
  }

  // 注入结果分类（unit.injectResult / DT.lastInject）。DT.inject 仍返回 true / false（兼容旧调用），
  // main.js 的 tryInject 按 code 决定怎么记：
  //   success          已写进页面
  //   already-rendered 这一段已经有译文 / 已标记翻译过（不用再注入）
  //   not-applicable   单元本身就是引用 / 提及链接，没有可改写的正文
  //   empty            去掉标记后没有译文
  //   stale-generation 旧代际晚到的结果（还原 / 模式切换后）
  //   stale-source     源节点已经不在页面上（页面更新了，需要重新收集）
  //   unsafe-structure 当前 DOM 结构没法安全写回（注音 / pre-wrap 分行 / 祖先链接里的混排 / 渲染器拒绝）
  //   invalid-placement 引用 / 链接在译文里的位置定不下来（行数对不上 / 没有句子）
  function injectOutcome(unit, ok, code, reason) {
    var res = { code: code, reason: reason || '' };
    if (unit) unit.injectResult = res;
    DT.lastInject = { code: code, reason: res.reason, text: unit ? previewText(unit.text) : '' };
    if (!ok && code !== 'stale-generation') DT.log('inject ' + code + ':', res.reason, unit ? previewText(unit.text) : '');
    return ok;
  }

  // 一个单元当前的源 DOM 状态（文字 / 子元素 class / style / 显隐）：注入失败后，状态没变就不再重试同一段
  DT.unitStamp = function (unit) {
    return unit && unit.el ? sourceSignature(unit.el) : '';
  };

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
    if (unit) unit.injectResult = null;
    if (unit && unit.inlineIssue) return injectOutcome(unit, false, 'invalid-placement', 'inline-' + unit.inlineIssue);
    if (!unit || !unit.el || !unit.el.isConnected) return injectOutcome(unit, false, 'stale-source', 'disconnected');
    // 根节点本身就是文献引用 / 用户名提及（独立链接或 citation span）：没有可安全改写的正文，原样保留。
    if (!(unit.keep && unit.keep.length) && (isCitationEl(unit.el) || isMentionEl(unit.el))) {
      return injectOutcome(unit, false, 'not-applicable', 'root-is-atom');
    }
    // 保留区：text 可以带 <kN> 标记（模型原样回来的），也可以不带（按原文逐字找位置）
    var inline = null;
    if (unit.inlineProtocol === 'v1') {
      inline = inspectInline(unit, text);
      if (!inline.ok) return injectOutcome(unit, false, 'invalid-placement', 'inline-' + inline.reason);
      if (inlineMetadataChanged(unit)) return injectOutcome(unit, false, 'stale-source', 'inline-metadata-changed');
      unit.inlineResult = inline;
      unit.formatMode = inline.formatMissing ? 'plain-fallback' : 'mapped';
    }
    var segs = null;
    var cited = null; // 结构性原子（引用 / 图表链接 / 混合段落普通链接）在译文里的落点（见 injectCited）
    if (inline) {
      text = DT.inlineText(unit, text);
      if (!(unit.ruby && unit.ruby.length && !(unit.keep && unit.keep.length))) cited = { stripped: inline.stripped, at: (unit.keep || []).map(function (k, i) {
        var a = inline.atoms.filter(function (atom) { return atom.id === i + 1; })[0];
        return a ? a.at : -1;
      }) };
    } else if (text && unit.keep && unit.keep.length) {
      if (hasStructAtom(unit)) cited = DT.units.keepMarks(text, unit.keep, unit.text);
      var kept = DT.units.keepParse(text, unit.keep, unit.text);
      text = kept.text;
      segs = kept.segs;
    }
    if (!text) return injectOutcome(unit, false, 'empty', 'no-text');
    unit.align = align;
    if (unit.gen !== DT.generation) return injectOutcome(unit, false, 'stale-generation', 'old-generation');
    var rec = findRenderedFor(unit.el, unit);
    var refused =
      rec && stillOurs(rec)
        ? 'already-rendered' // 防重复注入
        : unit.whole && unit.el.hasAttribute('data-dt-src')
          ? 'marked-translated'
          : // 防御：站点可能克隆节点并保留属性，这里再确认一次没插过
            unit.whole && unit.el.querySelector && unit.el.querySelector(':scope > [data-dt-target]')
            ? 'target-exists'
            : '';
    // 收集和注入对这一段的看法不一致：调用方会把它记成已处理，这里留下原因方便查
    if (refused) return injectOutcome(unit, false, 'already-rendered', refused);

    if (DT.direction && !unit.sourceDir) unit.sourceDir = DT.direction.sourceDir(unit.el, unit.text);
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

    // 普通行内链接不能因为写回第一个文本节点而吞掉整段译文 / 把链接扩到整段。
    // 带引用 / 图表链接的单元里，普通链接本身就是原子（见 keepRangesOf），交给混合行内渲染，不走这里；
    // 只有普通链接的单元无法安全原地切分时降级成双语（已知限制，见 HANDOFF §9）。
    if ((!cited || (inline && !hasStructAtom(unit))) && replaceMode && area === 'content' && hasUnsafeInlineLink(unit)) {
      var outerLink = unit.el.closest && unit.el.closest('a');
      if (outerLink && outerLink !== unit.el) return injectOutcome(unit, false, 'unsafe-structure', 'inside-ancestor-link');
      if (DT.state.mode === 'translation') {
        // 仅译文绝不因为链接结构退回双语：能在采集阶段识别的链接已经是 cited；
        // 剩下无法安全拆分的段落保持原文并明确失败，等站点/结构变化后再重试。
        unit.linkFallback = 'failed';
        if (DT.debugStats) DT.debugStats.linkFallbackCount += 1;
        return injectOutcome(unit, false, 'unsafe-structure', 'unsafe-inline-link');
      }
      unit.linkFallback = 'dual';
      replaceMode = false;
    }
    var ok;
    var checkpoint = tx.length;
    var renderedCheckpoint = rendered.length;
    var replacedCheckpoint = DT.replaced.length;
    var renderError = null;
    renderFrames += 1;
    try {
      if (cited) ok = injectCited(unit, cited, text, lang, area, replaceMode);
      else if (replaceMode) ok = unit.ruby && unit.ruby.length ? injectRuby(unit, text, lang, area) : injectReplace(unit, text, area, segs);
      else ok = injectDual(unit, text, lang, area);
    } catch (err) {
      renderError = err;
      ok = false;
    } finally {
      if (!ok) {
        while (rendered.length > renderedCheckpoint) dropRendered(rendered[rendered.length - 1]);
        undoOps(tx.slice(checkpoint));
        tx.length = checkpoint;
        DT.replaced.length = replacedCheckpoint;
        if (targetRegistry.get(unit.id) === unit.targetNode) targetRegistry.delete(unit.id);
        unit.targetNode = null;
        unit.targetNodes = null;
        unit.targetValues = null;
        unit.citedInserted = null;
      }
      renderFrames -= 1;
      if (compactPending) compactTx();
    }
    if (renderError) {
      DT.log('inject rollback', renderError);
      return injectOutcome(unit, false, 'unsafe-structure', 'inline-render-exception');
    }
    if (ok) return injectOutcome(unit, true, 'success', unit.citeMode || unit.renderMode || '');
    var why = unit.injectResult;
    return injectOutcome(unit, false, why ? why.code : 'unsafe-structure', why ? why.reason : 'renderer-refused');
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
      styleBoundaryAware: DT.styleBoundaryAware || 0,
      styleInspector: typeof DT.inspectTextStyle,
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
        u.alreadyTarget = DT.looksLikeTarget(text, DT.state.target, DT.state.langInfo);
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

      // 和 walk() 第 2 步同一判据，诊断里的单元才和真实收集一致
      var breaks = own ? flowBreaks(el) : [];
      if (breaks.length) {
        reportRanges(el, flowTokens(el, breaks), false);
        for (var bi = 0; bi < breaks.length; bi += 1) walkDiag(breaks[bi]);
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

  // 可选局部样式诊断：在控制台执行 __DT.inspectTextStyle('异常中文')。
  // 返回命中文本节点的实际 computed style、祖先链、写入前快照和当前 DOM 摘要。
  DT.inspectTextStyle = function (needle, limit) {
    var max = Math.max(1, Math.min(50, Number(limit) || 20));
    var wanted = typeof needle === 'string' ? needle : '';
    var direct = needle && needle.nodeType === 3 ? needle : null;
    var matches = [];
    function record(node) {
      if (matches.length >= max || !node || node.nodeType !== 3) return;
      if (direct ? node !== direct : (wanted && String(node.nodeValue).indexOf(wanted) < 0)) return;
      if (!direct && !/\S/.test(node.nodeValue)) return;
      var parent = node.parentElement;
      var unit = nodeUnit.get(node);
      if (!unit && parent && parent.closest) {
        var box = parent.closest('[data-dt-replaced]');
        var rec = box ? DT.replacedOf(box) : null;
        unit = rec && rec.unit;
      }
      var before = unit && unit.styleEvidence ? unit.styleEvidence : null;
      var range = document.createRange();
      range.selectNodeContents(node);
      var rect = range.getBoundingClientRect();
      matches.push({
        text: previewText(node.nodeValue),
        fullText: String(node.nodeValue).slice(0, 300),
        parent: diagnosticStyle(parent),
        style: parent ? diagnosticStyle(parent) : null,
        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
        chain: diagnosticChain(node, 20),
        before: before,
        afterHtml: unit && unit.el && unit.el.outerHTML ? unit.el.outerHTML.slice(0, 5000) : (parent && parent.outerHTML ? parent.outerHTML.slice(0, 5000) : ''),
        unit: unit ? {
          mode: unit.renderMode || '',
          whole: !!unit.whole,
          src: previewText(unit.text)
        } : null
      });
    }
    var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    for (var n = direct || walker.nextNode(); n; n = direct ? null : walker.nextNode()) record(n);
    return {
      version: DT.VERSION,
      url: location.href,
      mode: DT.state.mode,
      target: DT.state.target,
      needle: wanted || (direct ? '[TextNode]' : ''),
      matches: matches
    };
  };

  // 对外：SPA 路由切换后的"体检"。
  // 不清空整页译文（那会造成整页闪烁重翻），只撤掉那些源文本确实变了的段落。
  DT.refreshStale = function () {
    if (DT.shadow && DT.shadow.prune) DT.shadow.prune();
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
    if (DT.shadow && DT.shadow.prune) DT.shadow.prune();
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

  // 兜底清理要覆盖开放 Shadow DOM：document.querySelectorAll 不进 shadow root。
  function queryAllDeep(selector) {
    var out = Array.prototype.slice.call(document.querySelectorAll(selector));
    if (DT.shadow && DT.shadow.all) {
      out = out.concat(DT.shadow.all(selector));
    }
    var seen = new Set();
    return out.filter(function (node) {
      if (!node || seen.has(node)) return false;
      seen.add(node);
      return true;
    });
  }

  // 对外：还原原文。逆序回放 RenderTransaction：
  // 只撤销仍是我们写入的值 / 仍是我们的节点；站点已经改过 / 删除的，保留站点的新状态。
  DT.restore = function () {
    if (DT.debugStats) DT.debugStats.restoreCount += 1;
    if (DT.shadow && DT.shadow.reset) DT.shadow.reset();
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
    var folded = queryAllDeep('[data-dt-collapsed]');
    for (var f = 0; f < folded.length; f += 1) folded[f].removeAttribute('data-dt-collapsed');
    var hidden = queryAllDeep('[data-dt-rt-hidden],[data-dt-keep-hidden]');
    for (var h = 0; h < hidden.length; h += 1) {
      hidden[h].removeAttribute('data-dt-rt-hidden');
      hidden[h].removeAttribute('data-dt-keep-hidden');
      if (hidden[h].style && hidden[h].style.display === 'none') hidden[h].style.display = '';
    }

    // 兜底：局部方向壳的记录丢了也要把原文本节点放回原位，再移除壳
    var dirWraps = queryAllDeep('[data-dt-dir="wrap"]');
    for (var dw = 0; dw < dirWraps.length; dw += 1) {
      var wrap = dirWraps[dw];
      if (!wrap.parentNode) continue;
      while (wrap.firstChild) wrap.parentNode.insertBefore(wrap.firstChild, wrap);
      wrap.remove();
    }

    var formatWraps = queryAllDeep('[data-dt-format]');
    for (var fw = 0; fw < formatWraps.length; fw += 1) formatWraps[fw].remove();

    // 移除追加的译文节点
    var targets = queryAllDeep('[data-dt-target]');
    for (var t = 0; t < targets.length; t += 1) {
      if (targets[t].closest && targets[t].closest('[data-dt-ui]')) continue;
      targets[t].remove();
    }

    // 清掉标记（局部段落 / own 单元的容器只有 data-dt-replaced，没有 data-dt-src）
    var sources = queryAllDeep('[data-dt-src],[data-dt-replaced]');
    for (var j = 0; j < sources.length; j += 1) {
      sources[j].removeAttribute('data-dt-src');
      sources[j].removeAttribute('data-dt-sig');
      sources[j].removeAttribute('data-dt-replaced');
    }

    DT.placements = [];
    DT.state.translated = 0;
    DT.state.failed = 0;
    DT.state.skipped = 0;
    DT.state.renderFailed = 0;
    DT.state.lastRenderError = '';
    DT.state.total = 0;
  };
})();
