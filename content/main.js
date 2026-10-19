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
  // 译文与原文相同 / 模型返回空的单元：记下当时的源文本，内容没变就不再重复送翻和计数
  var settled = new WeakMap();
  // 翻译失败的单元按段落各自退避：失败后等 5s / 15s / 45s 再试，第 4 次失败就放弃，
  // 直到内容变了、用户手动重翻或改了设置。
  // 以前失败段在每次点击、悬停、页面变动时都整页重发，遇到限流（429）只会越试越被限；
  // 也不能整页一起退避 —— 一批固定出错的段落会把新加载内容的翻译一起拖住。
  // 退避表本身在 core.js 的 DT.RETRY_DELAYS / DT.nextRetry（纯函数，自检可测）
  var failures = new WeakMap(); // el → { text, count, until }
  // 等译文期间原文又被站点改掉的次数（DT.sourceChanged）。连续 CHURN_MAX 次就不再翻这个元素：
  // 计时器、实时行情这类一直在变的内容，否则每变一次就重发一次请求
  var churn = new WeakMap();
  var CHURN_MAX = 3;
  var retryTimer = 0;
  var retryAt = 0;
  // 用户滚动 / 窗口大小变了：下一次取批前重新按离屏幕的距离排序
  var viewMoved = true;
  var lastScrollY = -1;
  var lastViewH = -1;
  var lazyTimer = 0;

  // 懒翻译的范围（屏幕上方 1 屏到下方 2 屏）在 core.js：DT.LAZY_ABOVE / DT.LAZY_BELOW
  function nearView(el, viewH) {
    return DT.nearView(el.getBoundingClientRect(), viewH);
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

  async function loadConfig() {
    try {
      var res = await DT.send({ type: 'config:get' });
      if (res && res.ok && res.config) {
        DT.state.config = res.config;
        DT.state.target = res.config.targetLang || 'zh-CN';
        DT.state.mode = res.config.mode || 'dual';
        DT.state.theme = res.config.theme || 'underline';
        // 站点规则可以固定这个网站的显示方式 / 译文样式
        var site = res.config.page && res.config.page.site;
        if (site && site.mode) DT.state.mode = site.mode;
        if (site && site.theme) DT.state.theme = site.theme;
      }
    } catch (err) {
      DT.log('loadConfig failed', err);
    }
    applyChrome();
    if (DT.state.config) DT.emitConfig(DT.state.config);
    return DT.state.config;
  }

  function summarize() {
    return {
      enabled: DT.state.enabled,
      mode: DT.state.mode,
      target: DT.state.target,
      style: DT.state.style || 'plain',
      total: DT.state.total,
      translated: DT.state.translated,
      failed: DT.state.failed,
      skipped: DT.state.skipped || 0,
      lastError: DT.state.lastError || '',
      busy: running
    };
  }

  // ---------------- 失败退避 ----------------
  // DT.state.failed = 当前处于失败状态的段落数（有退避记录的单元），不是累计失败次数
  function noteFailure(unit) {
    var prev = failures.get(unit.el);
    if (!prev) DT.state.failed += 1;
    var plan = DT.nextRetry(prev, unit.text, Date.now());
    failures.set(unit.el, { text: unit.text, count: plan.count, until: plan.until });
    return plan.delay;
  }

  function clearFailure(el) {
    if (!failures.has(el)) return;
    failures.delete(el);
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
    running = false;
    lastBeat = 0;
  }

  // opts: { reset: 是否清零统计, silent: 是否不弹提示 }
  async function translatePage(opts) {
    var options = opts || {};
    if (running || !DT.state.enabled) return;
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
      var target = DT.state.target;
      var maxUnit = Number(cfg.maxUnitChars) || 1200;
      // 日文页面翻成中文时，纯汉字短语（進捗状況 / 無料）会被 looksLikeTarget 当成"已是中文"跳过；
      // 页面自己声明了日语就关掉这条判定，宁可多翻几句
      var docLang = String((document.documentElement && document.documentElement.lang) || '').toLowerCase();
      var jaPageToZh = docLang.indexOf('ja') === 0 && String(target || '').indexOf('zh') === 0;

      // 仅译文 / 控件替换过的元素，如果站点又改了它的文字，先放回待翻译
      DT.releaseReplaced();

      if (options.reset) {
        DT.state.translated = 0;
        resetFailures();
      }

      // 过滤放进 collect 里做：不送翻的单元不占单轮上限
      var now = Date.now();
      var lazy = cfg.lazy !== false;
      var viewH = window.innerHeight || 800;
      var deferred = 0; // 离屏幕太远、留到滚过去再翻的单元数
      var pageStyle = DT.state.style || 'plain';
      var queue = DT.collectAll(function (unit) {
        if (DT.skipText(unit.text)) return false;
        // 趣味翻译：正文里够长的段落按风格改写；中文页面也要改写，所以风格单元不跳过「已是目标语言」
        unit.style = pageStyle === 'plain' ? 'plain' : DT.unitStyle(pageStyle, unit.text, DT.areaOf(unit.el));
        if (unit.style === 'plain' && cfg.skipSameLang !== false && !jaPageToZh && DT.looksLikeTarget(unit.text, target)) return false;
        if (settled.get(unit.el) === unit.text) return false;
        if ((churn.get(unit.el) || 0) >= CHURN_MAX) return false;
        // 懒翻译：只翻屏幕附近的，远处的等滚到附近再翻（滚动会触发补扫，见 onViewChange）。
        // 放在退避判断前面：远处的失败段不安排重试，滚回来时再说
        if (lazy && !nearView(unit.el, viewH)) {
          deferred += 1;
          return false;
        }
        var fail = failures.get(unit.el);
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
      queue.forEach(function (unit, ui) {
        var parts = DT.splitLong(unit.text, maxUnit);
        unit.slots = new Array(parts.length);
        unit.seps = parts.seps; // 段与段之间原来的分隔：在换行处切开的，拼回去仍是换行
        unit.done = false;
        parts.forEach(function (part, k) {
          pending.push({ ui: ui, k: k, text: part, style: unit.style || 'plain' });
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
        viewMoved = false;
        lastScrollY = window.scrollY;
        lastViewH = window.innerHeight;
        var seen = {};
        pending.forEach(function (seg) {
          if (seen[seg.ui]) return;
          seen[seg.ui] = true;
          queue[seg.ui].prio = DT.distanceOf(queue[seg.ui].el.getBoundingClientRect(), viewHeight());
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
          if (batch.length && (batch.length >= limitItems || chars + seg.text.length > limitChars)) break;
          if (batch.length && seg.style !== batch[0].style) break; // 同一批不混风格：后台按批选提示词
          batch.push(pending.shift());
          chars += seg.text.length;
        }
        return batch;
      }

      DT.log('segments', pending.length);

      function tryInject(unit) {
        if (!unit || unit.done) return;
        if (cancelled()) return;
        for (var k = 0; k < unit.slots.length; k += 1) {
          if (unit.slots[k] === undefined) return; // 还有段没回来（或失败了，等下次补扫重试）
        }
        var text = DT.joinSlots(unit.slots, DT.translationSeps(unit.seps, target));
        unit.done = true;
        // 等译文期间站点改了这段原文（SPA 重渲染、翻页复用同一个元素）：
        // 旧译文不能写进新内容，也不记成「已处理」；本轮结束后按新内容重新收集
        if (DT.sourceChanged(unit)) {
          churn.set(unit.el, (churn.get(unit.el) || 0) + 1);
          dirty = true;
          return;
        }
        churn.delete(unit.el);
        if (!text) {
          DT.state.skipped = (DT.state.skipped || 0) + 1;
          settled.set(unit.el, unit.text);
          return;
        }

        // 译文与原文相同或近似重复就不插入：
        // 完全一致的（用户名、数字、专有名词）会叠成一条"删除线"，看着像渲染 bug；
        // 原文本来就是目标语言、模型只改写了几个词（feat: → 新功能:）会多出一行几乎一样的字。
        // 趣味翻译的单元只拦完全一致：风格改写（句末加个「喵」）本来就和原文很像
        var dup =
          unit.style && unit.style !== 'plain'
            ? DT.normalizeText(text) === DT.normalizeText(unit.text)
            : DT.isNearDuplicate(unit.text, text, target);
        if (dup) {
          DT.state.skipped = (DT.state.skipped || 0) + 1;
          settled.set(unit.el, unit.text);
          return;
        }

        if (DT.inject(unit.el, text, target)) {
          DT.state.translated += 1;
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
          // 与后台 provider 的 180s 总上限对齐：内容脚本先超时会让同一批重复计费
          res = await DT.send({ type: 'translate', texts: texts, target: target, style: batch[0].style || 'plain' }, 190000);
        } catch (err) {
          if (cancelled()) return;
          lastBeat = Date.now();
          DT.log('send failed', err);
          markFailed(batch);
          DT.state.lastError = err && err.message ? err.message : String(err);
          return;
        }
        if (cancelled()) return; // 期间用户点了"还原"，或这一轮已被复位
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
        batch.forEach(function (seg, k) {
          var value = res.results[k];
          if (typeof value === 'string') {
            // '' = 模型返回空（原文本身是 "EN"/"×" 这种）：tryInject 里记为"同原文跳过"，不算失败
            queue[seg.ui].slots[seg.k] = value.trim();
          } else {
            // null = 这一段请求失败（Key 无效、限流、余额不足…）。
            // 以前这里也记成"跳过"，结果全部失败时弹的是"已翻译 N 段"。
            // 槽位留空：本轮不注入，本轮结束后按退避表安排重试。
            queue[seg.ui].failed = true;
          }
        });
        batch.forEach(function (seg) {
          tryInject(queue[seg.ui]);
        });
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
      queue.forEach(tryInject);

      // 记账：失败的进退避，成功（含"与原文相同"）的清掉旧的失败记录
      if (!cancelled()) {
        queue.forEach(function (unit) {
          if (unit.failed) {
            wantRetry(noteFailure(unit));
            progressed = true;
          } else if (unit.done) {
            clearFailure(unit.el);
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

  // ---------------- 开关 ----------------
  async function enable() {
    var cfg = await loadConfig();
    // 内容脚本拿不到 Key 本身（后台只给 hasKey），见 background.js 的 config:get
    if (!cfg || !cfg.hasKey) {
      DT.toast('还没配置 API Key：点扩展图标 → 设置');
      return summarize();
    }
    DT.state.enabled = true;
    DT.send({ type: 'resume:set', value: true }).catch(function () {});
    detectForeignTranslator();
    DT.state.total = 0;
    DT.state.translated = 0;
    resetFailures();
    DT.state.skipped = 0;
    DT.state.lastError = '';
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
    DT.state.style = 'plain'; // 趣味翻译是一次性的：还原后回到普通翻译
    DT.send({ type: 'resume:set', value: false }).catch(function () {});
    DT.restore();
    settled = new WeakMap();
    churn = new WeakMap();
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

  // ---------------- 动态内容 ----------------
  function scheduleIncremental() {
    if (!DT.state.enabled) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      if (!DT.state.enabled) return;
      if (running) {
        dirty = true;
        return;
      }
      translatePage({ silent: true });
    }, 600);
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
    return (
      node.nodeType === 1 &&
      (node.hasAttribute('data-dt-target') || node.hasAttribute('data-dt-ui'))
    );
  }

  function hasForeignNodes(nodes) {
    for (var k = 0; k < nodes.length; k += 1) {
      if (!isOwnNode(nodes[k])) return true;
    }
    return false;
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        var record = records[i];
        var target = record.target;
        // 忽略我们自己造成的变更：每插一批译文都会触发一次，
        // 不过滤的话每轮翻译结束后都要白跑一遍整页扫描
        if (target && target.nodeType === 1 && target.closest && target.closest('[data-dt-ui]')) continue;
        if (record.type === 'childList' && record.addedNodes && record.addedNodes.length) {
          cleanupDuplicateTargets(record.addedNodes);
          if (!hasForeignNodes(record.addedNodes)) continue;
          scheduleIncremental();
          return;
        }
        if (record.type === 'characterData') {
          if (DT.isOwnWrite(target)) continue; // 仅译文模式原地替换文本
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
  function startOver() {
    cancelRun();
    if (DT.hover) DT.hover.clear();
    DT.restore();
    settled = new WeakMap();
    churn = new WeakMap();
    resetFailures();
    DT.state.total = 0;
    DT.state.translated = 0;
    DT.state.skipped = 0;
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

    // 趣味翻译：当前页按风格重翻（不写进配置）；还没开翻译就顺带打开
    if (msg.type === 'dt:setStyle') {
      DT.state.style = DT.STYLE_IDS.indexOf(msg.style) >= 0 ? msg.style : 'plain';
      if (DT.state.enabled) {
        startOver();
        sendResponse(summarize());
        return false;
      }
      enable().then(sendResponse, function (err) {
        sendResponse({ error: String(err) });
      });
      return true;
    }

    if (msg.type === 'dt:setTarget') {
      DT.state.target = msg.target || DT.state.target;
      startOver();
      sendResponse(summarize());
      return false;
    }

    if (msg.type === 'dt:diagnose') {
      var report;
      try {
        report = DT.diagnose(150);
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

    if (msg.type === 'dt:retranslate') {
      DT.state.enabled = true;
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
    startObserver();
    bindHoverRescan();
    bindHotkey();
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