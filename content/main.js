// 内容脚本：调度层（开关 / 批处理 / 动态补翻 / 快捷键）
(function () {
  'use strict';

  var DT = window.__DT;
  if (!DT) return;
  // 允许被 popup / 快捷键重复注入：只初始化一次
  if (DT.__booted) return;
  DT.__booted = true;

  var observer = null;
  var chromeObserver = null;
  var debounceTimer = 0;
  var lastUrl = location.href;
  var urlTimer = 0;
  var running = false;
  // 每轮翻译一个编号。还原 / 重建 / 看门狗复位时把编号 +1，
  // 旧一轮之后才回来的结果一律丢弃，也不会再改动 running 等状态。
  var runId = 0;
  // 最近一次有进展（批次返回）的时间。看门狗看的是"多久没进展"，不是"总共跑了多久"，
  // 否则长页面正常翻到 90 秒就会被误杀。
  var lastBeat = 0;
  var dirty = false; // 翻译过程中页面又变了
  // 译文与原文相同 / 模型返回空的单元：按「元素 → 段落键 → 当时的源文本」记，内容没变就不再重复送翻和计数
  var settled = new WeakMap();
  // 翻译失败的单元按段落各自退避：失败后等 5s / 15s / 45s 再试，第 4 次失败就放弃，
  // 直到内容变了、用户手动重翻或改了设置。
  // 以前失败段在每次点击、悬停、页面变动时都整页重发，遇到限流（429）只会越试越被限；
  // 也不能整页一起退避 —— 一批固定出错的段落会把新加载内容的翻译一起拖住。
  // 退避表本身在 core.js 的 DT.RETRY_DELAYS / DT.nextRetry（纯函数，自检可测）
  var failures = new WeakMap(); // el → Map(段键 → { text, count, until })
  // 等译文期间原文又被站点改掉的次数（DT.sourceChanged）。连续 CHURN_MAX 次就不再翻这个元素：
  // 计时器、实时行情这类一直在变的内容，否则每变一次就重发一次请求
  var churn = new WeakMap(); // el → Map(段键 → 连续被站点改写次数)
  // 模型给了译文、但写不进页面（DOM 结构不支持 / 落点定不下来）的单元：{ text, stamp, code, reason }。
  // 不算「跳过」也不算「已处理」：源文本和 DOM 状态（DT.unitStamp）都没变就不再收、不再请求；
  // 页面变了才重新收集（译文在后台缓存里，重新注入不会再调用模型）
  var renderFails = new WeakMap();
  // Only current order failures need an iterable index, so framework node
  // replacement can retire their visible counts. No source text is copied here.
  var orderFailureRefs = [];
  // 模型回包本身不可用（wrong-language / empty-output / runaway-output）：
  // 与 DOM 注入失败分开计数，页面和源文本都没变时不重发、不进入付费退避。
  var outputFails = new WeakMap();
  // 仅存储在内存里的开发诊断摘要：不保存正文 / 回包 / API Key，只保存失败类别、源文长度、
  // 标记数量和本地时间，供 dt:diagnose 关联“模型错误”与“DOM 注入错误”。
  var failureLog = [];
  var FAILURE_LOG_MAX = 20;
  var CHURN_MAX = 3;
  var retryTimer = 0;
  var retryAt = 0;
  // 用户滚动 / 窗口大小变了：下一次取批前重新按离屏幕的距离排序
  var viewMoved = true;
  var lastScrollY = -1;
  var lastViewH = -1;
  var lazyTimer = 0;

  // 懒翻译的范围（屏幕上方 1 屏到下方 2 屏）在 core.js：DT.LAZY_ABOVE / DT.LAZY_BELOW
  function rectOfUnit(unit) {
    if (unit.__rect) return unit.__rect;
    var rect = DT.rectOfUnit ? DT.rectOfUnit(unit) : unit.el.getBoundingClientRect();
    unit.__rect = rect;
    return rect;
  }
  function nearViewUnit(unit, viewH) {
    return DT.nearView(rectOfUnit(unit), viewH);
  }

  // 0.9.2：一个 HTMLElement 可以有多个 ParagraphUnit（同一容器里的多段小说）。
  // settled / failures / churn 不能只按元素记，否则 A 段的退避 / 抖动会误伤 B 段。
  // 键 = 段序号：状态表按容器段落位置隔离，同时不会因文本不断变化而无限增长。
  function unitKey(unit) {
    if (!unit) return '';
    // 只按段序号，不用源文本签名：无限滚动 / 聊天页面不断换文本时，
    // 签名键会让每个历史文本各留一条状态，长时间运行会持续涨内存。
    // 失败记录里仍带 text，内容变了自然不会再命中旧的退避。
    return String(unit.index == null ? 0 : unit.index);
  }
  function unitState(map, unit) {
    var bucket = map.get(unit.el);
    return bucket ? bucket.get(unitKey(unit)) : undefined;
  }
  var MAX_UNIT_STATE = 5000;
  function setUnitState(map, unit, value) {
    var bucket = map.get(unit.el);
    if (!bucket) {
      bucket = new Map();
      map.set(unit.el, bucket);
    }
    bucket.set(unitKey(unit), value);
    // 同一个容器里无限追加段落时，状态表也要有上限（最早插入的先丢）
    while (bucket.size > MAX_UNIT_STATE) bucket.delete(bucket.keys().next().value);
  }
  function dropUnitState(map, unit) {
    var bucket = map.get(unit.el);
    if (bucket) bucket.delete(unitKey(unit));
  }

  function retireOrderFailure(keepRenderFailure) {
    DT.state.inlineOrderFailed = Math.max(0, (DT.state.inlineOrderFailed || 0) - 1);
    if (!keepRenderFailure) DT.state.renderFailed = Math.max(0, (DT.state.renderFailed || 0) - 1);
    DT.state.qualityWarnings = Math.max(0, (DT.state.qualityWarnings || 0) - 1);
    if (!DT.state.renderFailed) DT.state.lastRenderError = '';
    if (!DT.state.qualityWarnings) DT.state.lastQualityWarning = '';
  }

  function forgetOrderRef(unit) {
    var key = unitKey(unit);
    orderFailureRefs = orderFailureRefs.filter(function (ref) { return ref.el !== unit.el || ref.index !== key; });
  }

  function pruneOrderFailures() {
    orderFailureRefs = orderFailureRefs.filter(function (ref) {
      var failure = unitState(renderFails, ref);
      if (ref.el.isConnected && failure && failure.code === 'unsupported-inline-order') return true;
      retireOrderFailure(!!failure && failure.code !== 'unsupported-inline-order' && ref.el.isConnected);
      if (failure && failure.code === 'unsupported-inline-order') dropUnitState(renderFails, ref);
      return false;
    });
  }

  // 滚动 / 改窗口大小：待翻队列按新位置重排；懒翻译时还要补翻新进入范围的内容。
  // 用节流不用防抖：一直往下滚时也要边滚边补，不能等停下来才翻
  function onViewChange() {
    viewMoved = true;
    if (!DT.state.enabled || !DT.state.config || DT.state.config.lazy === false) return;
    if (lazyTimer) return;
    lazyTimer = setTimeout(function () {
      lazyTimer = 0;
      if (!DT.state.enabled) return;
      if (running) {
        dirty = true;
        return;
      }
      translatePage({ silent: true });
    }, 400);
  }

  function applyChrome() {
    var html = document.documentElement;
    if (!html) return;
    html.setAttribute('data-dt', DT.state.enabled ? 'on' : 'off');
    html.setAttribute('data-dt-mode', DT.state.mode || 'dual');
    html.setAttribute('data-dt-theme', DT.state.theme || 'underline');
  }

  // Aeon（Next.js）hydration 会清掉扩展写在 <html> 上的 data-dt，
  // 导致 inject.css 里的主题 / 悬停 / 归一化规则整体失效。属性被删后补回；
  // 只在值不对时写，避免 MutationObserver 自己触发自己。
  function keepChromeState() {
    var html = document.documentElement;
    if (!html) return;
    if (
      html.getAttribute('data-dt') !== (DT.state.enabled ? 'on' : 'off') ||
      html.getAttribute('data-dt-mode') !== (DT.state.mode || 'dual') ||
      html.getAttribute('data-dt-theme') !== (DT.state.theme || 'underline')
    ) {
      applyChrome();
    }
  }

  // 上一次按配置（含站点规则）算出的显示方式 / 目标语言。
  // 配置广播、换网址时只有这两个值真的变了才跟着改：没变就保留本页自己的选择（弹窗 / 悬浮入口切的）。
  // 以前每次都直接覆盖 DT.state，翻译中的页面不重建，同一页就混着双语和仅译文、或混着两种语言
  var cfgMode = null;
  var cfgTarget = null;
  var debugStats = {
    startOverCount: 0,
    restoreCount: 0,
    contextChangedCount: 0,
    incrementalScanCount: 0,
    injectDualCount: 0,
    linkFallbackCount: 0
  };
  var debugReasons = [];
  function noteDebug(reason, extra) {
    if (debugReasons.length >= 24) debugReasons.shift();
    debugReasons.push({ reason: String(reason || ''), extra: extra || '', at: Date.now() });
  }
  DT.debugStats = debugStats;
  DT.debugReasons = debugReasons;
  DT.debugReset = function () {
    Object.keys(debugStats).forEach(function (key) { debugStats[key] = 0; });
    debugReasons.length = 0;
  };
  DT.debugSnapshot = function () {
    return { stats: Object.assign({}, debugStats), reasons: debugReasons.slice(-12) };
  };
  var contextDirty = true;
  var renderedContextScopes = [];

  // 内容脚本不能 import 配置模块。这两个纯函数与 lib/config.js 有差分测试。
  function professionalProfileFor(cfg) {
    var value = cfg || {};
    if (value.professionalProfile === 'medical' || value.professionalProfile === 'general') return value.professionalProfile;
    return value.medicalMode === true ? 'medical' : 'general';
  }
  function professionalOptions(value) {
    var options = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    var requests = Number(options.maxReviewRequests === undefined ? 1 : options.maxReviewRequests);
    return {
      quality: ['fast', 'balanced', 'strict'].indexOf(options.quality) >= 0 ? options.quality : 'balanced',
      subdomain: typeof options.subdomain === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(options.subdomain) ? options.subdomain : 'auto',
      maxReviewRequests: isFinite(requests) ? Math.max(0, Math.min(3, Math.floor(requests))) : 1
    };
  }
  function professionalStrategy(cfg) {
    var options = professionalOptions(cfg && cfg.professionalOptions);
    return JSON.stringify([professionalProfileFor(cfg), options.quality, options.subdomain, options.maxReviewRequests]);
  }
  function contextProtectedSelector() {
    var cfg = DT.state.config;
    var site = cfg && cfg.page && cfg.page.site;
    var selectors = site && site.excludeSelectors;
    return '.notranslate,.no-translate,[translate="no"]' + (selectors && selectors.length ? ',' + selectors.join(',') : '');
  }
  function protectedContextNode(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      for (var node = el; node; node = node.parentElement) {
        if (node.matches && node.matches(contextProtectedSelector())) return true;
      }
      return false;
    } catch (err) { return true; }
  }
  function contextTitle() {
    // Shadow content has a separate tree; the adapter may discover its protected
    // nodes only during collection, after this snapshot has already been read.
    if (DT.shadow && DT.shadow.active && DT.shadow.active()) return '';
    var text = String(document.title || '').replace(/\s+/g, ' ').trim();
    if (!text || !document.querySelectorAll) return text;
    // A title may repeat only part of a protected name/account. There is no
    // trustworthy DOM range mapping into document.title, so omit this metadata
    // whenever protected content exists rather than trying substring redaction.
    var nodes;
    try { nodes = document.querySelectorAll(contextProtectedSelector()); } catch (err) { return ''; }
    if (nodes.length) return '';
    return text.replace(/\s+/g, ' ').trim().slice(0, 240);
  }

  // 上下文只读正文：导航、侧栏、表单、可编辑草稿、广告 / 评论容器、隐藏内容都不算正文。
  function contextSkippable(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.hidden) return true;
    if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return true;
    if (node.isContentEditable) return true;
    if (node.closest && node.closest('nav,footer,aside,form,[role="navigation"],[role="complementary"],[role="contentinfo"],[role="textbox"],[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"],[data-dt-ui]')) return true;
    var signature = String(node.className || '') + ' ' + String(node.id || '');
    if (/(^|[\s_-])(comment|comments|reply|replies|advert|ads?|sidebar|cookie|promo|sponsor)([\s_-]|$)/i.test(signature)) return true;
    var cs = null;
    try {
      cs = window.getComputedStyle(node);
    } catch (err) {
      cs = null;
    }
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.contentVisibility === 'hidden')) return true;
    return false;
  }

  function contextText(el, limit) {
    if (!el) return '';
    if (protectedContextNode(el)) return '';
    var replaced = DT.replacedOf && DT.replacedOf(el);
    if (replaced && typeof replaced.src === 'string') {
      // A flattened saved source no longer identifies protected characters. A
      // heading with such descendants is omitted rather than guessed back in.
      if (el.querySelector && el.querySelector(contextProtectedSelector())) return '';
      return replaced.src.slice(0, limit);
    }
    var text = '';
    function read(node) {
      if (!node || text.length >= limit) return;
      if (node.nodeType === 3) {
        text += String(node.nodeValue || '').slice(0, limit - text.length);
        return;
      }
      if (node.nodeType !== 1) return;
      if (protectedContextNode(node)) return;
      if (node.hasAttribute && (node.hasAttribute('data-dt-target') || node.hasAttribute('data-dt-ui') || node.getAttribute('aria-hidden') === 'true')) return;
      if (contextSkippable(node)) return;
      // 已替换的正文 / 标题 / 局部段落：上下文要读原 src，不能读页面上已经变成译文的文本。
      var replaced = DT.replacedOf && DT.replacedOf(node);
      if (replaced && typeof replaced.src === 'string') {
        if (node.querySelector && node.querySelector(contextProtectedSelector())) return;
        text += replaced.src.slice(0, Math.max(0, limit - text.length));
        return;
      }
      var children = node.childNodes || [];
      for (var i = 0; i < children.length && text.length < limit; i += 1) read(children[i]);
    }
    read(el);
    return text.replace(/\s+/g, ' ').trim();
  }

  // 相邻段落：只取同文章容器内、批次外、可见的正文块；按字符预算截断，绝不读全文。
  function collectAdjacentContext(units, root, batchText) {
    if (!root) return [];
    var out = [];
    var seen = Object.create(null);
    var total = 0;
    function add(candidate) {
      if (!candidate || candidate.nodeType !== 1 || candidate.tagName === 'ARTICLE' || candidate.tagName === 'MAIN' || candidate.tagName === 'BODY') return;
      // 标题已经在 headings 里作为参考；再次当作相邻正文会重复注入，也会挤占预算。
      if (/^H[1-6]$/.test(candidate.tagName || '')) return;
      if (candidate.querySelector && candidate.querySelector('article')) return;
      if (contextRoot(candidate) !== root) return;
      if (contextSkippable(candidate)) return;
      if (DT.areaOf && DT.areaOf(candidate) !== 'content') return;
      var text = contextText(candidate, 300);
      if (!text || text.length < 12 || total + text.length > 900) return;
      if (batchText.indexOf(text) >= 0 || seen[text]) return;
      seen[text] = 1;
      out.push(text);
      total += text.length;
    }
    (units || []).forEach(function (unit) {
      var el = unit && unit.el;
      if (!el) return;
      add(el.previousElementSibling);
      add(el.nextElementSibling);
    });
    return out.slice(0, 4);
  }
  function contextRoot(el) {
    return el && el.closest ? el.closest('article') || el.closest('main,[role="main"]') : null;
  }
  function pageContextRoot() {
    if (!document.querySelectorAll) return null;
    var articles = document.querySelectorAll('article');
    if (articles.length === 1) return articles[0];
    // 多论文列表不能把第一篇的章节标题当作整页的上下文。
    return articles.length ? null : document.querySelector('main,[role="main"]') || document.body;
  }
  function documentSnapshot(root) {
    var context = { title: contextTitle(), headings: [], abbreviations: {} };
    var scope = root || pageContextRoot();
    var headings = scope && scope.querySelectorAll ? scope.querySelectorAll('h1,h2,h3') : [];
    var budget = 600;
    for (var i = 0; i < headings.length && context.headings.length < 8 && budget > 0; i += 1) {
      var heading = headings[i];
      if (scope.tagName === 'ARTICLE' && contextRoot(heading) !== scope) continue;
      if (heading.closest && heading.closest('nav,footer,aside,[data-dt-ui],[aria-hidden="true"]')) continue;
      var text = contextText(heading, Math.min(120, budget));
      if (text && context.headings.indexOf(text) < 0) {
        context.headings.push(text);
        budget -= text.length;
      }
    }
    return context;
  }
  function documentFingerprint(context) {
    return JSON.stringify([context.title, context.headings]);
  }
  function contextChanged(snapshot) {
    if (DT.state.renderedContext !== undefined && DT.state.renderedContext !== documentFingerprint(snapshot)) return true;
    for (var i = 0; i < renderedContextScopes.length; i += 1) {
      var entry = renderedContextScopes[i];
      if (entry.root.isConnected !== false && documentFingerprint(documentSnapshot(entry.root)) !== entry.key) return true;
    }
    return false;
  }
  function rememberContextScope(root, snapshot) {
    if (!root) return;
    for (var i = 0; i < renderedContextScopes.length; i += 1) if (renderedContextScopes[i].root === root) return;
    renderedContextScopes.push({ root: root, key: documentFingerprint(snapshot) });
    if (renderedContextScopes.length > 16) renderedContextScopes.shift();
  }
  // 保守的长名(ABC)识别：从缩写末尾反向匹配各字母，首字母必须在单词开头。
  // 不猜测没有明确定义的缩写；定义只活在当前批次，不跨论文保存。
  function abbreviationLongName(prefix, abbreviation) {
    var chars = abbreviation.replace(/[^A-Z0-9]/g, '');
    var words = prefix.replace(/^[\s\S]*[.;:!?\n]/, '').trim().split(/\s+/);
    var candidate = words.slice(-Math.min(chars.length + 5, chars.length * 2)).join(' ');
    var at = candidate.length - 1;
    for (var ci = chars.length - 1; ci >= 0; ci -= 1) {
      var letter = chars.charAt(ci).toLowerCase();
      while (at >= 0 && (candidate.charAt(at).toLowerCase() !== letter || (ci === 0 && at > 0 && /[A-Za-z0-9]/.test(candidate.charAt(at - 1))))) at -= 1;
      if (at < 0) return '';
      if (ci) at -= 1;
    }
    var name = candidate.slice(at).trim();
    return name.length > chars.length + 2 && name.length <= 120 && /[\s-]/.test(name) && /^[A-Za-z][A-Za-z0-9\s-]+$/.test(name) ? name : '';
  }
  function collectDocumentContext(units, snapshot, opts) {
    var options = opts || {};
    var items = units || [];
    var root = null;
    var mixed = false;
    for (var ui = 0; ui < items.length; ui += 1) {
      var current = contextRoot(items[ui].el);
      if (ui && current !== root) mixed = true;
      if (!ui) root = current;
    }
    var base = snapshot || documentSnapshot(mixed ? null : root);
    var context = { title: base.title, headings: base.headings.slice(), abbreviations: {} };
    if (mixed) {
      context.headings = [];
      return context;
    }
    var batchText = items.map(function (unit) { return String(unit.text || ''); }).join('\n');
    var sources = [context.title].concat(context.headings);
    var visited = [];
    items.forEach(function (unit) {
      sources.push(String(unit.text || '').slice(0, 2400));
      // 只看相邻块，绝不读取 article/main/body 的全文。
      [unit.el && unit.el.previousElementSibling, unit.el && unit.el.nextElementSibling].forEach(function (nearby) {
        if (!nearby || nearby.tagName === 'ARTICLE' || nearby.tagName === 'MAIN' || nearby.tagName === 'BODY' || visited.indexOf(nearby) >= 0 || contextRoot(nearby) !== contextRoot(unit.el)) return;
        if (nearby.querySelector && nearby.querySelector('article')) return;
        visited.push(nearby);
        sources.push(contextText(nearby, 600));
      });
    });
    var definitions = Object.create(null);
    sources.forEach(function (source) {
      var re = /\(([A-Z][A-Z0-9-]{1,9})\)/g;
      var match;
      while ((match = re.exec(source))) {
        var abbreviation = match[1];
        if (!(new RegExp('(^|[^A-Za-z0-9])' + abbreviation + '([^A-Za-z0-9]|$)')).test(batchText)) continue;
        var name = abbreviationLongName(source.slice(Math.max(0, match.index - 180), match.index), abbreviation);
        if (!name) continue;
        if (definitions[abbreviation] === undefined) definitions[abbreviation] = name;
        else if (definitions[abbreviation].toLowerCase() !== name.toLowerCase()) definitions[abbreviation] = '';
      }
    });
    Object.keys(definitions).sort().slice(0, 8).forEach(function (key) {
      if (definitions[key]) context.abbreviations[key] = definitions[key];
    });
    if (options.adjacent) {
      var adjacent = collectAdjacentContext(items, root, batchText);
      if (adjacent.length) context.adjacent = adjacent;
    }
    return context;
  }
  DT.professionalContext = { collect: collectDocumentContext, snapshot: documentSnapshot, fingerprint: documentFingerprint, profile: professionalProfileFor, options: professionalOptions, strategy: professionalStrategy };

  async function loadConfig() {
    var rebuild = false;
    try {
      var res = await DT.send({ type: 'config:get' });
      if (res && res.ok && res.config) {
        var prevConfig = DT.state.config || {};
        DT.state.config = res.config;
        // 配置里的默认趣味风格只在本页还没有亲手选过时同步；
        // 用户在本页的下拉选择优先，配置广播不能覆盖，也不能改变已经生效的 style。
        if (!DT.state.selectedStyleExplicit && DT.STYLE_IDS.indexOf(res.config.funStyle) >= 0) {
          DT.state.selectedStyle = res.config.funStyle;
        }
        // 站点规则可以固定这个网站的显示方式 / 译文样式
        var site = res.config.page && res.config.page.site;
        var mode = (site && site.mode) || res.config.mode || 'dual';
        var incomingTarget = res.config.targetLang || 'zh-CN';
        var incomingInfo = res.config.activeLanguage || null;
        if (mode !== cfgMode) {
          cfgMode = mode;
          if (DT.state.mode !== mode) {
            DT.state.mode = mode;
            rebuild = true;
          }
        }

        // 配置里的目标语言与实际译文语言分开保存：删除正在使用的自定义语言时，
        // 配置回退 zh-CN，但页面上的旧译文仍保持原语言，等用户明确重译。
        DT.state.configTarget = incomingTarget;
        DT.state.configLangInfo = incomingInfo;

        // AI 开关 / 隐私状态立即反映到 status，不再等下一次请求回包。
        var aiWanted = res.config.aiContextEnabled === true;
        var privacyOn = res.config.privacyEnabled === true;
        var prevContextMode = DT.state.contextStatus && DT.state.contextStatus.mode;
        var nextContextMode = aiWanted ? 'ai' : 'off';
        var contextNeedsReset = !DT.state.contextStatus || prevContextMode !== nextContextMode ||
          (aiWanted && privacyOn && DT.state.contextStatus.omitted !== 'privacy') ||
          (aiWanted && !privacyOn && DT.state.contextStatus.omitted === 'privacy');
        if (contextNeedsReset) {
          DT.state.contextStatus = {
            mode: nextContextMode,
            omitted: aiWanted ? (privacyOn ? 'privacy' : 'pending') : '',
            chars: 0,
            items: { title: 0, headings: 0, abbreviations: 0, adjacent: 0 },
            pending: aiWanted
          };
        }
        if (!aiWanted || privacyOn) DT.state.contextStale = false;

        var prevCustoms = Array.isArray(prevConfig.customLanguages) ? prevConfig.customLanguages : [];
        var nextCustoms = Array.isArray(res.config.customLanguages) ? res.config.customLanguages : [];
        var activeWasCustom = String(DT.state.target || '').indexOf('cl_') === 0;
        var activeCustomRemoved = activeWasCustom && !nextCustoms.some(function (one) { return one && one.id === DT.state.target; });
        var targetChanged = incomingTarget !== cfgTarget || DT.state.targetPending;

        if (targetChanged) {
          cfgTarget = incomingTarget;
          if (DT.state.enabled && activeCustomRemoved && incomingTarget !== DT.state.target) {
            // 删除在用语言：不重建、不重新请求；停掉可能还在用旧配置的在途任务，
            // 已展示译文保持原语言，动态补翻暂停到用户明确重译。
            DT.state.targetPending = true;
            cancelRun();
          } else {
            if (DT.state.target !== incomingTarget) {
              DT.state.target = incomingTarget;
              rebuild = true;
            }
            DT.state.langInfo = incomingInfo;
            DT.state.targetCode = (incomingInfo && incomingInfo.code) || '';
            DT.state.targetPending = false;
            var renderLangSig = incomingInfo
              ? [incomingInfo.kind, incomingInfo.code, incomingInfo.script].join('|')
              : '';
            if (DT.state.renderedLangSig !== undefined && DT.state.renderedLangSig !== renderLangSig) rebuild = true;
            DT.state.renderedLangSig = renderLangSig;
          }
        } else if (!DT.state.targetPending) {
          // 配置目标没变：名称 / 说明 / 代码可能刚改过。名称和说明不重发；
          // 代码影响方向 / 字体，变化时按原规则重建。
          DT.state.langInfo = incomingInfo;
          DT.state.targetCode = (incomingInfo && incomingInfo.code) || '';
          var currentLangSig = incomingInfo
            ? [incomingInfo.kind, incomingInfo.code, incomingInfo.script].join('|')
            : '';
          if (DT.state.renderedLangSig !== undefined && DT.state.renderedLangSig !== currentLangSig) rebuild = true;
          DT.state.renderedLangSig = currentLangSig;
        }

        // 医学模式改变提示词和术语，已注入的普通译文不能继续冒充专业译文。
        // 比较「当前页面实际是用哪种模式翻的」而不是上一次 loadConfig：配置广播
        // 与启动/切换的先后顺序会影响后者，曾出现过开启后已翻段落不重建的情况。
        var medical = professionalProfileFor(res.config) === 'medical';
        DT.state.medicalMode = medical;
        var strategy = professionalStrategy(res.config);
        if (DT.state.renderedProfessional !== undefined && DT.state.renderedProfessional !== strategy) rebuild = true;
        DT.state.theme = (site && site.theme) || res.config.theme || 'underline';
      }
    } catch (err) {
      DT.log('loadConfig failed', err);
    }
    applyChrome();
    if (DT.state.config) DT.emitConfig(DT.state.config);
    // 翻译中换了显示方式 / 目标语言：已注入的译文是按旧设置写的，整页重建（注入策略跟模式走）。
    // 删除在用语言进入 pending 时先不重建，等用户明确重译。
    if (rebuild && DT.state.enabled && !DT.state.targetPending) startOver();
    return DT.state.config;
  }

  // 重排诊断来自页面当前的渲染记录（dom.js 的 DT.reorderedCount），不是会话累加值：
  // 还原 / 模式切换 / 显式重译 / 站点替换段落 / 注入失败回滚后都自动归零。
  function reorderedCount() {
    return DT.reorderedCount ? DT.reorderedCount() : 0;
  }

  function summarize() {
    pruneOrderFailures();
    return {
      enabled: DT.state.enabled,
      mode: DT.state.mode,
      target: DT.state.target,
      configTarget: DT.state.configTarget || DT.state.target,
      targetPending: DT.state.targetPending === true,
      style: DT.state.style || 'plain',
      selectedStyle: DT.state.selectedStyle || 'plain',
      intensity: DT.state.intensity || 'standard',
      context: DT.state.contextStatus
        ? Object.assign({}, DT.state.contextStatus, { stale: DT.state.contextStale === true })
        : null,
      contextStale: DT.state.contextStale === true,
      total: DT.state.total,
      translated: DT.state.translated,
      failed: DT.state.failed,
      skipped: DT.state.skipped || 0,
      renderFailed: DT.state.renderFailed || 0,
      inlineOrderFailed: DT.state.inlineOrderFailed || 0,
      inlineReordered: reorderedCount(),
      inlinePlacementWarnings: DT.state.inlinePlacementWarnings || 0,
      safeDegraded: DT.state.safeDegraded || 0,
      outputFailed: DT.state.outputFailed || 0,
      lastRenderError: DT.state.lastRenderError || '',
      lastOutputError: DT.state.lastOutputError || '',
      lastError: DT.state.lastError || '',
      qualityWarnings: DT.state.qualityWarnings || 0,
      lastQualityWarning: DT.state.lastQualityWarning || '',
      busy: running
    };
  }

  // ---------------- 失败退避 ----------------
  // DT.state.failed = 当前处于失败状态的段落数（有退避记录的单元），不是累计失败次数
  function noteFailure(unit) {
    var prev = unitState(failures, unit);
    if (!prev) DT.state.failed += 1;
    var plan = DT.nextRetry(prev, unit.text, Date.now());
    setUnitState(failures, unit, { text: unit.text, count: plan.count, until: plan.until });
    return plan.delay;
  }

  function clearFailure(unit) {
    var had = unitState(failures, unit);
    if (!had) return;
    dropUnitState(failures, unit);
    DT.state.failed = Math.max(0, DT.state.failed - 1);
  }

  function resetFailures() {
    failures = new WeakMap();
    DT.state.failed = 0;
    clearTimeout(retryTimer);
    retryTimer = 0;
    retryAt = 0;
  }

  // ms 之后补扫一次；已经约好了更早的就不动
  function scheduleRetry(ms) {
    var at = Date.now() + ms;
    if (retryTimer && retryAt <= at) return;
    clearTimeout(retryTimer);
    retryAt = at;
    retryTimer = setTimeout(function () {
      retryTimer = 0;
      retryAt = 0;
      scheduleIncremental();
    }, ms);
  }

  // ---------------- 翻译主流程 ----------------
  // 作废当前这一轮（它的在途请求回来后会被丢弃）
  function cancelRun() {
    runId += 1;
    // 代际隔离：本轮收集的 unit 带旧代际，晚到的结果即使绕过 runId 也写不进页面
    if (DT.bumpGeneration) DT.bumpGeneration();
    running = false;
    lastBeat = 0;
  }

  // 上下文只影响翻译参考时，不取消在途 / 不重翻整页：标记过期，后续新任务用新上下文。
  function markContextStale() {
    DT.state.contextStale = true;
    if (!DT.state.contextStatus) {
      DT.state.contextStatus = { mode: 'ai', omitted: '', chars: 0, items: { title: 0, headings: 0, abbreviations: 0, adjacent: 0 } };
    }
    DT.state.contextStatus.stale = true;
  }

  // opts: { reset: 是否清零统计, silent: 是否不弹提示 }
  async function translatePage(opts) {
    var options = opts || {};
    if (running || !DT.state.enabled) return;
    pruneOrderFailures();
    // 配置目标已回退但页面还是旧目标译文：暂停动态补翻，避免两种目标语言混排；
    // 明确点「重新翻译」或「开始翻译」后 applyConfigTarget() 会清掉这个标记。
    if (DT.state.targetPending) return;
    var medical = false;
    var aiContext = false;
    var wantsContext = false;
    var snapshot = null;
    var scopeSnapshots = new WeakMap();
    var contextKey = '';
    running = true;
    runId += 1;
    var myRun = runId;
    lastBeat = Date.now();
    var retryIn = 0; // 本轮结束后多久补扫一次（有段落在退避中时）
    var collectedFull = false; // 本轮收集是否达到上限
    var progressed = false; // 本轮是否有单元完成或失败

    function cancelled() {
      return myRun !== runId;
    }

    function wantRetry(ms) {
      if (ms > 0) retryIn = retryIn ? Math.min(retryIn, ms) : ms;
    }

    try {
      var cfg = DT.state.config || {};
      // 先让已被站点改写的标题释放原文记录，再取当前上下文；所有 DOM 读取仍受本轮异常处理保护。
      DT.releaseReplaced();
      medical = professionalProfileFor(cfg) === 'medical';
      // AI 精翻与医学模式共用同一套文档上下文采集；关闭时完全不采集（默认路径零开销）。
      aiContext = cfg.aiContextEnabled === true;
      // 隐私脱敏开启时 AI 上下文整体不发送，也不再采集 / 监视标题变化触发重建；
      // 医学模式保持 0.11.7 的采集行为（后台会把上下文置空）。
      wantsContext = medical || (aiContext && cfg.privacyEnabled !== true);
      var contextWasDirty = contextDirty;
      snapshot = wantsContext ? documentSnapshot() : null;
      contextDirty = false;
      contextKey = snapshot ? documentFingerprint(snapshot) : '';
      // 只有网站自己的标题 / 章节 / 文档结构变化才做全页重建。
      // 翻译器自己插入译文造成的 mutation 已在 noteContextMutation 过滤；
      // 这里再要求 contextDirty，避免每次增量补扫都拿译文后的标题和原快照比较。
      if (wantsContext && contextWasDirty && contextChanged(snapshot)) {
        debugStats.contextChangedCount += 1;
        if (medical) {
          // 医学专业上下文与译文质量直接相关，保留原有整页重建行为。
          startOver('context-changed');
          return;
        }
        // AI 精翻：只标记旧上下文过期，不重新请求已经完成的正文；本轮新段落用当前快照。
        markContextStale();
      }
      DT.state.renderedMedical = medical;
      DT.state.renderedProfessional = professionalStrategy(cfg);
      DT.state.renderedContext = contextKey;
      var target = DT.state.target;
      var maxUnit = Number(cfg.maxUnitChars) || 1200;
      // 日文页面翻成中文时，纯汉字短语（進捗状況 / 無料）会被 looksLikeTarget 当成"已是中文"跳过；
      // 页面自己声明了日语就关掉这条判定，宁可多翻几句
      var docLang = String((document.documentElement && document.documentElement.lang) || '').toLowerCase();
      var jaPageToZh = docLang.indexOf('ja') === 0 && String(target || '').indexOf('zh') === 0;

      // 仅译文 / 控件替换过的元素，如果站点又改了它的文字，先放回待翻译；
      // 被站点删除的节点（无限滚动 / SPA）连同事务记录一起释放
      if (DT.pruneDetached) DT.pruneDetached();

      if (options.reset) {
        DT.state.translated = 0;
        DT.state.contextStale = false;
        if (DT.state.contextStatus) DT.state.contextStatus.stale = false;
        resetFailures();
      }

      // 过滤放进 collect 里做：不送翻的单元不占单轮上限
      var now = Date.now();
      var lazy = cfg.lazy !== false;
      var viewH = window.innerHeight || 800;
      // 这一轮收集时已经按当前视口量过段首矩形；takeBatch 首轮不必再清缓存重量
      viewMoved = false;
      lastScrollY = window.scrollY;
      lastViewH = window.innerHeight;
      var deferred = 0; // 离屏幕太远、留到滚过去再翻的单元数
      var pageStyle = DT.state.style || 'plain';
      var pageIntensity = DT.normalizeIntensity(DT.state.intensity || 'standard');
      var queue = DT.collectAll(function (unit) {
        var priorOrderFailure = unitState(renderFails, unit);
        if (priorOrderFailure && priorOrderFailure.code === 'unsupported-inline-order' &&
            (priorOrderFailure.text !== unit.text || priorOrderFailure.stamp !== (DT.unitStamp ? DT.unitStamp(unit) : ''))) {
          retireOrderFailure(false);
          forgetOrderRef(unit);
          dropUnitState(renderFails, unit);
        }
        if (DT.skipText(unit.text)) return false;
        // 趣味翻译：正文里够长的段落按风格改写；中文页面也要改写，所以风格单元不跳过「已是目标语言」
        unit.style = pageStyle === 'plain' ? 'plain' : DT.unitStyle(pageStyle, unit.text, DT.areaOf(unit.el));
        if (unit.style === 'plain' && cfg.skipSameLang !== false && !jaPageToZh && DT.looksLikeTarget(unit.text, target, DT.targetInfo())) return false;
        if (unitState(settled, unit) === unit.text) return false;
        // 上次注入失败 / 模型回包不可用、页面也没变：同一个确定性错误不再重试，也不再请求翻译
        var broken = unitState(renderFails, unit);
        if (broken && broken.text === unit.text && broken.stamp === (DT.unitStamp ? DT.unitStamp(unit) : '')) return false;
        var outputBroken = unitState(outputFails, unit);
        if (outputBroken && outputBroken.text === unit.text && outputBroken.stamp === (DT.unitStamp ? DT.unitStamp(unit) : '')) return false;
        if ((unitState(churn, unit) || 0) >= CHURN_MAX) return false;
        // 懒翻译：只翻屏幕附近的，远处的等滚到附近再翻（滚动会触发补扫，见 onViewChange）。
        // 放在退避判断前面：远处的失败段不安排重试，滚回来时再说
        if (lazy && !nearViewUnit(unit, viewH)) {
          deferred += 1;
          return false;
        }
        var fail = unitState(failures, unit);
        if (fail && fail.text === unit.text) {
          if (fail.count > DT.RETRY_DELAYS.length) return false; // 已放弃
          if (now < fail.until) {
            wantRetry(fail.until - now); // 还在退避中：这轮跳过，到点再来
            return false;
          }
        }
        return true;
      });
      collectedFull = DT.lastCollectFull;

      if (!queue.length) {
        if (!options.silent) DT.toast('没有需要翻译的段落（可能已是目标语言）');
        return;
      }
      // 进度分母 = 已翻的 + 这一轮要翻的（懒翻译时每轮只是一小块，不能只看本轮）
      DT.state.total = Math.max(DT.state.total || 0, DT.state.translated + queue.length);

      // 长段落切成多段，逐段翻完后拼回同一位置
      var pending = [];
      // 只对多句段落请求结构化对齐；单句段落的段落级对应就是句子级，不需要额外字段
      var hoverOn = !DT.state.config || DT.state.config.hoverCompare !== false;
      queue.forEach(function (unit, ui) {
        if (unit.inlineIssue) {
          noteRenderFailure(unit, 'invalid-inline', unit.inlineIssue);
          return;
        }
        // 段落里有 notranslate 的行内内容时，送翻文本带 <kN> 保留标记（见 dom.js 的保留区）
        var parts = DT.splitLong(DT.wireText(unit), maxUnit, unit.inlineProtocol);
        unit.slots = new Array(parts.length);
        unit.ali = new Array(parts.length); // 每片的对齐（模型没给就是 undefined）
        unit.seps = parts.seps; // 段与段之间原来的分隔：在换行处切开的，拼回去仍是换行
        unit.done = false;
        // Inline ranges use the same string response; local sentence alignment
        // remains available after stripping markers, without a second request.
        unit.wantAlign = !unit.inlineProtocol && !!hoverOn && unit.sentences && unit.sentences.length > 1;
        parts.forEach(function (part, k) {
          pending.push({ ui: ui, k: k, text: part, style: unit.style || 'plain', intensity: pageIntensity, align: unit.wantAlign, inlineProtocol: unit.inlineProtocol || '' });
        });
      });

      var maxItems = Math.max(1, Number(cfg.batchSize) || 8);
      var maxChars = Math.max(200, Number(cfg.maxCharsPerBatch) || 2000);

      // ---- 先翻用户正在看的 ----
      // 以前按文档顺序从头翻：人在页面中间时，要等上面全部翻完才轮到眼前这屏。
      // 现在每取一批都按"离当前屏幕多远"排序：屏幕内最先，往下的其次（多半要往下读），
      // 已经滚过去的最后。用户中途滚动，下一批就跟着换。
      viewMoved = true;
      function viewHeight() {
        return window.innerHeight || 800;
      }
      function reprioritize() {
        var scrolled = viewMoved || window.scrollY !== lastScrollY || window.innerHeight !== lastViewH;
        viewMoved = false;
        lastScrollY = window.scrollY;
        lastViewH = window.innerHeight;
        var seen = {};
        pending.forEach(function (seg) {
          if (seen[seg.ui]) return;
          seen[seg.ui] = true;
          // 滚动后布局位置变了，清掉这一轮缓存的矩形再量一次
          if (scrolled) queue[seg.ui].__rect = null;
          queue[seg.ui].prio = DT.distanceOf(rectOfUnit(queue[seg.ui]), viewHeight());
        });
        pending.sort(function (a, b) {
          return queue[a.ui].prio - queue[b.ui].prio || a.ui - b.ui || a.k - b.k;
        });
      }

      // 屏幕内的批次要小：非流式请求要等整批生成完才一起返回，
      // 一批 2000 字符时眼前这屏要等半分钟；拆小后分给多路并发同时翻，几秒就出来
      // 再往下一屏以内的用中等批次：正常往下读时，下一屏要在读完这屏之前翻好
      // 具体上限由 DT.batchLimits 决定（纯函数，自检可测）
      function takeBatch() {
        // 页面级滚动直接比对位置（不依赖 scroll 事件的派发时机）；页面内部容器的滚动靠 viewMoved
        if (viewMoved || window.scrollY !== lastScrollY || window.innerHeight !== lastViewH) reprioritize();
        var prio = queue[pending[0].ui].prio;
        var limits = DT.batchLimits(prio, viewHeight(), maxItems, maxChars);
        var limitItems = limits.items;
        var limitChars = limits.chars;
        var batch = [];
        var chars = 0;
        while (pending.length) {
          var seg = pending[0];
          if (batch.length && (batch.length >= limitItems || seg.style !== batch[0].style)) break;
          var pick = 0;
          // Fill a compatible batch from the same visibility priority. Alternating
          // plain/formatted siblings must not each create a one-item API request.
          if (batch.length && seg.inlineProtocol !== batch[0].inlineProtocol) {
            pick = -1;
            for (var bi = 1; bi < pending.length; bi += 1) {
              var candidate = pending[bi];
              if (queue[candidate.ui].prio !== prio || candidate.style !== batch[0].style) break;
              if (candidate.inlineProtocol === batch[0].inlineProtocol && chars + candidate.text.length <= limitChars) {
                pick = bi;
                break;
              }
            }
            if (pick < 0) break;
            seg = pending[pick];
          }
          if (batch.length && (batch.length >= limitItems || chars + seg.text.length > limitChars)) break;
          batch.push(pending.splice(pick, 1)[0]);
          chars += seg.text.length;
        }
        return batch;
      }

      DT.log('segments', pending.length);

      function rememberFailure(kind, unit, code, reason) {
        var text = String((unit && unit.text) || '');
        var markerSource = String((unit && (unit.wire || unit.text)) || '');
        failureLog.push({
          kind: kind,
          code: code,
          reason: reason || '',
          sourceLength: text.length,
          sourceMarkers: (markerSource.match(/<\/?[fk]\d+>/g) || []).length,
          at: Date.now()
        });
        if (failureLog.length > FAILURE_LOG_MAX) failureLog.shift();
      }

      function noteRenderFailure(unit, code, reason) {
        rememberFailure('render', unit, code, reason);
        var previous = unitState(renderFails, unit);
        if (previous && previous.code === 'unsupported-inline-order' && code !== previous.code) {
          retireOrderFailure(true);
          forgetOrderRef(unit);
        }
        if (!previous) DT.state.renderFailed = (DT.state.renderFailed || 0) + 1;
        if (code === 'unsupported-inline-order' && (!previous || previous.code !== code)) {
          orderFailureRefs.push({ el: unit.el, index: unitKey(unit) });
          DT.state.inlineOrderFailed = (DT.state.inlineOrderFailed || 0) + 1;
          DT.state.qualityWarnings = (DT.state.qualityWarnings || 0) + 1;
          DT.state.lastQualityWarning = DT.uiText(
            '链接顺序无法安全重排，已保留原文。可切换双语模式查看译文。',
            'Link order could not be preserved safely. The original was kept; switch to bilingual mode to view the translation.'
          );
        }
        setUnitState(renderFails, unit, {
          text: unit.text,
          stamp: DT.unitStamp ? DT.unitStamp(unit) : '',
          code: code,
          reason: reason || ''
        });
        DT.state.lastRenderError = code + (reason ? ': ' + reason : '');
        unit.done = true;
        unit.failed = false;
      }

      // 模型回包不可用：页面保持不变，记录独立类别；同一源文本 / DOM 不再重发。
      function noteOutputFailure(unit, code) {
        rememberFailure('output', unit, code, '');
        if (!unitState(outputFails, unit)) DT.state.outputFailed = (DT.state.outputFailed || 0) + 1;
        setUnitState(outputFails, unit, {
          text: unit.text,
          stamp: DT.unitStamp ? DT.unitStamp(unit) : '',
          code: code
        });
        DT.state.lastOutputError = code;
        unit.done = true;
        unit.failed = false;
      }

      function tryInject(unit) {
        if (!unit || unit.done) return;
        if (cancelled()) return;
        for (var k = 0; k < unit.slots.length; k += 1) {
          if (unit.slots[k] === undefined) return; // 还有段没回来（或失败了，等下次补扫重试）
        }
        var raw = DT.joinSlots(unit.slots, DT.translationSeps(unit.seps, target, DT.targetInfo()));
        // 每个切片单独合法，不代表拼回整段后仍然合法：一个切片省略全部 <fN>（协议允许）
        // 另一个切片保留 <fN>，拼起来就会缺标记。这里必须显式失败，不能让它经 keepText
        // 变成空串后走「跳过 + settled」——那会让长复杂段落永久不再重试。
        if (unit.inlineProtocol && DT.inlineInspect) {
          var joinedInline = DT.inlineInspect(unit, raw);
          if (joinedInline && !joinedInline.ok) {
            noteRenderFailure(unit, 'invalid-inline', joinedInline.reason);
            return;
          }
        }
        // 去掉保留标记后的译文：对齐校验、去重都按页面上实际显示的文字算；注入时再按标记切分
        var text = DT.keepText(unit, raw);
        unit.done = true;
        // 结构化对齐：n 的总和必须等于源句数，片段要按顺序出现在最终译文里；
        // 有一条不满足就返回 null（悬停降级为行 / 段落级，绝不按长度比例猜）
        var align = null;
        if (unit.wantAlign && unit.sentences && unit.sentences.length > 1) {
          var parts = [];
          var ok = true;
          for (var pi = 0; pi < unit.slots.length; pi += 1) {
            var one = unit.ali && unit.ali[pi];
            // 后台的 alignments[i] 是 [{n,t}, …] 数组（不是 {parts} 包装）
            if (!one || !one.length) {
              ok = false;
              break;
            }
            parts = parts.concat(
              one.map(function (part) {
                return part && part.t ? { n: part.n, t: DT.keepText(unit, part.t) } : part;
              })
            );
          }
          if (ok) align = DT.units.alignmentOf(parts, text, unit.sentences.length);
        }
        // 等译文期间站点改了这段原文（SPA 重渲染、翻页复用同一个元素）：
        // 旧译文不能写进新内容，也不记成「已处理」；本轮结束后按新内容重新收集
        if (DT.sourceChanged(unit)) {
          setUnitState(churn, unit, (unitState(churn, unit) || 0) + 1);
          dirty = true;
          return;
        }
        dropUnitState(churn, unit);
        if (!text) {
          DT.state.skipped = (DT.state.skipped || 0) + 1;
          setUnitState(settled, unit, unit.text);
          return;
        }

        // 译文与原文相同或近似重复就不插入：
        // 完全一致的（用户名、数字、专有名词）会叠成一条"删除线"，看着像渲染 bug；
        // 原文本来就是目标语言、模型只改写了几个词（feat: → 新功能:）会多出一行几乎一样的字。
        // 趣味翻译的单元只拦完全一致：风格改写（句末加个「喵」）本来就和原文很像
        var dup =
          unit.style && unit.style !== 'plain'
            ? DT.normalizeText(text) === DT.normalizeText(unit.text)
            : DT.isNearDuplicate(unit.text, text, target, DT.targetInfo());
        if (dup) {
          DT.state.skipped = (DT.state.skipped || 0) + 1;
          setUnitState(settled, unit, unit.text);
          return;
        }

        // 自定义语言的内部 id 不是 BCP 47：只把有效的 code 交给方向 / 字体 / lang 属性；
        // 没有 code 的虚构语言传空，让渲染层走安全降级，而不是把 cl_… 当语言标签。
        var targetInfo = DT.targetInfo();
        var renderTarget = targetInfo
          ? (targetInfo.code || (targetInfo.kind === 'custom' ? '' : target))
          : target;
        var injected = DT.inject(unit, raw, renderTarget, align);
        var outcome = unit.injectResult || null;
        var code = outcome ? outcome.code : injected ? 'success' : 'already-rendered';
        if (injected) {
          var oldFailure = unitState(renderFails, unit);
          if (oldFailure && oldFailure.code === 'unsupported-inline-order') {
            retireOrderFailure(false);
            forgetOrderRef(unit);
          }
          DT.state.translated += 1;
          if (code === 'safe-degraded') DT.state.safeDegraded = (DT.state.safeDegraded || 0) + 1;
          if (unit.renderWarning) {
            DT.state.inlinePlacementWarnings = (DT.state.inlinePlacementWarnings || 0) + 1;
            DT.state.lastQualityWarning = /citation/.test(unit.renderWarning.code || '')
              ? DT.uiText('引用位置已作安全调整，请对照原文核对。', 'Citation placement was adjusted safely; check it against the original.')
              : DT.uiText('模型把多个正文链接集中在一处，请对照原文核对译文。', 'The model grouped several body links together; check the translation against the original.');
          }
          if (unit.qualityWarning || unit.renderWarning) {
            DT.state.qualityWarnings = (DT.state.qualityWarnings || 0) + 1;
            if (!unit.renderWarning) DT.state.lastQualityWarning = unit.qualityWarning;
          }
          dropUnitState(renderFails, unit);
        } else if (code === 'stale-generation' || unit.gen !== DT.generation) {
          // 旧代际的结果：那一轮已经作废，什么都不记
        } else if (code === 'stale-source') {
          // 源节点已经不在页面上：页面更新了，本轮结束后重新收集
          dirty = true;
        } else if (code === 'unsafe-structure' || code === 'invalid-placement' || code === 'invalid-inline' || code === 'unsupported-inline-order') {
          // 模型已经给了译文，只是写不进页面：不算跳过、不记成已处理，记下原因；
          // 源文本和 DOM 状态都没变就不再重试（不重复请求），页面变了再收（后台缓存里有译文）
          noteRenderFailure(unit, code, outcome && outcome.reason);
        } else {
          // 已经有译文 / 不适用 / 没有译文：记成已处理，内容没变就不再每轮重收、重发同一段
          // （命中缓存也要走一次后台；缓存没了就是重复计费）
          DT.state.skipped = (DT.state.skipped || 0) + 1;
          setUnitState(settled, unit, unit.text);
        }
      }

      function markFailed(batch) {
        batch.forEach(function (seg) {
          queue[seg.ui].failed = true;
        });
      }

      async function runBatch(batch) {
        if (cancelled()) return;
        var texts = batch.map(function (seg) {
          return seg.text;
        });
        var res = null;
        try {
          // 比后台单次请求的 180s 上限略长。后台整条消息没有总时限（排队、重试、拆批），这里超时后
          // 按退避重发；同一段还在后台翻的话，重发的那次会等它的结果，不会再请求一次（见 background.js 的 inflight）
          var wantAlign = false;
          for (var ai = 0; ai < batch.length; ai += 1) if (batch[ai].align) wantAlign = true;
          var message = { type: 'translate', texts: texts, target: target, style: batch[0].style || 'plain', align: wantAlign };
          if (batch[0].inlineProtocol) message.inlineProtocol = batch[0].inlineProtocol;
          if ((batch[0].style || 'plain') !== 'plain') message.intensity = batch[0].intensity || 'standard';
          var privacyOmitted = cfg.privacyEnabled === true;
          // 医学模式保持 0.11.7 的消息形态（后台引擎会在 privacyEnabled 时把上下文置空）；
          // AI 精翻在隐私开启时整段不发，且不把相邻段落混进医学上下文。
          if (wantsContext && (medical || !privacyOmitted)) {
            var batchUnits = batch.map(function (seg) {
              var visible = seg.text;
              // 医学 / 术语上下文只看可见文字，不把 <fN>/<kN> 标记当正文。
              if (seg.inlineProtocol && window.__RimefoxInline) {
                var checked = window.__RimefoxInline.inspect(visible, visible);
                if (checked.ok) visible = checked.text;
              }
              return { el: queue[seg.ui].el, text: visible };
            });
            var scope = contextRoot(batchUnits[0].el);
            var scopedSnapshot = snapshot;
            if (scope) {
              scopedSnapshot = scopeSnapshots.get(scope);
              if (!scopedSnapshot) {
                scopedSnapshot = documentSnapshot(scope);
                scopeSnapshots.set(scope, scopedSnapshot);
              }
              rememberContextScope(scope, scopedSnapshot);
            }
            message.documentContext = collectDocumentContext(batchUnits, scopedSnapshot, { adjacent: aiContext && !privacyOmitted });
          }
          res = await DT.send(
            message,
            190000
          );
        } catch (err) {
          if (cancelled()) return;
          lastBeat = Date.now();
          DT.log('send failed', err);
          markFailed(batch);
          DT.state.lastError = err && err.message ? err.message : String(err);
          return;
        }
        if (cancelled()) return; // 期间用户点了"还原"，或这一轮已被复位
        if (wantsContext && contextDirty) {
          contextDirty = false;
          DT.releaseReplaced();
          scopeSnapshots = new WeakMap();
          if (contextChanged(documentSnapshot())) {
            debugStats.contextChangedCount += 1;
            if (medical) {
              startOver('context-changed-after-batch');
              return;
            }
            // AI 精翻：已发出的这一批继续注入（避免白付一次请求），只标记旧上下文过期。
            markContextStale();
          }
        }
        lastBeat = Date.now();
        if (!res || !res.results) {
          markFailed(batch);
          if (res && res.error) {
            DT.state.lastError = res.error;
            DT.log('batch error', res.error);
          }
          return;
        }
        if (res.error) DT.state.lastError = res.error;
        if (res.context) {
          // 回包代表的是「这次实际发送的上下文」；如果请求期间标题 / 章节又变了，
          // 保留 stale 标记，不能让回包把它洗掉。
          DT.state.contextStatus = Object.assign({}, res.context, { stale: DT.state.contextStale === true });
        }
        batch.forEach(function (seg, k) {
          if (queue[seg.ui].done) return;
          var inlineError = res.inlineErrors && res.inlineErrors[k];
          if (inlineError) {
            if (DT.sourceChanged(queue[seg.ui])) {
              queue[seg.ui].done = true;
              dirty = true;
              return;
            }
            noteRenderFailure(queue[seg.ui], 'invalid-inline', String(inlineError));
            // Deterministic protocol failure must not send the remaining slices
            // of the unchanged paragraph again or enter paid retry backoff.
            pending = pending.filter(function (item) { return item.ui !== seg.ui; });
            return;
          }
          var outputError = res.outputErrors && res.outputErrors[k];
          if (outputError) {
            if (DT.sourceChanged(queue[seg.ui])) {
              queue[seg.ui].done = true;
              dirty = true;
              return;
            }
            noteOutputFailure(queue[seg.ui], String(outputError));
            // 模型回包不可用是确定性失败：不自动重发，不产生额外 Token；用户重译或页面变化后再试。
            pending = pending.filter(function (item) { return item.ui !== seg.ui; });
            return;
          }
          var value = res.results[k];
          var validation = res.validations && res.validations[k];
          if (validation && (validation.status === 'review' || validation.status === 'error')) {
            var issues = validation.issues || [];
            queue[seg.ui].qualityWarning = issues.length && issues[0].message ? String(issues[0].message) : '专业翻译结果需要审查';
          }
          if (typeof value === 'string') {
            // '' = 模型返回空（原文本身是 "EN"/"×" 这种）：tryInject 里记为"同原文跳过"，不算失败
            queue[seg.ui].slots[seg.k] = value.trim();
            var ali = res.alignments && res.alignments[k];
            queue[seg.ui].ali[seg.k] = ali && ali.length ? ali : null;
          } else {
            // null = 这一段请求失败（Key 无效、限流、余额不足…）。
            // 以前这里也记成"跳过"，结果全部失败时弹的是"已翻译 N 段"。
            // 槽位留空：本轮不注入，本轮结束后按退避表安排重试。
            queue[seg.ui].failed = true;
          }
        });
        if (DT.beginRenderCache) DT.beginRenderCache();
        try {
          batch.forEach(function (seg) {
            tryInject(queue[seg.ui]);
          });
        } finally {
          if (DT.endRenderCache) DT.endRenderCache();
        }
      }

      async function worker() {
        while (pending.length) {
          if (cancelled()) return;
          await runBatch(takeBatch());
        }
      }

      // 并发路数跟设置走（以前这里写死 3，设置里的"并发请求数"调多大都没用）
      var workers = [];
      var parallel = Math.max(1, Math.min(16, Number(cfg.concurrency) || 6));
      for (var w = 0; w < parallel; w += 1) workers.push(worker());
      await Promise.all(workers);

      // 兜底：把剩余能拼的补上
      if (DT.beginRenderCache) DT.beginRenderCache();
      try {
        queue.forEach(tryInject);
      } finally {
        if (DT.endRenderCache) DT.endRenderCache();
      }

      // 记账：失败的进退避，成功（含"与原文相同"）的清掉旧的失败记录
      if (!cancelled()) {
        queue.forEach(function (unit) {
          if (unit.failed) {
            wantRetry(noteFailure(unit));
            progressed = true;
          } else if (unit.done) {
            clearFailure(unit);
            progressed = true;
          }
        });
      }

      if (cancelled()) {
        // 用户中途点了"还原"，或这一轮已被复位，不再弹提示
      } else if (!options.silent) {
        if (DT.state.failed > 0 && !DT.state.translated) {
          DT.toast('翻译失败：' + (DT.state.lastError || '未知错误'), 5000);
        } else if (DT.state.failed > 0) {
          DT.toast('新增 ' + (DT.state.translated) + ' 段译文，' + DT.state.failed + ' 段失败');
        } else if (DT.state.inlineOrderFailed > 0) {
          DT.toast(DT.uiText(
            '已翻译 ' + DT.state.translated + ' 段；有 ' + DT.state.inlineOrderFailed + ' 段因链接顺序无法安全重排而保留原文。可切换双语模式查看译文。',
            'Translated ' + DT.state.translated + ' paragraphs; ' + DT.state.inlineOrderFailed + ' kept original because link order could not be preserved safely. Switch to bilingual mode to view the translation.'
          ), 7000);
        } else if (DT.state.outputFailed > 0) {
          DT.toast(DT.uiText(
            '已翻译 ' + DT.state.translated + ' 段，' + DT.state.outputFailed + ' 段模型输出异常，已保留原文且未自动重试',
            'Translated ' + DT.state.translated + ' paragraphs; ' + DT.state.outputFailed + ' kept original because the model output was unusable and was not retried automatically'
          ), 6000);
        } else if (DT.state.renderFailed > 0) {
          DT.toast(DT.uiText(
            '已翻译 ' + DT.state.translated + ' 段，' + DT.state.renderFailed + ' 段因格式或结构问题保留原文',
            'Translated ' + DT.state.translated + ' paragraphs; ' + DT.state.renderFailed + ' kept original because formatting or structure could not be verified'
          ), 5000);
        } else if (DT.state.inlinePlacementWarnings > 0) {
          DT.toast(DT.uiText(
            '已翻译 ' + DT.state.translated + ' 段；有 ' + DT.state.inlinePlacementWarnings + ' 段链接或引用位置需要核对，请对照原文确认。',
            'Translated ' + DT.state.translated + ' paragraphs; check link or citation placement in ' + DT.state.inlinePlacementWarnings + ' paragraphs against the original.'
          ), 7000);
        } else {
          DT.toast('已翻译 ' + queue.length + ' 段' + (deferred ? '，往下滚动会接着翻' : ''));
        }
      }
    } catch (err) {
      DT.log('translatePage error', err);
      if (!options.silent) {
        DT.toast('翻译出错：' + (err && err.message ? err.message : String(err)));
      }
    } finally {
      // 已被作废的旧一轮不能动状态：新一轮可能已经开始了
      if (!cancelled()) {
        running = false;
        lastBeat = 0;
        if (retryIn) scheduleRetry(retryIn);
        // 这轮收满了上限（超长页面）：接着收下一批。
        // 0.4.2 起观察器不再被自己插的译文触发，没有这一步时超出上限的部分永远不会翻。
        // 要求本轮有进展，防止同一批收不走的单元原地打转
        if (dirty || (collectedFull && progressed)) {
          dirty = false;
          scheduleIncremental();
        }
      }
    }
  }

  // 配置里可能已经回退了目标语言（删除在用自定义语言），但页面上的旧译文还在。
  // 只有用户明确开始翻译 / 重译时才把它落到本页。
  function applyConfigTarget() {
    var cfg = DT.state.config || {};
    var next = DT.state.configTarget || cfg.targetLang || DT.state.target || 'zh-CN';
    var info = DT.state.configLangInfo || cfg.activeLanguage || null;
    DT.state.target = next;
    DT.state.langInfo = info;
    DT.state.targetCode = (info && info.code) || '';
    DT.state.targetPending = false;
    DT.state.renderedLangSig = info ? [info.kind, info.code, info.script].join('|') : '';
  }

  // 用户明确开始翻译 / 重新翻译时才把「选中但未应用」的风格与当前强度落到本页。
  // 下拉框 change 本身绝不调用这里，避免切换菜单就发付费请求。
  function applySelectedStyle(cfg) {
    var selected = DT.state.selectedStyle || 'plain';
    DT.state.style = DT.STYLE_IDS.indexOf(selected) >= 0 ? selected : 'plain';
    DT.state.intensity = DT.state.style === 'plain'
      ? 'standard'
      : DT.normalizeIntensity((cfg && cfg.funIntensity) || (DT.state.config && DT.state.config.funIntensity));
  }

  // ---------------- 开关 ----------------
  async function enable() {
    var cfg = await loadConfig();
    // 内容脚本拿不到 Key 本身（后台只给 hasKey），见 background.js 的 config:get
    if (!cfg || !cfg.hasKey) {
      DT.toast('还没配置 API Key：点扩展图标 → 设置');
      return summarize();
    }
    applyConfigTarget();
    applySelectedStyle(cfg);
    DT.state.enabled = true;
    DT.send({ type: 'resume:set', value: true }).catch(function () {});
    detectForeignTranslator();
    DT.state.total = 0;
    DT.state.translated = 0;
    DT.state.qualityWarnings = 0;
    DT.state.lastQualityWarning = '';
    resetFailures();
    DT.state.skipped = 0;
    DT.state.renderFailed = 0;
    DT.state.inlineOrderFailed = 0;
    DT.state.inlinePlacementWarnings = 0;
    DT.state.safeDegraded = 0;
    DT.state.outputFailed = 0;
    DT.state.lastRenderError = '';
    DT.state.lastOutputError = '';
    DT.state.lastError = '';
    outputFails = new WeakMap();
    failureLog = [];
    applyChrome();
    // 注意：这里故意不 await —— 弹窗要能立刻拿到状态并开始轮询
    translatePage({ reset: true });
    return summarize();
  }

  function disable() {
    // 作废在途的一轮：否则快速"还原→再翻译"时，新一轮会因 running 还是 true 直接返回，
    // 旧一轮却带着过期的队列继续往页面里插译文
    cancelRun();
    DT.state.enabled = false;
    if (DT.hover) DT.hover.clear();
    // 还原只结束本页这次运行，不重置用户选择。style 是当前页实际译文风格，
    // 页面恢复原文后不再声称猫娘；selectedStyle 保留，下一次明确翻译继续用。
    DT.state.style = 'plain';
    DT.state.intensity = 'standard';
    DT.send({ type: 'resume:set', value: false }).catch(function () {});
    DT.restore();
    renderedContextScopes = [];
    DT.state.renderedProfessional = undefined;
    DT.state.renderedContext = undefined;
    DT.state.qualityWarnings = 0;
    DT.state.lastQualityWarning = '';
    settled = new WeakMap();
    churn = new WeakMap();
    renderFails = new WeakMap();
    orderFailureRefs = [];
    outputFails = new WeakMap();
    failureLog = [];
    resetFailures();
    applyChrome();
    DT.toast('已还原原文');
    return summarize();
  }

  async function toggle() {
    lastToggleAt = Date.now();
    if (DT.state.enabled) return disable();
    return enable();
  }

  // 页面内快捷键（设置页可录制，默认 Alt+A）。
  // 浏览器快捷键（manifest commands）没分配到我们时，按键会直接传给网页，这里能接住；
  // 但如果同一组合键被别的扩展注册成了浏览器快捷键，按键在浏览器层就被它拿走，网页收不到，
  // 这里也无能为力——只能到 chrome://extensions/shortcuts 换键（设置页会提示）。
  // 两条路径用 lastToggleAt 去重，不会"开了又关"。
  var lastToggleAt = 0;
  var TOGGLE_DEDUPE_MS = 500;

  // 物理键位 / 快捷键解析在 core.js：DT.keyFromCode / DT.matchesHotkey（纯函数，自检可测）

  function selectedText() {
    try {
      var sel = window.getSelection();
      return sel ? String(sel.toString()).trim() : '';
    } catch (err) {
      return '';
    }
  }

  // 自适应：有选区就翻选区，没有就整页
  function hotkeyAction() {
    var cfg = DT.state.config || {};
    lastToggleAt = Date.now();
    if (cfg.selectionTranslate !== false && DT.selectionTranslate && selectedText()) {
      if (DT.selectionTranslate() !== false) return;
    }
    toggle().catch(function (err) {
      DT.log('hotkey toggle failed', err);
    });
  }

  function bindHotkey() {
    document.addEventListener(
      'keydown',
      function (event) {
        var spec = (DT.state.config && DT.state.config.hotkey) || 'alt+a';
        if (!DT.matchesHotkey(event, spec)) return;
        // 正在输入框 / 可编辑区域里打字：不抢这个键
        if (DT.isEditableTarget(event.target)) return;
        event.preventDefault();
        var now = Date.now();
        if (now - lastToggleAt < TOGGLE_DEDUPE_MS) return; // 和浏览器快捷键去重
        hotkeyAction();
      },
      true
    );
  }

  // 输入框翻译（0.9.0）：和整页翻译的快捷键分开，只在可编辑区域里有意义。
  // 不 preventDefault 的话，Alt+I 在不少站点会被浏览器 / 站点自己吃掉
  function bindInputHotkey() {
    document.addEventListener(
      'keydown',
      function (event) {
        var spec = (DT.state.config && DT.state.config.inputHotkey) || 'alt+i';
        if (!DT.matchesHotkey(event, spec)) return;
        if (event.isComposing || event.keyCode === 229) return; // 输入法拼字中
        if (!DT.isEditableTarget(event.target)) return;
        if (!DT.inputTranslate) return;
        event.preventDefault();
        event.stopPropagation();
        DT.inputTranslate();
      },
      true
    );
  }

  // ---------------- 动态内容 ----------------
  var incrementalDue = 0;
  function scheduleIncremental() {
    if (!DT.state.enabled) return;
    debugStats.incrementalScanCount += 1;
    // 防抖，但要有上限：持续更新的页面（聊天 / 论坛 / 直播）每次变动都重置 600ms，
    // 会永远等不到翻译。第一次变动定一个截止时间，之后只提前不推迟。
    var now = Date.now();
    if (!incrementalDue) incrementalDue = now + 600;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      incrementalDue = 0;
      if (!DT.state.enabled) return;
      if (running) {
        dirty = true;
        return;
      }
      translatePage({ silent: true });
    }, Math.max(0, incrementalDue - now));
  }

  // 悬停/聚焦时补扫：下拉菜单、浮层往往是 hover 时才把内容塞进 DOM，
  // 光靠 MutationObserver 会漏（有的站点只改 class 不改结构）。
  function bindHoverRescan() {
    var hoverTimer = 0;

    function poke(target) {
      if (!DT.state.enabled || !target || target.nodeType !== 1) return;
      if (!target.closest) return;
      var menu = target.closest(
        '[role="menu"],[role="listbox"],[role="dialog"],[class*="dropdown"],[class*="popup"],[class*="menu"],[class*="submenu"],[class*="tooltip"]'
      );
      if (!menu) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(function () {
        if (DT.state.enabled && !running) translatePage({ silent: true });
      }, 400);
    }

    document.addEventListener(
      'mouseover',
      function (event) {
        poke(event.target);
      },
      true
    );
    document.addEventListener(
      'focusin',
      function (event) {
        poke(event.target);
      },
      true
    );
  }

  // 站点会克隆整块内容（轮播、动画、骨架屏），克隆时把我们的译文节点
  // 一起复制了 —— 表现为同一段译文出现两遍。这里清理同级重复的译文节点。
  function cleanupDuplicateTargets(nodes) {
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      if (!node || node.nodeType !== 1) continue;
      var targets = null;
      if (node.hasAttribute && node.hasAttribute('data-dt-target')) {
        targets = [node];
      } else if (node.querySelectorAll) {
        targets = node.querySelectorAll('[data-dt-target]');
      }
      if (!targets || !targets.length) continue;

      for (var k = 0; k < targets.length; k += 1) {
        var target = targets[k];
        if (target.nodeType !== 1 || !target.hasAttribute || !target.hasAttribute('data-dt-target')) continue;
        // 我们自己刚插入的译文节点：登记过、id 对得上，直接跳过。
        // 以前这里每个新增节点都 querySelectorAll(':scope > [data-dt-target]')，
        // 3000 段页面会变成 O(n²)。
        if (DT.isKnownTarget && DT.isKnownTarget(target)) continue;
        if (DT.removeCloneTarget && DT.removeCloneTarget(target)) {
          target.remove();
          continue;
        }
        // 旧版本 / 外部写入的节点没有登记：维持保守清理，但只处理没有 id 的
        var id = target.getAttribute('data-dt-unit');
        if (id) continue;
        var parent = target.parentElement;
        if (!parent) continue;
        var siblings = parent.querySelectorAll(':scope > [data-dt-target]');
        if (siblings.length <= 1) continue;
        for (var s = 1; s < siblings.length; s += 1) siblings[s].remove();
      }
    }
  }

  // 我们自己插的译文节点 / 提示条
  function isOwnNode(node) {
    if (DT.isOwnNode) return DT.isOwnNode(node);
    return (
      node.nodeType === 1 &&
      (node.hasAttribute('data-dt-target') || node.hasAttribute('data-dt-ui') || node.hasAttribute('data-dt-dir'))
    );
  }

  function hasForeignNodes(nodes) {
    for (var k = 0; k < nodes.length; k += 1) {
      if (!isOwnNode(nodes[k])) return true;
    }
    return false;
  }

  function noteContextMutation(record) {
    var target = record.target && (record.target.nodeType === 1 ? record.target : record.target.parentElement);
    if (target && target.closest && target.closest('title,h1,h2,h3')) {
      contextDirty = true;
      return;
    }
    var lists = [record.addedNodes || [], record.removedNodes || []];
    for (var li = 0; li < lists.length; li += 1) {
      for (var ni = 0; ni < lists[li].length; ni += 1) {
        var node = lists[li][ni];
        if (node.nodeType !== 1 || isOwnNode(node)) continue;
        if ((node.matches && node.matches('title,h1,h2,h3,article,main')) || (node.querySelector && node.querySelector('title,h1,h2,h3,article,main'))) {
          contextDirty = true;
          return;
        }
      }
    }
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        var record = records[i];
        var target = record.target;
        // 新插入的 B 站评论宿主先登记；shadow root 稍后才创建时由 shadow.js 延迟补扫。
        if (record.type === 'childList' && record.addedNodes && record.addedNodes.length && DT.shadow) {
          DT.shadow.noteAdded(record.addedNodes);
        }
        // 忽略我们自己造成的变更：每插一批译文都会触发一次，
        // 不过滤的话每轮翻译结束后都要白跑一遍整页扫描
        if (target && target.nodeType === 1 && target.closest && target.closest('[data-dt-ui]')) continue;
        if (record.type === 'childList' && ((record.addedNodes && record.addedNodes.length) || (record.removedNodes && record.removedNodes.length))) {
          cleanupDuplicateTargets(record.addedNodes || []);
          if (!hasForeignNodes(record.addedNodes || []) && !hasForeignNodes(record.removedNodes || [])) continue;
          noteContextMutation(record);
          scheduleIncremental();
          return;
        }
        if (record.type === 'characterData') {
          if (DT.isOwnWrite(target)) continue; // 仅译文模式原地替换文本
          noteContextMutation(record);
          scheduleIncremental();
          return;
        }
      }
    });
    try {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
    } catch (err) {
      DT.log('observer failed', err);
    }
  }

  function watchUrl() {
    if (urlTimer) return;
    urlTimer = setInterval(function () {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      // 站点规则可以按路径写：换了网址重新取一次（外观 / 规则跟着新网址走）
      loadConfig();
      if (!DT.state.enabled) return;
      // SPA 路由切换 / 打开弹层时 URL 会变。
      // 这里不再整页清空重翻（那样会闪一下），只把"源文本确实变了"的元素撤掉，
      // 剩下的保持原样，然后补扫一遍。
      var stale = DT.refreshStale();
      DT.log('url change, stale units:', stale);
      scheduleIncremental();
    }, 1000);
  }

  // 中途重建：作废在途的一轮（它回来的结果会被丢弃），清空重来
  function startOver(reason) {
    debugStats.startOverCount += 1;
    noteDebug('startOver', reason || 'explicit');
    cancelRun();
    DT.state.renderedProfessional = undefined;
    DT.state.renderedContext = undefined;
    renderedContextScopes = [];
    if (DT.hover) DT.hover.clear();
    DT.restore();
    settled = new WeakMap();
    churn = new WeakMap();
    renderFails = new WeakMap();
    orderFailureRefs = [];
    outputFails = new WeakMap();
    failureLog = [];
    resetFailures();
    DT.state.total = 0;
    DT.state.translated = 0;
    DT.state.qualityWarnings = 0;
    DT.state.lastQualityWarning = '';
    DT.state.skipped = 0;
    DT.state.renderFailed = 0;
    DT.state.inlineOrderFailed = 0;
    DT.state.inlinePlacementWarnings = 0;
    DT.state.safeDegraded = 0;
    DT.state.outputFailed = 0;
    DT.state.lastRenderError = '';
    DT.state.lastOutputError = '';
    DT.state.lastError = '';
    applyChrome();
    if (DT.state.enabled) translatePage({ reset: true, silent: true });
  }

  // 点击触发的补扫：Tab 切换、折叠面板、弹层往往只切 class/style，
  // 不产生 DOM 插入，MutationObserver 抓不到。点完 300ms 主动扫一次。
  function bindClickRescan() {
    document.addEventListener(
      'click',
      function (event) {
        if (!DT.state.enabled) return;
        var target = event.target;
        if (target && target.closest && target.closest('[data-dt-ui]')) return;
        setTimeout(function () {
          if (!DT.state.enabled) return;
          if (running) {
            dirty = true;
            return;
          }
          translatePage({ silent: true });
        }, 300);
        // B 站楼中楼回复通常在点击后异步加载；300ms 时可能还没进 DOM。
        // 只在启用 Shadow DOM 的站点补一次 1.2s 后的增量扫描，不为每个 thread 建 Observer。
        if (DT.shadow && DT.shadow.active && DT.shadow.active()) {
          setTimeout(function () {
            if (!DT.state.enabled) return;
            if (running) {
              dirty = true;
              return;
            }
            translatePage({ silent: true });
          }, 1200);
        }
      },
      true
    );
  }

  // 检测页面上是否已经有"别的翻译器"在工作。
  // 浏览器的自带翻译会先把内容换成中文，导致我们看到的源文本已是目标语言，
  // 于是整页被跳过 —— 这是"插件没反应"最常见的假象。
  function detectForeignTranslator() {
    var html = document.documentElement;
    var cls = String(html.className || '');
    var note = '';

    if (/(^|\s)translated-(ltr|rtl)/.test(cls) || document.getElementById('goog-gt-tt')) {
      var hotkey = DT.hotkeyLabel((DT.state.config && DT.state.config.hotkey) || 'alt+a');
      note = '检测到「浏览器自带翻译」已生效。请先把它关掉（地址栏翻译图标 → 显示原文），再按 ' + hotkey + '。';
    } else if (
      html.getAttribute('imt-state') ||
      html.getAttribute('data-immersive-translate') ||
      document.querySelector('[data-immersive-translate-root-translation-theme]')
    ) {
      // 技术检测保留（对方会注入这些属性），但提示文案不点名产品
      note = '检测到其它翻译扩展已在本页生效，两个扩展会互相跳过。建议只保留一个。';
    }

    if (note) {
      DT.log('foreign translator detected');
      DT.toast(note, 7000);
    }
    return note;
  }

  // 给页面里的悬浮入口（dock.js）用：和弹窗按钮走同一套逻辑
  function setMode(mode) {
    DT.state.mode = mode === 'translation' ? 'translation' : 'dual';
    // 删除在用语言后处于 pending：先还原旧译文、只应用显示方式，不拿新目标去付费请求。
    // 用户之后点「重新翻译」时才按回退后的目标语言重建。
    if (DT.state.targetPending) {
      DT.restore();
      DT.state.total = 0;
      DT.state.translated = 0;
      DT.state.failed = 0;
      applyChrome();
      return summarize();
    }
    // 注入策略跟模式相关（双语=追加，仅译文=原地替换），必须重建
    startOver();
    return summarize();
  }
  DT.control = {
    toggle: toggle,
    setMode: setMode,
    status: summarize
  };

  // ---------------- 消息 ----------------
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;

    if (msg.type === 'dt:toggle') {
      // 浏览器快捷键刚和页面内快捷键一起触发过：忽略这一次（弹窗按钮不带 source，不受影响）
      if (msg.source === 'command' && Date.now() - lastToggleAt < TOGGLE_DEDUPE_MS) {
        sendResponse(summarize());
        return false;
      }
      // 浏览器快捷键不区分焦点：正在输入框里打字时不该被它切走翻译
      if (msg.source === 'command' && DT.isEditableTarget(document.activeElement)) {
        sendResponse(summarize());
        return false;
      }
      // 浏览器快捷键也自适应：有选区时表现为划词翻译，没有选区才翻整页
      if (
        msg.source === 'command' &&
        (DT.state.config || {}).selectionTranslate !== false &&
        DT.selectionTranslate &&
        selectedText()
      ) {
        lastToggleAt = Date.now();
        if (DT.selectionTranslate() !== false) {
          sendResponse(summarize());
          return false;
        }
      }
      toggle()
        .then(sendResponse)
        .catch(function (err) {
          sendResponse({ error: String(err) });
        });
      return true;
    }

    if (msg.type === 'dt:status') {
      sendResponse(summarize());
      return false;
    }

    if (msg.type === 'dt:setMode') {
      sendResponse(setMode(msg.mode));
      return false;
    }

    // 趣味翻译：只更新「用户选中的风格」，不翻译、不重翻、不取消在途请求、不清缓存。
    // 下次明确点「翻译此页」或「重新翻译」时才应用；已翻译页面保持当前文风。
    if (msg.type === 'dt:setStyle') {
      DT.state.selectedStyle = DT.STYLE_IDS.indexOf(msg.style) >= 0 ? msg.style : 'plain';
      DT.state.selectedStyleExplicit = true;
      sendResponse(summarize());
      return false;
    }

    if (msg.type === 'dt:setTarget') {
      // 弹窗先存配置再发这条。先重新读一次配置，拿到最新的语言表 / activeLanguage，
      // 再决定是否重建；避免广播晚到导致第一轮用旧 code 渲染、广播到达后再重建一次。
      loadConfig().then(function () {
        var nextTarget = msg.target || DT.state.target;
        // 弹窗可能停留在旧语言列表：被删除 / 不认识的目标不要写进本页状态。
        var knownLanguages = DT.state.config && DT.state.config.languages;
        if (knownLanguages && knownLanguages.length && !knownLanguages.some(function (one) { return one.value === nextTarget; })) {
          nextTarget = (DT.state.config && DT.state.config.targetLang) || DT.state.target;
        }
        var hitLanguage = null;
        if (knownLanguages && knownLanguages.length) {
          for (var li = 0; li < knownLanguages.length; li += 1) {
            if (knownLanguages[li].value === nextTarget) {
              hitLanguage = knownLanguages[li];
              break;
            }
          }
        }
        DT.state.configTarget = nextTarget;
        DT.state.configLangInfo = hitLanguage || (DT.state.config && DT.state.config.activeLanguage) || null;
        DT.state.targetPending = false;
        if (nextTarget !== DT.state.target) {
          DT.state.target = nextTarget;
          if (hitLanguage) {
            DT.state.langInfo = hitLanguage;
            DT.state.targetCode = hitLanguage.code || '';
            DT.state.renderedLangSig = [hitLanguage.kind, hitLanguage.code, hitLanguage.script].join('|');
          } else if (knownLanguages && knownLanguages.length) {
            DT.state.langInfo = null;
            DT.state.targetCode = '';
            DT.state.renderedLangSig = '';
          }
          startOver();
        }
        sendResponse(summarize());
      }).catch(function (err) {
        sendResponse({ error: String(err) });
      });
      return true;
    }

    if (msg.type === 'dt:diagnose') {
      var report;
      try {
        report = DT.diagnose(150);
        report.professional = {
          profile: professionalProfileFor(DT.state.config),
          options: professionalOptions(DT.state.config && DT.state.config.professionalOptions),
          qualityWarnings: DT.state.qualityWarnings || 0,
          lastQualityWarning: DT.state.lastQualityWarning || ''
        };
        // 只记录模式与计数，不记录上下文正文 / 标题 / 页面正文。
        report.experience = {
          target: DT.state.target,
          configTarget: DT.state.configTarget || DT.state.target,
          targetPending: DT.state.targetPending === true,
          style: DT.state.style || 'plain',
          selectedStyle: DT.state.selectedStyle || 'plain',
          intensity: DT.state.intensity || 'standard',
          context: DT.state.contextStatus || null,
          contextStale: DT.state.contextStale === true
        };
        // 只报类别和计数，不报正文 / 原始回包 / API Key。
        report.failures = {
          translated: DT.state.translated || 0,
          failed: DT.state.failed || 0,
          skipped: DT.state.skipped || 0,
          renderFailed: DT.state.renderFailed || 0,
          inlineOrderFailed: DT.state.inlineOrderFailed || 0,
          inlineReordered: reorderedCount(),
          inlinePlacementWarnings: DT.state.inlinePlacementWarnings || 0,
          safeDegraded: DT.state.safeDegraded || 0,
          outputFailed: DT.state.outputFailed || 0,
          lastError: DT.state.lastError || '',
          lastRenderError: DT.state.lastRenderError || '',
          lastOutputError: DT.state.lastOutputError || '',
          recentFailures: failureLog.slice(-10)
        };
      } catch (err) {
        report = { error: String(err) };
      }
      // 同时留在页面全局，方便在 Console 里 copy(JSON.stringify(__DT_LAST_DIAG))
      try {
        window.__DT_LAST_DIAG = report;
      } catch (err) {
        /* 忽略 */
      }
      sendResponse(report);
      return false;
    }

    // 明确的重翻动作：此时才把用户选中的风格 / 最新强度应用到本页。
    if (msg.type === 'dt:retranslate') {
      DT.state.enabled = true;
      applyConfigTarget();
      applySelectedStyle(DT.state.config);
      startOver();
      sendResponse(summarize());
      return false;
    }

    // 设置页保存 / 弹窗改配置后由后台广播：立刻生效（尤其是快捷键，不用刷新页面）。
    // 不再自己监听 storage.onChanged：那个事件带着完整配置（含 API Key）。
    // 失败退避一并清零 —— 多半是刚把 Key 改对了，接着把没翻成的补上。
    if (msg.type === 'dt:configChanged') {
      loadConfig().then(function () {
        resetFailures();
        // 换了服务商 / Key / 模型后，上一批“模型输出语言错误”不应永久挡住这段；
        // 只清输出失败记录，不清别的缓存，也不会自动发起请求。
        outputFails = new WeakMap();
        failureLog = [];
        DT.state.outputFailed = 0;
        DT.state.lastOutputError = '';
        scheduleIncremental();
      });
      return false;
    }

    return false;
  });

  // 看门狗：MV3 的 service worker 可能被回收，此时 sendMessage 的 Promise
  // 可能永远不 resolve，running 会卡死（面板一直显示"翻译中… 0 / ? 段"）。
  // 判据是"多久没有任何批次返回"：DT.send 自带 90s 超时，正常情况下每批最迟 90s 就有结果，
  // 这里多留 10s 余量。复位后不留下任何"中止"状态，翻译保持开启并自动重来。
  function startWatchdog() {
    setInterval(function () {
      if (!running || !lastBeat) return;
      // 高于内容脚本 190s / 后台单请求 180s 的上限，避免后台还在生成就被看门狗复位重发
      if (Date.now() - lastBeat < 200000) return;
      DT.log('watchdog: 翻译卡住，强制复位');
      cancelRun();
      DT.toast('翻译长时间没有响应，已复位并重新开始。');
      scheduleIncremental();
    }, 5000);
  }

  // 从 bfcache 返回（浏览器的前进/后退）：DOM 是旧的，状态可能已被冻结打断
  window.addEventListener('pageshow', function (event) {
    if (!event.persisted) return;
    cancelRun();
    if (DT.state.enabled) scheduleIncremental();
  });

  // ---------------- 启动 ----------------
  (async function boot() {
    await loadConfig();
    // iframe 只保留配置（划词 / 输入框 / 外观模块要用），不装观察器、快捷键、
    // 定时器和滚动监听：嵌入广告 / 评论区不需要这些，否则每个子框架都在空转。
    if (window.top !== window) {
      DT.log('content script ready (iframe)', DT.VERSION);
      return;
    }
    if (DT.shadow && DT.shadow.setChangeHandler) {
      DT.shadow.setChangeHandler(scheduleIncremental);
    }
    startObserver();
    bindHoverRescan();
    bindHotkey();
    bindInputHotkey();
    bindClickRescan();
    // 滚动 / 改窗口大小后，待翻队列按新的可视区重新排序。
    // 用捕获阶段：很多站点是页面里某个容器在滚，scroll 事件不冒泡
    document.addEventListener('scroll', onViewChange, { capture: true, passive: true });
    window.addEventListener('resize', onViewChange, { passive: true });
    watchUrl();
    startWatchdog();

    // 有些站点（Aeon 的 Next.js hydration）会把 data-dt 从 <html> 上删掉；
    // 监听属性变化并补回，另外在 load 后和两个延迟点再对一次，覆盖慢 hydration。
    try {
      chromeObserver = new MutationObserver(keepChromeState);
      chromeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['data-dt', 'data-dt-mode', 'data-dt-theme']
      });
    } catch (err) {
      /* 老浏览器不支持或没有 documentElement */
    }
    window.addEventListener('load', keepChromeState);
    setTimeout(keepChromeState, 1200);
    setTimeout(keepChromeState, 4000);

    // 自动开始翻译只在顶层页面（上面的 iframe 提前返回已经保证）
    // 同一个标签页里"刚才正在翻译"：刷新 / 返回后自动接着翻
    var resume = null;
    try {
      resume = await DT.send({ type: 'resume:get' }, 5000);
    } catch (err) {
      resume = null;
    }

    if (resume && resume.ok && resume.value) {
      DT.log('resume: 自动继续翻译');
      enable();
    } else if (DT.state.config && DT.state.config.translateOnLoad) {
      enable();
    }

    DT.log('content script ready', DT.VERSION);
  })();
})();
